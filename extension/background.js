// background.js — service worker. Multi-provider LLM dispatcher with optional image input.

importScripts('lib/parsers.js');
// Toolbar tooltip shows the version, e.g. "Vidigest YouTube Summarizer 1.4.0".
chrome.action.setTitle({ title: `Vidigest YouTube Summarizer ${chrome.runtime.getManifest().version}` });

const { sseEvents, ndjson, splitTranscript, formatTimestamp } = YTS;

const DEFAULT_PROMPT = `You are summarizing a YouTube video transcript. Produce a concise, high-signal summary.

Output format (markdown):

## TL;DR
2-3 sentences capturing the essence.

## Key Points
- 5-8 bullets with the most important ideas, claims, or moments
- Include specific numbers, names, and examples when present
- Lead with the insight, not the buildup
- End every key point with the timestamp where it happens in the video, taken from the transcript's line markers, in the form [m:ss] or [h:mm:ss] (e.g. [12:40]). One timestamp per point.

## Takeaways
Brief paragraph on what to remember or act on.

Rules:
- Prefer substance. Don't say "the speaker discusses X" — state what was said.
- If it's a how-to, extract the actual steps.
- If it's an opinion piece, extract the argument structure.
- If images are provided, they are chapter thumbnails or a main thumbnail; reference them only when they add signal. Use the image's timestamp label verbatim if you cite it.
- Match depth to content. Don't pad.
- Write the entire summary, including the section headings, in the same language as the transcript (e.g. a Spanish video gets a Spanish summary).`;

const PROVIDERS = {
  anthropic: {
    label: 'Anthropic (Claude)',
    needsApiKey: true,
    needsBaseUrl: false,
    // Anthropic's guidance (Nov 2026): "start with Claude Opus 5.5 for most workloads".
    defaultModel: 'claude-opus-5-5',
    modelOptions: [
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
      'claude-fable-5-2',
    ],
    supportsVision: true,
    call: callAnthropic,
  },
  openai: {
    label: 'OpenAI (GPT)',
    needsApiKey: true,
    needsBaseUrl: false,
    // OpenAI's guidance (Nov 2026): "If you're not sure where to start, use GPT-6.2 Astra."
    defaultModel: 'gpt-6.2-astra',
    modelOptions: ['gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-5.4-mini'],
    supportsVision: true,
    call: callOpenAI,
  },
  gemini: {
    label: 'Google Gemini',
    needsApiKey: true,
    needsBaseUrl: false,
    // Google's guidance (Nov 2026): for new projects use 3.8 Flash or 3.5 Flash-Lite; 4 Argon is the flagship.
    defaultModel: 'gemini-3.8-flash',
    modelOptions: [
      'gemini-3.8-flash',
      'gemini-4-argon',
      'gemini-3.6-flash',
      'gemini-3.5-flash-lite',
    ],
    supportsVision: true,
    call: callGemini,
  },
  ollama: {
    label: 'Ollama (local)',
    needsApiKey: false,
    needsBaseUrl: true,
    defaultBaseUrl: 'http://localhost:11434',
    // Current, widely used general models that also accept images.
    defaultModel: 'gemma4',
    modelOptions: ['gemma4', 'qwen3.6', 'qwen3-vl', 'gpt-oss:20b', 'llama3.2'],
    supportsVision: true, // model-dependent; user's responsibility
    call: callOllama,
  },
};

// Messaging — only 'getProviders' is handled here. Summarization goes through
// the long-lived `onConnect` port below so we can stream deltas back to the UI.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'getProviders') return false;
  const meta = {};
  for (const [key, p] of Object.entries(PROVIDERS)) {
    meta[key] = {
      label: p.label,
      needsApiKey: p.needsApiKey,
      needsBaseUrl: p.needsBaseUrl,
      defaultModel: p.defaultModel,
      defaultBaseUrl: p.defaultBaseUrl || '',
      modelOptions: p.modelOptions,
      supportsVision: p.supportsVision,
    };
  }
  sendResponse({ providers: meta });
  return false;
});

// Streaming: content script opens a long-lived port and posts a 'start' message.
// Messages sent back:
//   plan       { parts: [{ startSec, endSec }] }      — how the transcript was split
//   part-start { index }                              — part `index` (0-based) begins
//   chunk      { index, text }                        — streamed text for that part
//   status     { index, text }                        — e.g. rate-limit countdown
//   part-done  { index, summary, usage }
//   done       { usage, model, provider, parts }
//   error      { index, message }
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'summarize') return;
  let active = true;
  port.onDisconnect.addListener(() => { active = false; });
  const emit = (m) => { if (active) port.postMessage(m); };

  port.onMessage.addListener(async (msg) => {
    if (msg?.type !== 'start') return;
    let currentIndex = 0;
    try {
      const result = await summarizeInParts(msg, {
        emit,
        isActive: () => active,
        onIndex: (i) => { currentIndex = i; },
      });
      emit({ type: 'done', ...result });
    } catch (e) {
      emit({ type: 'error', index: currentIndex, message: e?.message || String(e) });
    }
    if (active) port.disconnect();
  });
});

// ---------- Config storage with migration from v1.0.x shape ----------

// Models the providers have shut down; a saved setting naming one falls back to the default.
const RETIRED_MODELS = new Set([
  'gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-pro', 'gemini-1.5-flash',
  'gemini-3-pro-preview', 'o3-mini',
]);

function withoutRetiredModels(providers) {
  const out = {};
  for (const [k, v] of Object.entries(providers || {})) {
    out[k] = v && RETIRED_MODELS.has(v.model) ? { ...v, model: PROVIDERS[k]?.defaultModel } : v;
  }
  return out;
}

async function getConfig() {
  const all = await chrome.storage.sync.get();
  if (all.apiKey && !all.activeProvider) {
    // Migrate old flat keys into new nested shape
    const migrated = {
      activeProvider: 'anthropic',
      providers: {
        anthropic: {
          apiKey: all.apiKey,
          model: all.model || PROVIDERS.anthropic.defaultModel,
        },
      },
      customPrompt: all.customPrompt || '',
      includeImages: false,
    };
    await chrome.storage.sync.set(migrated);
    await chrome.storage.sync.remove(['apiKey', 'model']);
    return migrated;
  }
  return {
    activeProvider: all.activeProvider || 'anthropic',
    providers: withoutRetiredModels(all.providers),
    customPrompt: all.customPrompt || '',
    includeImages: !!all.includeImages,
    maxChunkChars: clampChunk(all.maxChunkChars),
  };
}

const DEFAULT_CHUNK_CHARS = 80_000; // ≈ 20–27k tokens; keeps each request well under typical per-minute limits
const MIN_CHUNK_CHARS = 5_000;
const MAX_PARTS = 20; // safety cap on cost for extremely long transcripts

function clampChunk(v) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CHUNK_CHARS;
  return Math.max(MIN_CHUNK_CHARS, n);
}

// ---------- Dispatcher ----------
//
// Long transcripts are split into parts of at most `maxChunkChars`. Parts are summarized
// one after another; each request is told it is "part i of N" and receives the summaries
// of the earlier parts, so the final part can write whole-video conclusions (Takeaways).

const PRIOR_SUMMARIES_MAX_CHARS = 24_000;
const OUTPUT_TOKEN_CAP = 16_000;

function rangeLabel(part) {
  if (part.startSec == null) return '';
  const end = part.endSec != null ? formatTimestamp(part.endSec) : 'end';
  return `${formatTimestamp(part.startSec)}–${end}`;
}

function multiPartInstructions({ index, total, range, isDefault }) {
  const n = index + 1;
  const last = n === total;
  const where = range ? `, covering ${range} of the video` : '';
  const head =
    `\n\nMULTI-PART MODE\n` +
    `The transcript is too long for a single request, so it was split into ${total} consecutive parts. ` +
    `This request is part ${n} of ${total}${where}. Your answer is shown to the reader as page ${n} of ${total}.\n` +
    `- The user message may include summaries of the earlier parts, for context only. Don't repeat points they already cover.\n` +
    `- Transcript lines start with [m:ss] / [h:mm:ss] markers: absolute positions in the video. Use them as-is when citing a moment.\n`;

  if (isDefault) {
    return (
      head +
      `- Write "## TL;DR" and "## Key Points" for THIS PART ONLY, and append " (${n}/${total})" to the TL;DR heading.\n` +
      (last
        ? `- This is the FINAL part: after the Key Points, write "## Takeaways" for the WHOLE video, drawing on the earlier parts' summaries and this part.\n`
        : `- Do NOT write a "## Takeaways" section in this part; it is written once, in the final part (${total}/${total}).\n`)
    );
  }
  return (
    head +
    `- Apply the instructions above to THIS PART ONLY, and say at the top that this is part ${n}/${total}.\n` +
    (last
      ? `- This is the FINAL part: also write anything the instructions ask for that concerns the whole video (overall takeaways, conclusions, verdicts, recommendations), drawing on the earlier parts' summaries and this part.\n`
      : `- Leave out anything the instructions ask for that concerns the whole video (overall takeaways, conclusions, verdicts, recommendations); it will be written in the final part (${total}/${total}).\n`)
  );
}

function priorSummariesSection(prior) {
  if (!prior.length) return '';
  const per = Math.floor(PRIOR_SUMMARIES_MAX_CHARS / prior.length);
  const blocks = prior.map((p) => {
    const body = p.summary.length > per ? p.summary.slice(0, per) + ' …' : p.summary;
    return `### Part ${p.n}/${p.total}${p.range ? ` (${p.range})` : ''}\n${body.trim()}`;
  });
  return `\n\nSummaries of the earlier parts (context only — do not repeat):\n${blocks.join('\n\n')}\n`;
}

function imagesForPart(images, part, index) {
  if (!images.length) return [];
  if (part.startSec == null) return index === 0 ? images : [];
  return images.filter((img) => {
    const t = typeof img.startSeconds === 'number' ? img.startSeconds : 0;
    return t >= part.startSec && (part.endSec == null || t < part.endSec || (index === 0 && t === 0));
  });
}

function imageLabels(images) {
  if (!images.length) return '';
  const labels = images
    .map((img, i) => {
      const ts = typeof img.startSeconds === 'number' ? ` @ ${formatTimestamp(img.startSeconds)}` : '';
      return `${i + 1}. ${img.label || 'thumbnail'}${ts}`;
    })
    .join('\n');
  return `\n\nImages attached (in order):\n${labels}\n`;
}

async function summarizeInParts(
  { transcript, title, channel, images = [], durationSec = null },
  { emit = () => {}, isActive = () => true, onIndex = () => {} } = {}
) {
  const cfg = await getConfig();
  const provider = PROVIDERS[cfg.activeProvider];
  if (!provider) throw new Error(`Unknown provider: ${cfg.activeProvider}`);
  const providerCfg = cfg.providers?.[cfg.activeProvider] || {};

  const custom = cfg.customPrompt && cfg.customPrompt.trim();
  const basePrompt = custom || DEFAULT_PROMPT;
  const isDefault = !custom;

  let parts = splitTranscript(transcript, cfg.maxChunkChars, durationSec);
  let capped = false;
  if (parts.length > MAX_PARTS) {
    parts = parts.slice(0, MAX_PARTS);
    capped = true;
  }
  const total = parts.length;
  const allImages = cfg.includeImages ? images : [];

  emit({
    type: 'plan',
    parts: parts.map((p) => ({ startSec: p.startSec, endSec: p.endSec })),
    capped,
  });

  const prior = [];
  const totalUsage = { input_tokens: 0, output_tokens: 0 };
  let model = '';
  let providerName = cfg.activeProvider;
  const summaries = [];

  for (let index = 0; index < total; index++) {
    if (!isActive()) throw new Error('cancelled');
    onIndex(index);
    const part = parts[index];
    const range = rangeLabel(part);
    const multi = total > 1;

    const system = multi
      ? basePrompt + multiPartInstructions({ index, total, range, isDefault })
      : basePrompt;

    const partImages = imagesForPart(allImages, part, index);
    const header = multi
      ? `Transcript — part ${index + 1} of ${total}${range ? ` (${range})` : ''}. Each line starts with its [m:ss] position in the video:`
      : `Transcript. Each line starts with its [m:ss] position in the video:`;
    const truncNote =
      capped && index === total - 1
        ? `\n\n[Note: the transcript was cut after ${total} parts; later content is not included.]`
        : '';
    const userText =
      `Video title: "${title}"\nChannel: ${channel || 'unknown'}` +
      imageLabels(partImages) +
      priorSummariesSection(prior) +
      `\n${header}\n${part.text}${truncNote}`;

    emit({ type: 'part-start', index });
    const result = await callWithRetry(provider, providerCfg, {
      system,
      userText,
      images: partImages,
      // Current models think/reason before answering and those tokens count toward this cap,
      // so it must leave room for both. Only tokens actually generated are billed.
      maxTokens: OUTPUT_TOKEN_CAP,
      onDelta: (text) => emit({ type: 'chunk', index, text }),
    }, {
      onStatus: (text) => emit({ type: 'status', index, text }),
      isActive,
    });

    summaries.push(result.summary);
    prior.push({ n: index + 1, total, range, summary: result.summary || '' });
    if (result.usage) {
      totalUsage.input_tokens += result.usage.input_tokens || 0;
      totalUsage.output_tokens += result.usage.output_tokens || 0;
    }
    model = result.model || model;
    providerName = result.provider || providerName;
    emit({ type: 'part-done', index, summary: result.summary, usage: result.usage });
  }

  return { usage: totalUsage, model, provider: providerName, parts: summaries };
}

// Retries rate-limit / overload errors (HTTP 429, 529, 503) that happen before any text
// streamed. Waits for the provider's retry-after when given. Posts a countdown so the
// user sees what's happening — the messages also keep the MV3 service worker alive.
async function callWithRetry(provider, providerCfg, args, { onStatus = () => {}, isActive = () => true } = {}) {
  const MAX_RETRIES = 4;
  for (let attempt = 0; ; attempt++) {
    let streamed = false;
    try {
      return await provider.call(providerCfg, {
        ...args,
        onDelta: (d) => { streamed = true; args.onDelta?.(d); },
      });
    } catch (e) {
      const retryable = [429, 503, 529].includes(e?.status);
      if (!retryable || streamed || attempt >= MAX_RETRIES || !isActive()) throw e;
      let wait = Number.isFinite(e.retryAfter) && e.retryAfter > 0 ? e.retryAfter : 10 * 2 ** attempt;
      wait = Math.min(Math.ceil(wait), 120);
      const why = e.status === 429 ? 'Rate limit reached' : 'Provider overloaded';
      for (let left = wait; left > 0; left -= 5) {
        if (!isActive()) throw e;
        onStatus(`${why} — retrying in ${left}s (attempt ${attempt + 2}/${MAX_RETRIES + 1})…`);
        await new Promise((r) => setTimeout(r, Math.min(5, left) * 1000));
      }
      onStatus('');
    }
  }
}

// ---------- Provider implementations (streaming) ----------
//
// All providers always request streaming responses from the API; `onDelta` is optional
// and only controls whether we forward tokens to the UI as they arrive. The returned
// object always contains the fully-accumulated summary so non-streaming callers still work.

// Per-stream idle timeout: if no chunk has arrived in this many ms, abort the fetch.
// Resets on every chunk/event; prevents hung streams from wedging the UI indefinitely.
const STREAM_IDLE_TIMEOUT_MS = 60_000;

function idleAbort(timeoutMs) {
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(new DOMException('Idle timeout', 'AbortError')), timeoutMs);
  return {
    signal: controller.signal,
    reset() {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new DOMException('Idle timeout', 'AbortError')), timeoutMs);
    },
    cleanup() { clearTimeout(timer); },
  };
}

// Wraps a provider's streaming body in a uniform idle-timeout + error-translation layer.
async function withStreamTimeout(label, runStream) {
  const timer = idleAbort(STREAM_IDLE_TIMEOUT_MS);
  try {
    return await runStream(timer);
  } catch (e) {
    if (e?.name === 'AbortError') {
      throw new Error(`${label} stream stalled — no data for ${STREAM_IDLE_TIMEOUT_MS / 1000}s. Try again.`);
    }
    throw e;
  } finally {
    timer.cleanup();
  }
}

async function callAnthropic(cfg, { system, userText, images, onDelta, maxTokens = OUTPUT_TOKEN_CAP }) {
  if (!cfg.apiKey) throw new Error('Anthropic API key not set.');
  const model = cfg.model || PROVIDERS.anthropic.defaultModel;

  const content = [
    ...images.map((img) => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mimeType || 'image/jpeg', data: img.base64 },
    })),
    { type: 'text', text: userText },
  ];

  return withStreamTimeout('Anthropic', async (t) => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: t.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content }],
        stream: true,
      }),
    });
    if (!res.ok) throw await apiError(res, 'Anthropic');

    let summary = '';
    let usage = { input_tokens: 0, output_tokens: 0 };
    let finalModel = model;
    for await (const ev of sseEvents(res)) {
      t.reset();
      if (ev.type === 'message_start') {
        finalModel = ev.message?.model || finalModel;
        if (ev.message?.usage) usage.input_tokens = ev.message.usage.input_tokens || 0;
      } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        const d = ev.delta.text || '';
        summary += d;
        if (onDelta && d) onDelta(d);
      } else if (ev.type === 'message_delta') {
        if (ev.usage?.output_tokens != null) usage.output_tokens = ev.usage.output_tokens;
      }
    }
    return { summary, usage, model: finalModel, provider: 'anthropic' };
  });
}

async function callOpenAI(cfg, { system, userText, images, onDelta, maxTokens = OUTPUT_TOKEN_CAP }) {
  if (!cfg.apiKey) throw new Error('OpenAI API key not set.');
  const model = cfg.model || PROVIDERS.openai.defaultModel;

  const userContent = images.length
    ? [
        { type: 'text', text: userText },
        ...images.map((img) => ({
          type: 'image_url',
          image_url: { url: `data:${img.mimeType || 'image/jpeg'};base64,${img.base64}` },
        })),
      ]
    : userText;

  return withStreamTimeout('OpenAI', async (t) => {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: t.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userContent },
        ],
        max_completion_tokens: maxTokens, // `max_tokens` is rejected by reasoning models (GPT-5+/6)
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
    if (!res.ok) throw await apiError(res, 'OpenAI');

    let summary = '';
    let usage = null;
    let finalModel = model;
    for await (const ev of sseEvents(res)) {
      t.reset();
      finalModel = ev.model || finalModel;
      const delta = ev.choices?.[0]?.delta?.content;
      if (delta) {
        summary += delta;
        if (onDelta) onDelta(delta);
      }
      if (ev.usage) {
        usage = {
          input_tokens: ev.usage.prompt_tokens,
          output_tokens: ev.usage.completion_tokens,
        };
      }
    }
    return { summary, usage, model: finalModel, provider: 'openai' };
  });
}

async function callGemini(cfg, { system, userText, images, onDelta, maxTokens = OUTPUT_TOKEN_CAP }) {
  if (!cfg.apiKey) throw new Error('Gemini API key not set.');
  const model = cfg.model || PROVIDERS.gemini.defaultModel;

  const parts = [
    { text: userText },
    ...images.map((img) => ({
      inline_data: { mime_type: img.mimeType || 'image/jpeg', data: img.base64 },
    })),
  ];

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:streamGenerateContent?alt=sse`;

  return withStreamTimeout('Gemini', async (t) => {
    const res = await fetch(url, {
      method: 'POST',
      signal: t.signal,
      // Key goes in a header, not the URL, so it never lands in logs/history/proxies.
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts }],
        generationConfig: { maxOutputTokens: maxTokens },
      }),
    });
    if (!res.ok) throw await apiError(res, 'Gemini');

    let summary = '';
    let usage = null;
    for await (const ev of sseEvents(res)) {
      t.reset();
      const partsOut = ev.candidates?.[0]?.content?.parts || [];
      for (const p of partsOut) {
        const d = p.text || '';
        if (d) {
          summary += d;
          if (onDelta) onDelta(d);
        }
      }
      if (ev.usageMetadata) {
        usage = {
          input_tokens: ev.usageMetadata.promptTokenCount,
          output_tokens: ev.usageMetadata.candidatesTokenCount,
        };
      }
    }
    return { summary, usage, model, provider: 'gemini' };
  });
}

async function callOllama(cfg, { system, userText, images, onDelta }) {
  const baseUrl = (cfg.baseUrl || PROVIDERS.ollama.defaultBaseUrl).replace(/\/$/, '');
  const model = cfg.model || PROVIDERS.ollama.defaultModel;

  const userMessage = { role: 'user', content: userText };
  if (images.length) userMessage.images = images.map((i) => i.base64);

  return withStreamTimeout('Ollama', async (t) => {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      signal: t.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: system }, userMessage],
        stream: true,
      }),
    }).catch((e) => {
      if (e?.name === 'AbortError') throw e;
      throw new Error(
        `Ollama fetch failed: ${e.message}. Is Ollama running? Set OLLAMA_ORIGINS=chrome-extension://${chrome.runtime.id} and restart ollama serve.`
      );
    });
    if (!res.ok) throw await apiError(res, 'Ollama');

    let summary = '';
    let usage = null;
    let finalModel = model;
    for await (const chunk of ndjson(res)) {
      t.reset();
      finalModel = chunk.model || finalModel;
      const d = chunk.message?.content || '';
      if (d) {
        summary += d;
        if (onDelta) onDelta(d);
      }
      if (chunk.done) {
        if (chunk.prompt_eval_count || chunk.eval_count) {
          usage = {
            input_tokens: chunk.prompt_eval_count || 0,
            output_tokens: chunk.eval_count || 0,
          };
        }
      }
    }
    return { summary, usage, model: finalModel, provider: 'ollama' };
  });
}

async function apiError(res, label) {
  let msg = `${label} HTTP ${res.status}`;
  const retryAfter = parseFloat(res.headers?.get?.('retry-after'));
  try {
    const body = await res.json();
    const detail = body?.error?.message || body?.error || body?.message;
    if (detail) msg += ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  } catch {
    try {
      const t = await res.text();
      if (t) msg += ` — ${t.slice(0, 200)}`;
    } catch {}
  }
  const err = new Error(msg);
  err.status = res.status;
  if (Number.isFinite(retryAfter)) err.retryAfter = retryAfter;
  return err;
}
