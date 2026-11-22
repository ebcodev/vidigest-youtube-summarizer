// content.js — injects Summarize button + side panel on YouTube watch pages.
// Requires lib/parsers.js to be loaded before this (see manifest.json content_scripts.js).

(() => {
  const {
    sliceBalancedJson,
    escapeHtml,
    renderMarkdown,
    findTranscriptParams,
    extractTranscriptSegments,
    segmentsToTimedText,
    parseTimestamp,
  } = (typeof globalThis !== 'undefined' ? globalThis : self).YTS;

  const PANEL_ID = 'yt-summarizer-panel';
  const BUTTON_ID = 'yt-summarizer-button';

  let currentVideoId = null;
  let isSummarizing = false;

  // ---------- YouTube helpers ----------

  function getVideoId() {
    try {
      const u = new URL(location.href);
      if (u.pathname !== '/watch') return null;
      return u.searchParams.get('v');
    } catch {
      return null;
    }
  }

  function getVideoTitle() {
    const selectors = [
      'ytd-watch-metadata #title h1 yt-formatted-string',
      'ytd-watch-metadata h1.ytd-watch-metadata',
      '#title h1 yt-formatted-string',
      'h1.ytd-watch-metadata',
    ];
    for (const s of selectors) {
      const el = document.querySelector(s);
      const t = el?.textContent?.trim();
      if (t) return t;
    }
    return document.title.replace(/\s*-\s*YouTube\s*$/, '').trim();
  }

  function getChannelName() {
    const selectors = [
      'ytd-watch-metadata #channel-name yt-formatted-string a',
      'ytd-watch-metadata ytd-channel-name a',
      '#channel-name a',
    ];
    for (const s of selectors) {
      const el = document.querySelector(s);
      const t = el?.textContent?.trim();
      if (t) return t;
    }
    return '';
  }

  // 24-hour transcript cache in chrome.storage.local. Keyed on videoId.
  const TRANSCRIPT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  const TRANSCRIPT_CACHE_MAX_ENTRIES = 50;
  const CACHE_PREFIX = 'tr2:'; // tr2 = transcript with [m:ss] line timestamps

  async function getCachedTranscript(videoId) {
    try {
      const key = `${CACHE_PREFIX}${videoId}`;
      const res = await chrome.storage.local.get(key);
      const hit = res[key];
      // Validate shape — earlier versions or storage corruption could produce malformed entries.
      if (!hit || typeof hit.ts !== 'number' || typeof hit.text !== 'string') {
        if (hit) chrome.storage.local.remove(key);
        return null;
      }
      if (Date.now() - hit.ts > TRANSCRIPT_CACHE_TTL_MS) {
        chrome.storage.local.remove(key);
        return null;
      }
      return hit.text;
    } catch { return null; }
  }

  // Only scan-and-evict every Nth write to amortize cost on the hot path.
  let transcriptCacheWriteCount = 0;

  async function setCachedTranscript(videoId, text) {
    try {
      const key = `${CACHE_PREFIX}${videoId}`;
      await chrome.storage.local.set({ [key]: { text, ts: Date.now() } });
      transcriptCacheWriteCount++;

      // Evict on every write: the write counter resets on each page load, so the old
      // "every 10th write" rule meant expired entries were almost never cleaned up.
      const all = await chrome.storage.local.get(null);
      const now = Date.now();
      const expired = [];
      const trs = Object.entries(all).filter(([k, v]) => {
        if (k.startsWith('tr:')) { expired.push(k); return false; } // pre-1.3 untimed format
        if (!k.startsWith(CACHE_PREFIX)) return false;
        if (!v || typeof v.ts !== 'number' || now - v.ts > TRANSCRIPT_CACHE_TTL_MS) {
          expired.push(k);
          return false;
        }
        return true;
      });
      if (expired.length) chrome.storage.local.remove(expired);
      if (trs.length > TRANSCRIPT_CACHE_MAX_ENTRIES) {
        trs.sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
        const toRemove = trs.slice(0, trs.length - TRANSCRIPT_CACHE_MAX_ENTRIES).map(([k]) => k);
        chrome.storage.local.remove(toRemove);
      }
    } catch (e) { log('cache write failed:', e.message); }
  }

  // ---------- Page bridge (page-bridge.js, MAIN world) ----------

  let bridgeSeq = 0;
  function askPage(type, payload, timeoutMs = 15000) {
    const id = `yts-${Date.now()}-${++bridgeSeq}`;
    return new Promise((resolve, reject) => {
      const onMsg = (ev) => {
        if (ev.source !== window) return;
        const d = ev.data;
        if (!d || d.source !== 'yts-page' || d.id !== id) return;
        cleanup();
        if (d.ok) resolve(d);
        else reject(new Error(d.error || 'page bridge error'));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('page bridge did not respond (reload the tab after updating the extension)'));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        window.removeEventListener('message', onMsg);
      };
      window.addEventListener('message', onMsg);
      window.postMessage({ source: 'yts-cs', id, type, ...payload }, '*');
    });
  }

  async function getTranscript(videoId) {
    const cached = await getCachedTranscript(videoId);
    if (cached) {
      log('transcript cache hit, chars:', cached.length);
      return cached;
    }

    const reasons = [];

    // Method 0: let YouTube's player fetch the captions (it attaches the required PoToken),
    // then re-read that exact signed URL as json3. Most reliable method as of 2025-2026.
    try {
      const { segments } = await askPage('player-transcript', { videoId }, 15000);
      if (!Array.isArray(segments)) throw new Error('bad response from page bridge');
      const text = segmentsToTimedText(segments);
      if (!text) throw new Error('empty text');
      log('player/pot method succeeded, chars:', text.length);
      setCachedTranscript(videoId, text);
      return text;
    } catch (e) {
      log('player/pot method failed:', e.message, '— trying DOM scrape');
      reasons.push(`player captions: ${e.message}`);
    }

    // Method 1: DOM scrape — click YouTube's own "Show transcript" button and read segments.
    // Most reliable because it uses YouTube's own auth/rendering.
    try {
      const t = await getTranscriptViaDom();
      log('DOM scrape succeeded, chars:', t.length);
      setCachedTranscript(videoId, t);
      return t;
    } catch (e) {
      log('DOM scrape failed:', e.message, '— trying innertube API');
      reasons.push(`DOM scrape: ${e.message}`);
    }

    let html;
    try {
      const res = await fetch(`/watch?v=${encodeURIComponent(videoId)}`, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      html = await res.text();
    } catch (e) {
      reasons.push(`load watch page: ${e.message}`);
      throw buildTranscriptError(reasons);
    }

    // Method 2: innertube /youtubei/v1/get_transcript.
    try {
      const t = await getTranscriptInnertube(html, videoId);
      log('innertube succeeded, chars:', t.length);
      setCachedTranscript(videoId, t);
      return t;
    } catch (e) {
      log('innertube failed:', e.message, '— trying legacy caption URL');
      reasons.push(`innertube: ${e.message}`);
    }

    // Method 3: legacy baseUrl fetch (often empty now, but kept as last resort).
    const playerResponse = extractPlayerResponse(html);
    if (!playerResponse) {
      reasons.push('legacy: could not parse player response from page HTML');
      throw buildTranscriptError(reasons);
    }

    const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks?.length) {
      reasons.push('legacy: no captionTracks on this video — it probably has no captions');
      throw buildTranscriptError(reasons, false);
    }

    const track =
      tracks.find((t) => t.languageCode === 'en' && t.kind !== 'asr') ||
      tracks.find((t) => t.languageCode === 'en') ||
      tracks.find((t) => t.languageCode?.startsWith('en')) ||
      tracks[0];

    log('Selected caption track:', { lang: track.languageCode, kind: track.kind || 'manual' });

    try {
      const text = await fetchTranscriptJson3(track.baseUrl);
      setCachedTranscript(videoId, text);
      return text;
    } catch (e) {
      log('json3 failed:', e.message, '— falling back to XML');
      reasons.push(`legacy json3: ${e.message}`);
    }

    try {
      const text = await fetchTranscriptXml(track.baseUrl);
      setCachedTranscript(videoId, text);
      return text;
    } catch (e) {
      reasons.push(`legacy xml: ${e.message}`);
    }

    throw buildTranscriptError(reasons, true);
  }

  function buildTranscriptError(reasons, hasCaptionTracks = null) {
    const hint =
      hasCaptionTracks === false
        ? 'This video has no captions, or is age/region restricted.'
        : hasCaptionTracks === true
          ? 'This video HAS captions, but YouTube blocked every extraction method. ' +
            'Try reloading the tab; if it persists, YouTube changed something again.'
          : 'This video may not have captions, or may be age/region restricted.';
    return new Error(
      'No transcript could be extracted. Tried:\n  • ' + reasons.join('\n  • ') + '\n' + hint
    );
  }

  // ---------- DOM scrape (preferred) ----------

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function findShowTranscriptButton() {
    // 1. Embedded transcript section within description (most common, currently)
    const inDesc = document.querySelector(
      'ytd-video-description-transcript-section-renderer ytd-button-renderer button, ' +
      'ytd-video-description-transcript-section-renderer button'
    );
    if (inDesc) return inDesc;

    // 2. Generic text match — any button literally labeled "Show transcript"
    const buttons = document.querySelectorAll('button, tp-yt-paper-button');
    for (const b of buttons) {
      const text = (b.textContent || '').trim().toLowerCase();
      const label = (b.getAttribute('aria-label') || '').toLowerCase();
      if (text === 'show transcript' || label === 'show transcript') return b;
    }
    return null;
  }

  const SEGMENT_SELECTORS = [
    'ytd-transcript-segment-renderer',
    'transcript-segment-view-model',
    '[target-id*="transcript"] [class*="segment-text"]',
    '[target-id*="transcript"] [class*="transcript-segment"]',
  ];

  function scrapeTranscriptSegments() {
    for (const sel of SEGMENT_SELECTORS) {
      const nodes = document.querySelectorAll(sel);
      if (nodes.length) return nodes;
    }
    return document.querySelectorAll('ytd-transcript-segment-renderer');
  }

  function segmentsToText(nodes) {
    const segs = Array.from(nodes).map((n) => {
      const tsEl =
        n.querySelector('.segment-timestamp') || n.querySelector('[class*="timestamp"]');
      const sec = parseTimestamp(tsEl?.textContent);
      const el =
        n.querySelector('.segment-text') ||
        n.querySelector('[class*="segment-text"]') ||
        n.querySelector('span.yt-core-attributed-string') ||
        n.querySelector('yt-formatted-string.segment-text') ||
        n.querySelector('yt-formatted-string');
      const text = (el?.textContent ?? n.textContent ?? '').trim();
      return { ms: sec != null ? sec * 1000 : null, text };
    });
    return segmentsToTimedText(segs);
  }

  async function waitForSegments(timeoutMs = 8000) {
    const existing = scrapeTranscriptSegments();
    if (existing.length > 2) return existing; // already rendered, return immediately

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (val, err) => {
        if (settled) return;
        settled = true;
        obs.disconnect();
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(val);
      };
      const obs = new MutationObserver(() => {
        const nodes = scrapeTranscriptSegments();
        if (nodes.length > 2) finish(nodes);
      });
      obs.observe(document.body, { childList: true, subtree: true });
      const timer = setTimeout(
        () => finish(null, new Error('Timed out waiting for transcript panel to render')),
        timeoutMs
      );
    });
  }

  function tryClosePanel() {
    const closeBtn = document.querySelector(
      'ytd-engagement-panel-title-header-renderer button[aria-label*="Close" i], ' +
      '[target-id*="transcript"] button[aria-label*="Close" i]'
    );
    if (closeBtn) closeBtn.click();
  }

  async function getTranscriptViaDom() {
    // Already rendered? (User may have transcript open already.)
    const already = scrapeTranscriptSegments();
    if (already.length > 2) return segmentsToText(already);

    let btn = findShowTranscriptButton();

    // Expand description if button not yet in DOM
    if (!btn) {
      const expandBtn =
        document.querySelector('tp-yt-paper-button#expand') ||
        document.querySelector('#description #expand') ||
        document.querySelector('ytd-text-inline-expander #expand');
      if (expandBtn) {
        expandBtn.click();
        await sleep(250);
        btn = findShowTranscriptButton();
      }
    }

    if (!btn) throw new Error('"Show transcript" button not found on page');

    btn.click();
    const nodes = await waitForSegments(8000);
    const text = segmentsToText(nodes);

    // Hide the panel again so the user isn't left with it open
    tryClosePanel();

    if (!text) throw new Error('Transcript panel opened but no text extracted');
    return text;
  }

  // ---------- Innertube transcript (secondary) ----------

  async function getTranscriptInnertube(html, videoId) {
    // Prefer sending the request from the page with YouTube's real INNERTUBE_CONTEXT;
    // a hand-built context is a common cause of 400 FAILED_PRECONDITION.
    const initialForParams = extractInitialData(html);
    let pageParams = null;
    try { pageParams = initialForParams ? findTranscriptParams(JSON.parse(initialForParams)) : null; } catch {}
    if (pageParams) {
      try {
        const { data } = await askPage('innertube-transcript', { params: pageParams }, 15000);
        const segs = extractTranscriptSegments(data);
        if (segs.length) return segmentsToTimedText(segs);
        log('page-context innertube returned no segments, retrying with hand-built context');
      } catch (e) {
        log('page-context innertube failed:', e.message, '— retrying with hand-built context');
      }
    }

    const apiKey = matchOne(html, /"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
    const clientVersion =
      matchOne(html, /"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/) || '2.20250101.00.00';
    const visitorData = matchOne(html, /"VISITOR_DATA"\s*:\s*"([^"]+)"/);
    if (!apiKey) throw new Error('no INNERTUBE_API_KEY in page');

    const initialDataJson = extractInitialData(html);
    if (!initialDataJson) throw new Error('no ytInitialData in page');
    let initialData;
    try {
      initialData = JSON.parse(initialDataJson);
    } catch {
      throw new Error('failed to parse ytInitialData');
    }

    const params = findTranscriptParams(initialData);
    if (!params) throw new Error('no transcript params — captions probably unavailable');

    const headers = {
      'Content-Type': 'application/json',
      'X-Youtube-Client-Name': '1',
      'X-Youtube-Client-Version': clientVersion,
    };
    if (visitorData) headers['X-Goog-Visitor-Id'] = visitorData;

    const body = {
      context: {
        client: {
          clientName: 'WEB',
          clientVersion,
          hl: 'en',
          gl: 'US',
          originalUrl: `https://www.youtube.com/watch?v=${videoId}`,
          ...(visitorData ? { visitorData } : {}),
        },
        user: { lockedSafetyMode: false },
        request: { useSsl: true },
      },
      params,
    };

    const res = await fetch(`/youtubei/v1/get_transcript?key=${apiKey}&prettyPrint=false`, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 300);
      } catch {}
      throw new Error(`innertube HTTP ${res.status}${detail ? ' — ' + detail : ''}`);
    }
    const data = await res.json();

    const segs = extractTranscriptSegments(data);
    if (!segs.length) throw new Error('innertube returned no segments');
    return segmentsToTimedText(segs);
  }

  function matchOne(str, re) {
    const m = str.match(re);
    return m ? m[1] : null;
  }

  function extractInitialData(html) {
    const markers = ['var ytInitialData = ', 'ytInitialData = '];
    for (const marker of markers) {
      const idx = html.indexOf(marker);
      if (idx === -1) continue;
      const start = html.indexOf('{', idx);
      if (start === -1) continue;
      const json = sliceBalancedJson(html, start);
      if (json) return json;
    }
    return null;
  }

  // Robust extractor that handles nested braces / multiple patterns.
  function extractPlayerResponse(html) {
    const markers = [
      'ytInitialPlayerResponse = ',
      'var ytInitialPlayerResponse = ',
      '"ytInitialPlayerResponse":',
    ];
    for (const marker of markers) {
      const idx = html.indexOf(marker);
      if (idx === -1) continue;
      const start = html.indexOf('{', idx);
      if (start === -1) continue;
      const jsonStr = sliceBalancedJson(html, start);
      if (!jsonStr) continue;
      try {
        return JSON.parse(jsonStr);
      } catch (e) {
        log('player response JSON parse failed, trying next pattern:', e.message);
      }
    }
    return null;
  }

  function withFmt(baseUrl, fmt) {
    // baseUrl is absolute — use a base for safety
    const url = new URL(baseUrl, 'https://www.youtube.com');
    if (fmt) url.searchParams.set('fmt', fmt);
    else url.searchParams.delete('fmt');
    return url.toString();
  }

  async function fetchTranscriptJson3(baseUrl) {
    const url = withFmt(baseUrl, 'json3');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (!text.trim()) throw new Error('empty response (YouTube requires a PoToken on direct caption URLs)');
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error('non-JSON response');
    }
    const transcript = segmentsToTimedText(
      (json.events || [])
        .filter((e) => e.segs)
        .map((e) => ({ ms: e.tStartMs, text: e.segs.map((s) => s.utf8 || '').join('') }))
    );
    if (!transcript) throw new Error('empty transcript');
    return transcript;
  }

  async function fetchTranscriptXml(baseUrl) {
    // Default format is XML; strip fmt if present
    const url = withFmt(baseUrl, null);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`XML transcript fetch failed (${res.status})`);
    const text = await res.text();
    if (!text.trim()) throw new Error('Empty transcript response');

    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'text/xml');
    const parseErr = doc.querySelector('parsererror');
    if (parseErr) throw new Error('Invalid XML transcript');

    const nodes = doc.querySelectorAll('text');
    if (!nodes.length) throw new Error('No text nodes in XML transcript');

    // Decode HTML entities via a textarea (handles &#39;, &amp;, etc.)
    const decoder = document.createElement('textarea');
    const transcript = segmentsToTimedText(
      Array.from(nodes).map((n) => {
        decoder.innerHTML = n.textContent || '';
        const start = parseFloat(n.getAttribute('start'));
        return { ms: Number.isFinite(start) ? start * 1000 : null, text: decoder.value };
      })
    );
    if (!transcript) throw new Error('Empty transcript after XML parse');
    return transcript;
  }

  // ---------- Rendering ----------
  // escapeHtml and renderMarkdown come from YTS (lib/parsers.js).

  function seekVideo(seconds) {
    const video =
      document.querySelector('#movie_player video') || document.querySelector('video');
    if (!video) return;
    const target = Math.max(0, Math.min(video.duration || seconds, seconds));
    video.currentTime = target;
    if (video.paused) video.play().catch(() => {});
  }

  // ---------- Panel UI ----------
  // One page per transcript part. Pages fill in as the background worker streams them;
  // the pager lets the user move between finished parts while later ones are generated.

  const view = {
    pages: [], // { startSec, endSec, status: 'pending'|'streaming'|'done'|'error', markdown, note, error, truncated }
    current: 0,
    follow: true, // auto-advance to the part being generated until the user navigates away
    phase: 'idle', // 'transcript' | 'summarizing' | 'done' | 'error'
    error: '',
    meta: null,
    capped: false,
    videoId: null, // which video these pages belong to
  };
  let activePort = null;

  // ---------- Saved summaries (chrome.storage.local, key sum:<videoId>) ----------
  // A finished summary is saved so the Summarize button and the toolbar popup reopen it
  // instead of calling the AI again. ↻ Regenerate always makes a fresh one.
  const SUMMARY_PREFIX = 'sum:';
  const SUMMARY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const SUMMARY_MAX_ENTRIES = 100;

  async function loadStoredSummary(videoId) {
    try {
      const key = SUMMARY_PREFIX + videoId;
      const hit = (await chrome.storage.local.get(key))[key];
      if (!hit || !Array.isArray(hit.pages) || !hit.pages.length || typeof hit.ts !== 'number') return null;
      if (Date.now() - hit.ts > SUMMARY_TTL_MS) {
        chrome.storage.local.remove(key);
        return null;
      }
      return hit;
    } catch {
      return null;
    }
  }

  async function saveStoredSummary(videoId) {
    try {
      const entry = {
        ts: Date.now(),
        pages: view.pages.map((p) => ({ startSec: p.startSec, endSec: p.endSec, markdown: p.markdown || '' })),
        meta: view.meta,
        capped: view.capped,
      };
      await chrome.storage.local.set({ [SUMMARY_PREFIX + videoId]: entry });
      const all = await chrome.storage.local.get(null);
      const now = Date.now();
      const old = [];
      const live = Object.entries(all).filter(([k, v]) => {
        if (!k.startsWith(SUMMARY_PREFIX)) return false;
        if (!v || typeof v.ts !== 'number' || now - v.ts > SUMMARY_TTL_MS) { old.push(k); return false; }
        return true;
      });
      if (live.length > SUMMARY_MAX_ENTRIES) {
        live.sort((a, b) => a[1].ts - b[1].ts);
        old.push(...live.slice(0, live.length - SUMMARY_MAX_ENTRIES).map(([k]) => k));
      }
      if (old.length) chrome.storage.local.remove(old);
    } catch (e) {
      log('summary save failed:', e.message);
    }
  }

  function showStoredSummary(videoId, stored) {
    resetView();
    view.videoId = videoId;
    view.pages = stored.pages.map((p) => ({ ...p, status: 'done', note: '' }));
    view.meta = stored.meta || null;
    view.capped = !!stored.capped;
    view.phase = 'done';
    view.savedAt = stored.ts;
    renderPanel(true);
    openPanel();
  }

  function openPanel() {
    ensurePanel().classList.add('yts-open');
  }

  function hasSummaryInView(videoId) {
    return view.videoId === videoId && (view.phase === 'done' || isSummarizing) && view.phase !== 'idle';
  }

  // Summarize button / popup: reopen what exists, otherwise generate.
  async function openOrSummarize({ generateIfMissing = true } = {}) {
    const videoId = getVideoId();
    if (!videoId) return false;
    if (hasSummaryInView(videoId)) {
      openPanel();
      return true;
    }
    const stored = await loadStoredSummary(videoId);
    if (stored) {
      showStoredSummary(videoId, stored);
      return true;
    }
    if (generateIfMissing && !isSummarizing) {
      runSummarize();
      return true;
    }
    return false;
  }

  // Messages from the toolbar popup.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'yts-status') {
      const videoId = getVideoId();
      if (!videoId) { sendResponse({ videoId: null }); return false; }
      if (hasSummaryInView(videoId)) {
        sendResponse({ videoId, hasSummary: true, inProgress: isSummarizing });
        return false;
      }
      loadStoredSummary(videoId).then((s) =>
        sendResponse({ videoId, hasSummary: !!s, inProgress: false })
      );
      return true; // async response
    }
    if (msg?.type === 'yts-open') {
      openOrSummarize({ generateIfMissing: !!msg.generate }).then((ok) => sendResponse({ ok }));
      return true;
    }
    return false;
  });

  function resetView() {
    view.pages = [];
    view.current = 0;
    view.follow = true;
    view.phase = 'idle';
    view.error = '';
    view.meta = null;
    view.capped = false;
    view.videoId = null;
    view.savedAt = null;
  }

  function fmtTs(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = String(sec % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  function pageRange(p) {
    if (!p || p.startSec == null) return '';
    return `${fmtTs(p.startSec)}–${p.endSec != null ? fmtTs(p.endSec) : 'end'}`;
  }

  function allMarkdown() {
    const pages = view.pages.filter((p) => p.markdown);
    if (pages.length <= 1) return pages[0]?.markdown || '';
    return pages.map((p) => p.markdown.trim()).join('\n\n---\n\n');
  }

  function streamingIndex() {
    return view.pages.findIndex((p) => p.status === 'streaming');
  }

  function goToPage(i) {
    if (i < 0 || i >= view.pages.length || i === view.current) return;
    view.current = i;
    const s = streamingIndex();
    view.follow = s === -1 || s === i; // keep following only if the user is on the live page
    renderPanel(true);
  }

  function ensurePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (panel) return panel;

    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="yts-header">
        <div class="yts-title">Summary</div>
        <div class="yts-actions">
          <button class="yts-btn-icon" data-action="copy" title="Copy markdown (all parts)">⎘</button>
          <button class="yts-btn-icon" data-action="regenerate" title="Regenerate (calls the AI again)">↻</button>
          <button class="yts-btn-icon" data-action="minimize" title="Minimize — reopen from the Summarize button or the extension icon">–</button>
          <button class="yts-btn-icon" data-action="close" title="Close (stops a summary that is still being generated)">✕</button>
        </div>
      </div>
      <div class="yts-pager" hidden>
        <button class="yts-btn-icon" data-action="prev" title="Previous part">‹</button>
        <div class="yts-pager-mid">
          <div class="yts-pager-label"></div>
          <div class="yts-dots"></div>
        </div>
        <button class="yts-btn-icon" data-action="next" title="Next part">›</button>
      </div>
      <div class="yts-body"></div>
      <div class="yts-footer"></div>
    `;
    document.body.appendChild(panel);

    panel.addEventListener('click', (e) => {
      const ts = e.target?.closest?.('.yts-ts');
      if (ts) {
        e.preventDefault();
        const s = Number(ts.dataset.seconds);
        if (!Number.isNaN(s)) seekVideo(s);
        return;
      }

      const btn = e.target?.closest?.('[data-action]');
      const action = btn?.dataset?.action;
      if (!action) return;
      if (action === 'minimize') panel.classList.remove('yts-open');
      if (action === 'close') {
        panel.classList.remove('yts-open');
        if (isSummarizing) {
          // Stop generating; unfinished parts are discarded and nothing is saved.
          cancelSummary();
          resetView();
        }
      }
      if (action === 'regenerate' && !isSummarizing) runSummarize();
      if (action === 'prev') goToPage(view.current - 1);
      if (action === 'next') goToPage(view.current + 1);
      if (action === 'goto') goToPage(Number(btn.dataset.page));
      if (action === 'copy') {
        const md = allMarkdown();
        if (!md) return;
        navigator.clipboard.writeText(md).then(() => {
          const prev = btn.textContent;
          btn.textContent = '✓';
          setTimeout(() => (btn.textContent = prev), 1200);
        });
      }
    });

    return panel;
  }

  function loadingHtml(text) {
    return `<div class="yts-loading"><div class="yts-spinner"></div><div>${escapeHtml(text)}</div></div>`;
  }

  function errorHtml(text) {
    return `<div class="yts-error"><strong>Error</strong><div>${escapeHtml(text)}</div></div>`;
  }

  function renderPanel(resetScroll = false) {
    // Rendering never opens the panel by itself, so a minimized panel stays minimized while
    // parts stream in. Opening happens only on explicit actions (openPanel).
    const panel = ensurePanel();
    const pager = panel.querySelector('.yts-pager');
    const body = panel.querySelector('.yts-body');
    const footer = panel.querySelector('.yts-footer');
    const total = view.pages.length;
    const page = view.pages[view.current];

    // Pager
    if (total > 1) {
      pager.hidden = false;
      const range = pageRange(page);
      pager.querySelector('.yts-pager-label').textContent =
        `Part ${view.current + 1} of ${total}${range ? ' · ' + range : ''}`;
      pager.querySelector('[data-action="prev"]').disabled = view.current === 0;
      pager.querySelector('[data-action="next"]').disabled = view.current === total - 1;
      pager.querySelector('.yts-dots').innerHTML = view.pages
        .map(
          (p, i) =>
            `<button class="yts-dot yts-dot-${p.status}${i === view.current ? ' yts-dot-current' : ''}" ` +
            `data-action="goto" data-page="${i}" title="Part ${i + 1}${pageRange(p) ? ' · ' + pageRange(p) : ''}"></button>`
        )
        .join('');
    } else {
      pager.hidden = true;
    }

    // Body — renderMarkdown escapes HTML before applying markdown transforms, so it is XSS-safe.
    let html;
    if (view.phase === 'transcript') {
      html = loadingHtml('Fetching transcript…');
    } else if (!page) {
      html = view.phase === 'error' ? errorHtml(view.error) : loadingHtml('Summarizing…');
    } else if (page.status === 'pending') {
      html = loadingHtml(`Part ${view.current + 1} is queued — it starts after the previous part.`);
    } else if (page.status === 'streaming' && !page.markdown) {
      html = loadingHtml(page.note || (total > 1 ? `Summarizing part ${view.current + 1} of ${total}…` : 'Summarizing…'));
    } else {
      html = `<div class="yts-summary">${renderMarkdown(page.markdown || '')}${
        page.status === 'streaming' ? '<span class="yts-cursor"></span>' : ''
      }</div>`;
      if (page.status === 'error') html += errorHtml(page.error || 'This part failed.');
    }
    body.innerHTML = html;
    if (resetScroll) body.scrollTop = 0;

    // Footer
    const parts = [];
    const m = view.meta;
    if (m?.provider) parts.push(`${m.provider}/${m.model || ''}`);
    else if (m?.model) parts.push(m.model);
    if (m?.usage) parts.push(`${m.usage.input_tokens || 0} in / ${m.usage.output_tokens || 0} out`);
    const s = streamingIndex();
    if (view.phase === 'summarizing' && total > 1 && s !== -1) parts.push(`generating part ${s + 1}/${total}`);
    if (view.savedAt) parts.push(`saved ${new Date(view.savedAt).toLocaleString()} · ↻ to regenerate`);
    if (view.capped) parts.push('⚠ very long video: only the first parts were summarized');
    if (page?.truncated) parts.push('⚠ stream ended early — click ↻ to regenerate');
    footer.textContent = parts.join(' · ');
  }

  async function runSummarize() {
    const videoId = getVideoId();
    if (!videoId) return;

    try { activePort?.disconnect(); } catch {}
    activePort = null;
    isSummarizing = true;
    resetView();
    view.videoId = videoId;
    view.phase = 'transcript';
    renderPanel(true);
    openPanel();

    let transcript, title, channel, images;
    try {
      transcript = await getTranscript(videoId);
      title = getVideoTitle();
      channel = getChannelName();
      images = await getImages(videoId);
      if (images.length) log(`collected ${images.length} image(s)`);
    } catch (e) {
      view.phase = 'error';
      view.error = e?.message || String(e);
      renderPanel();
      isSummarizing = false;
      return;
    }
    if (getVideoId() !== videoId) { isSummarizing = false; return; } // user navigated away

    const video = document.querySelector('#movie_player video') || document.querySelector('video');
    const durationSec = Number.isFinite(video?.duration) ? video.duration : null;

    view.phase = 'summarizing';
    renderPanel();

    const port = chrome.runtime.connect({ name: 'summarize' });
    activePort = port;
    let finished = false;

    port.onMessage.addListener((msg) => {
      if (port !== activePort) return;
      const page = view.pages[msg.index];
      switch (msg.type) {
        case 'plan':
          view.pages = (msg.parts || []).map((p) => ({
            startSec: p.startSec, endSec: p.endSec, status: 'pending', markdown: '', note: '',
          }));
          view.capped = !!msg.capped;
          break;
        case 'part-start':
          if (page) page.status = 'streaming';
          if (view.follow && msg.index !== view.current) {
            view.current = msg.index;
            renderPanel(true);
            return;
          }
          break;
        case 'chunk':
          if (page) { page.markdown += msg.text; page.note = ''; }
          if (msg.index !== view.current) return; // nothing visible changed
          break;
        case 'status':
          if (page) page.note = msg.text;
          break;
        case 'part-done':
          if (page) {
            page.status = 'done';
            if (msg.summary) page.markdown = msg.summary;
          }
          break;
        case 'done':
          finished = true;
          view.phase = 'done';
          view.meta = { usage: msg.usage, model: msg.model, provider: msg.provider };
          isSummarizing = false;
          saveStoredSummary(videoId);
          break;
        case 'error':
          finished = true;
          view.phase = 'error';
          if (page) {
            page.status = 'error';
            page.error = msg.message;
            if (view.follow) view.current = msg.index;
          } else {
            view.error = msg.message;
          }
          isSummarizing = false;
          break;
      }
      renderPanel();
    });

    port.onDisconnect.addListener(() => {
      if (port !== activePort) return;
      activePort = null;
      if (finished) return;
      const s = streamingIndex();
      if (s !== -1) {
        const p = view.pages[s];
        if (p.markdown) { p.status = 'done'; p.truncated = true; }
        else { p.status = 'error'; p.error = 'Summarization ended unexpectedly. Try again.'; }
      } else if (!view.pages.length) {
        view.error = 'Summarization ended unexpectedly. Try again.';
      }
      view.phase = 'error';
      isSummarizing = false;
      renderPanel();
    });

    port.postMessage({ type: 'start', transcript, title, channel, images, durationSec });
  }

  // ---------- Image extraction (chapter thumbnails or main thumbnail) ----------

  // Images are only sent when "Include video thumbnails" is on, so don't fetch them otherwise.
  // When they are fetched, keep them in memory per video so ↻ Regenerate doesn't re-download.
  const imageCache = new Map(); // videoId -> images[]
  const IMAGE_CACHE_MAX = 5;

  async function getImages(videoId) {
    let includeImages = false;
    try {
      ({ includeImages = false } = await chrome.storage.sync.get('includeImages'));
    } catch {}
    if (!includeImages) return [];

    if (imageCache.has(videoId)) {
      log('image cache hit');
      return imageCache.get(videoId);
    }
    const images = await fetchImages(videoId);
    if (images.length) {
      imageCache.set(videoId, images);
      while (imageCache.size > IMAGE_CACHE_MAX) imageCache.delete(imageCache.keys().next().value);
    }
    return images;
  }

  async function fetchImages(videoId) {
    const images = [];

    // Try chapters from ytInitialData (we already fetched the page for transcript,
    // but let's re-fetch cheaply here — it'll be cached by the browser).
    try {
      const res = await fetch(`/watch?v=${encodeURIComponent(videoId)}`, {
        credentials: 'include',
      });
      if (res.ok) {
        const html = await res.text();
        const initialDataJson = extractInitialData(html);
        if (initialDataJson) {
          const data = JSON.parse(initialDataJson);
          const chapters = findChapters(data);
          if (chapters?.length) {
            const MAX = 10;
            const selected = chapters.slice(0, MAX);
            for (const ch of selected) {
              if (!ch.thumbnailUrl) continue;
              try {
                const { base64, mimeType } = await fetchAsBase64(ch.thumbnailUrl);
                images.push({ base64, mimeType, label: ch.title, startSeconds: ch.startSeconds });
              } catch (e) {
                log('chapter thumbnail fetch failed:', e.message);
              }
            }
          }
        }
      }
    } catch (e) {
      log('chapter extraction failed:', e.message);
    }

    // Fallback: main video thumbnail
    if (!images.length) {
      const candidates = [
        `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
        `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      ];
      for (const url of candidates) {
        try {
          const { base64, mimeType } = await fetchAsBase64(url);
          images.push({ base64, mimeType, label: 'main thumbnail', startSeconds: 0 });
          break;
        } catch (e) {
          log('main thumbnail fetch failed:', url, e.message);
        }
      }
    }

    return images;
  }

  function findChapters(data) {
    const markersMap = deepFindByKey(data, 'markersMap');
    if (!Array.isArray(markersMap)) return null;

    const chapterMarker = markersMap.find((m) =>
      ['DESCRIPTION_CHAPTERS', 'AUTO_CHAPTERS'].includes(m?.key)
    );
    if (!chapterMarker) return null;

    const chapters = chapterMarker.value?.chapters;
    if (!Array.isArray(chapters) || chapters.length === 0) return null;

    return chapters
      .map((c) => {
        const r = c.chapterRenderer;
        if (!r) return null;
        const thumbs = r.thumbnail?.thumbnails || [];
        return {
          title: r.title?.simpleText || '',
          startSeconds: (r.timeRangeStartMillis || 0) / 1000,
          thumbnailUrl: thumbs[thumbs.length - 1]?.url || null,
        };
      })
      .filter(Boolean);
  }

  function deepFindByKey(obj, targetKey) {
    if (!obj || typeof obj !== 'object') return null;
    if (targetKey in obj) return obj[targetKey];
    for (const val of Object.values(obj)) {
      if (val && typeof val === 'object') {
        const found = deepFindByKey(val, targetKey);
        if (found !== null && found !== undefined) return found;
      }
    }
    return null;
  }

  const SUPPORTED_IMAGE_MIMES = new Set([
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  ]);

  function mimeFromUrl(url) {
    const lower = url.split('?')[0].toLowerCase();
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.webp')) return 'image/webp';
    if (lower.endsWith('.gif')) return 'image/gif';
    return null;
  }

  async function fetchAsBase64(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    let mimeType = blob.type || mimeFromUrl(url) || 'image/jpeg';
    if (!SUPPORTED_IMAGE_MIMES.has(mimeType)) {
      log('unsupported image MIME, falling back to image/jpeg:', mimeType);
      mimeType = 'image/jpeg';
    }
    const base64 = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onloadend = () => {
        const result = typeof r.result === 'string' ? r.result : '';
        const comma = result.indexOf(',');
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      r.onerror = () => reject(new Error('FileReader error'));
      r.readAsDataURL(blob);
    });
    return { base64, mimeType };
  }

  // ---------- Button injection ----------

  function log(...args) {
    try { console.log('[YT Summarizer]', ...args); } catch {}
  }

  function makeButton(extraClass) {
    const btn = document.createElement('button');
    btn.id = BUTTON_ID;
    btn.className = 'yts-summarize-btn' + (extraClass ? ' ' + extraClass : '');
    btn.type = 'button';
    btn.innerHTML =
      '<span class="yts-btn-icon-inline">✨</span><span class="yts-btn-label">Summarize</span>';
    btn.addEventListener('click', () => {
      openOrSummarize();
    });
    return btn;
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findActionRow() {
    // Every selector that has matched YouTube's action row across various layouts
    const selectors = [
      'ytd-watch-metadata #top-level-buttons-computed',
      '#above-the-fold #top-level-buttons-computed',
      'ytd-menu-renderer.ytd-watch-metadata #top-level-buttons-computed',
      '#actions-inner #top-level-buttons-computed',
      '#menu #top-level-buttons-computed',
      '#top-level-buttons-computed',
      'ytd-watch-metadata #actions #menu',
      '#above-the-fold #actions #menu',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && isVisible(el)) return el;
    }
    return null;
  }

  function ensureInlineButton() {
    if (document.getElementById(BUTTON_ID)) return true;
    const row = findActionRow();
    if (row) {
      log('injecting inline into', row);
      row.appendChild(makeButton('yts-inline'));
      return true;
    }
    return false;
  }

  function ensureFloatingButton() {
    if (document.getElementById(BUTTON_ID)) return;
    log('falling back to floating button');
    document.body.appendChild(makeButton('yts-floating'));
  }

  function injectWithRetry() {
    if (ensureInlineButton()) return;
    let attempts = 0;
    const maxAttempts = 20; // ~5 seconds
    const iv = setInterval(() => {
      attempts++;
      if (ensureInlineButton()) {
        clearInterval(iv);
      } else if (attempts >= maxAttempts) {
        clearInterval(iv);
        // Fallback so user always has a way to summarize
        if (!document.getElementById(BUTTON_ID)) ensureFloatingButton();
      }
    }, 250);
  }

  // ---------- SPA navigation ----------

  function cancelSummary() {
    if (activePort) {
      try { activePort.disconnect(); } catch {}
      activePort = null;
    }
    isSummarizing = false;
  }

  function onNavigation() {
    const videoId = getVideoId();
    const existing = document.getElementById(BUTTON_ID);
    const panel = document.getElementById(PANEL_ID);

    if (!videoId) {
      cancelSummary();
      existing?.remove();
      panel?.classList.remove('yts-open');
      currentVideoId = null;
      return;
    }

    if (videoId === currentVideoId && existing) return;

    cancelSummary();
    existing?.remove();
    panel?.classList.remove('yts-open');
    currentVideoId = videoId;
    injectWithRetry();
  }

  // YouTube dispatches these during SPA nav
  window.addEventListener('yt-navigate-finish', onNavigation);
  document.addEventListener('yt-navigate-finish', onNavigation);

  // Fallback: observe URL changes
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      onNavigation();
    }
  }, 500);

  onNavigation();
})();
