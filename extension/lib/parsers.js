// extension/lib/parsers.js — pure parsing / rendering helpers.
//
// Loaded by:
//   • the service worker (background.js) via importScripts()
//   • the content script (content.js) as the first entry in content_scripts.js
//   • unit tests (tests/parsers.test.js) as a CommonJS module
//
// Exposes `YTS` on the extension's globalThis; exports the same shape via module.exports for Node.
// Nothing in this file may reference chrome.*, document, window, or other host-specific globals.

(function () {
  // ---------- SSE ----------

  // Parses Server-Sent Events from a fetch response body. Yields the parsed JSON payload
  // for each `data:` event. Handles events that span multiple chunks, terminates on [DONE].
  async function* sseEvents(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        const event = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const dataLines = event
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart());
        if (!dataLines.length) continue;
        const payload = dataLines.join('\n');
        if (payload === '[DONE]') return;
        try { yield JSON.parse(payload); } catch { /* ignore malformed */ }
      }
    }
  }

  // Parses newline-delimited JSON (Ollama's streaming format).
  async function* ndjson(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try { yield JSON.parse(line); } catch { /* ignore */ }
      }
    }
    if (buf.trim()) {
      try { yield JSON.parse(buf); } catch {}
    }
  }

  // ---------- JSON extraction ----------

  // Walks characters tracking brace depth and string escapes to extract one complete
  // JSON object starting at `start`. Returns the slice as a string, or null on failure.
  function sliceBalancedJson(s, start) {
    let depth = 0;
    let inStr = false;
    let escape = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (escape) escape = false;
        else if (c === '\\') escape = true;
        else if (c === '"') inStr = false;
      } else {
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}') {
          depth--;
          if (depth === 0) return s.slice(start, i + 1);
        }
      }
    }
    return null;
  }

  // ---------- Markdown rendering ----------

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));
  }

  // Tiny markdown renderer — escapes first, then applies transforms. Safe against XSS from
  // model output. Supports headings, bullet lists, paragraphs, **bold**, *italic*, `code`,
  // and [mm:ss] / [h:mm:ss] timestamps (rewritten to yts-ts anchors).
  function renderMarkdown(md) {
    const lines = escapeHtml(md).split('\n');
    let html = '';
    let paragraph = [];
    // Open lists, outermost first: { indent, tag: 'ul' | 'ol' }. Supports nested
    // (indented) bullets and numbered lists.
    const stack = [];
    const flushPara = () => {
      if (paragraph.length) {
        html += `<p>${paragraph.join(' ')}</p>`;
        paragraph = [];
      }
    };
    const closeTop = () => {
      const top = stack.pop();
      html += `</li></${top.tag}>`;
    };
    const closeAll = () => { while (stack.length) closeTop(); };

    for (const raw of lines) {
      const line = raw.replace(/\t/g, '    ');
      const item = line.match(/^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/);
      const heading = line.match(/^(#{1,3})\s+(.*)$/);

      if (item) {
        flushPara();
        const indent = item[1].length;
        const tag = /\d/.test(item[2]) ? 'ol' : 'ul';
        while (stack.length && indent < stack[stack.length - 1].indent) closeTop();
        const top = stack[stack.length - 1];
        if (top && indent === top.indent) {
          if (top.tag === tag) {
            html += '</li>';
          } else {
            closeTop();
            html += `<${tag}>`;
            stack.push({ indent, tag });
          }
        } else {
          // First list, or deeper than the current item → nested list inside it.
          html += `<${tag}>`;
          stack.push({ indent, tag });
        }
        html += `<li>${item[3]}`;
      } else if (heading) {
        flushPara();
        closeAll();
        const level = heading[1].length + 1; // # -> h2, ## -> h3, ### -> h4
        html += `<h${level}>${heading[2]}</h${level}>`;
      } else if (!line.trim()) {
        flushPara(); // blank lines between bullets don't end the list
      } else if (stack.length && /^\s/.test(line)) {
        html += ' ' + line.trim(); // indented continuation of the current bullet
      } else {
        closeAll();
        paragraph.push(line);
      }
    }
    flushPara();
    closeAll();

    return html
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]/g, (_, a, b, c) => {
        const seconds = c
          ? Number(a) * 3600 + Number(b) * 60 + Number(c)
          : Number(a) * 60 + Number(b);
        const label = c ? `${a}:${b}:${c}` : `${a}:${b}`;
        return `<a class="yts-ts" data-seconds="${seconds}" href="#" title="Jump to ${label}">[${label}]</a>`;
      });
  }

  // ---------- YouTube innertube helpers ----------

  function findTranscriptParams(data) {
    const panels = data?.engagementPanels || [];
    for (const panel of panels) {
      const r = panel.engagementPanelSectionListRenderer;
      if (!r) continue;
      const pid = r.panelIdentifier || r.targetId || '';
      if (!String(pid).includes('transcript')) continue;

      const params =
        r.content?.continuationItemRenderer?.continuationEndpoint?.getTranscriptEndpoint?.params ||
        r.content?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
      if (params) return params;
    }
    return null;
  }

  // Recursively collect transcript text from innertube response.
  // Handles both transcriptSegmentRenderer (new) and transcriptCueRenderer (older) shapes.
  function extractTranscriptTexts(data) {
    const texts = [];
    const walk = (obj) => {
      if (!obj || typeof obj !== 'object') return;

      if (obj.transcriptSegmentRenderer) {
        const snippet = obj.transcriptSegmentRenderer.snippet;
        const text =
          snippet?.simpleText ||
          (Array.isArray(snippet?.runs) ? snippet.runs.map((r) => r.text || '').join('') : '');
        if (text) texts.push(text);
        return;
      }
      if (obj.transcriptCueRenderer) {
        const cue = obj.transcriptCueRenderer.cue;
        const text =
          cue?.simpleText ||
          (Array.isArray(cue?.runs) ? cue.runs.map((r) => r.text || '').join('') : '');
        if (text) texts.push(text);
        return;
      }

      for (const val of Object.values(obj)) {
        if (Array.isArray(val)) val.forEach(walk);
        else if (val && typeof val === 'object') walk(val);
      }
    };
    walk(data);
    return texts;
  }

  // Like extractTranscriptTexts, but keeps each segment's start time: [{ ms, text }].
  function extractTranscriptSegments(data) {
    const out = [];
    const runsText = (x) =>
      x?.simpleText || (Array.isArray(x?.runs) ? x.runs.map((r) => r.text || '').join('') : '');
    const walk = (obj) => {
      if (!obj || typeof obj !== 'object') return;
      if (obj.transcriptSegmentRenderer) {
        const r = obj.transcriptSegmentRenderer;
        const text = runsText(r.snippet);
        if (text) out.push({ ms: Number(r.startMs), text });
        return;
      }
      if (obj.transcriptCueRenderer) {
        const r = obj.transcriptCueRenderer;
        const text = runsText(r.cue);
        if (text) out.push({ ms: Number(r.startOffsetMs), text });
        return;
      }
      for (const val of Object.values(obj)) {
        if (Array.isArray(val)) val.forEach(walk);
        else if (val && typeof val === 'object') walk(val);
      }
    };
    walk(data);
    return out;
  }

  // ---------- Timestamps & transcript parts ----------

  // 75 -> "1:15", 3725 -> "1:02:05". Matches the [m:ss] / [h:mm:ss] forms renderMarkdown links.
  function formatTimestamp(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = String(sec % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  // "1:15" / "1:02:05" -> seconds, or null.
  function parseTimestamp(str) {
    const m = String(str || '').trim().match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
    if (!m) return null;
    return m[3] != null
      ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
      : Number(m[1]) * 60 + Number(m[2]);
  }

  // Groups caption segments [{ ms, text }] into lines "[m:ss] text…", starting a new line
  // every ~lineSec seconds (or lineChars characters) so the model can cite positions.
  function segmentsToTimedText(segments, { lineSec = 20, lineChars = 400 } = {}) {
    const lines = [];
    let cur = null;
    const flush = () => {
      if (!cur || !cur.text) return;
      lines.push(cur.sec != null ? `[${formatTimestamp(cur.sec)}] ${cur.text}` : cur.text);
    };
    for (const seg of segments || []) {
      const text = String(seg?.text ?? '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const sec = Number.isFinite(Number(seg?.ms)) && seg?.ms !== null && seg?.ms !== '' ? Number(seg.ms) / 1000 : null;
      const newLine =
        !cur ||
        cur.text.length >= lineChars ||
        (sec != null && cur.sec != null && sec - cur.sec >= lineSec);
      if (newLine) {
        flush();
        cur = { sec, text };
      } else {
        cur.text += ' ' + text;
        if (cur.sec == null && sec != null) cur.sec = sec;
      }
    }
    flush();
    return lines.join('\n');
  }

  const LEADING_TS = /^\[(\d+:\d{2}(?::\d{2})?)\]/;

  // Splits a timed transcript into balanced parts of at most maxChars, on line boundaries.
  // Returns [{ text, startSec, endSec }]; endSec is the next part's start (or durationSec).
  function splitTranscript(text, maxChars, durationSec = null) {
    text = String(text || '');
    maxChars = Math.max(1000, Math.floor(Number(maxChars) || 0));

    // Break any over-long line (e.g. a transcript with no timestamps) at spaces.
    const lines = [];
    for (const line of text.split('\n')) {
      if (line.length <= maxChars) { lines.push(line); continue; }
      let rest = line;
      while (rest.length > maxChars) {
        let cut = rest.lastIndexOf(' ', maxChars);
        if (cut < maxChars * 0.5) cut = maxChars;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut).trimStart();
      }
      if (rest) lines.push(rest);
    }

    const total = text.length;
    // Reserve room for one line when planning, so a part that runs slightly past the
    // balanced target still fits under maxChars and no tiny extra part is left over.
    const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
    const slack = Math.min(longest, Math.floor(maxChars / 2));
    const count = total <= maxChars ? 1 : Math.max(1, Math.ceil(total / (maxChars - slack)));
    const target = Math.ceil(total / count);

    const groups = [];
    let cur = [];
    let len = 0;
    for (const line of lines) {
      const add = line.length + (cur.length ? 1 : 0);
      if (cur.length && (len + add > maxChars || (len >= target && groups.length < count - 1))) {
        groups.push(cur);
        cur = [];
        len = 0;
      }
      cur.push(line);
      len += line.length + (cur.length > 1 ? 1 : 0);
    }
    if (cur.length) groups.push(cur);

    const firstTs = (g) => {
      for (const l of g) {
        const m = l.match(LEADING_TS);
        if (m) return parseTimestamp(m[1]);
      }
      return null;
    };
    const lastTs = (g) => {
      for (let i = g.length - 1; i >= 0; i--) {
        const m = g[i].match(LEADING_TS);
        if (m) return parseTimestamp(m[1]);
      }
      return null;
    };

    return groups.map((g, i) => {
      const startSec = i === 0 ? (firstTs(g) != null ? 0 : null) : firstTs(g);
      const next = groups[i + 1] ? firstTs(groups[i + 1]) : null;
      const endSec =
        next != null ? next : i === groups.length - 1 && durationSec ? Math.floor(durationSec) : lastTs(g);
      return { text: g.join('\n'), startSec, endSec };
    });
  }

  const api = {
    sseEvents, ndjson,
    sliceBalancedJson,
    escapeHtml, renderMarkdown,
    findTranscriptParams, extractTranscriptTexts, extractTranscriptSegments,
    formatTimestamp, parseTimestamp, segmentsToTimedText, splitTranscript,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    (typeof globalThis !== 'undefined' ? globalThis : self).YTS = api;
  }
})();
