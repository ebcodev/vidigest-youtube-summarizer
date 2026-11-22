// page-bridge.js — runs in the page's MAIN world (see manifest.json) at document_start.
//
// Why this exists: YouTube now requires a Proof-of-Origin token (&pot=...) on timedtext
// caption requests; without it the endpoint returns an empty 200. Only YouTube's own player
// can mint that token, so we (1) record every timedtext URL the player requests, and
// (2) on demand, make the player request captions, then re-fetch that exact URL as json3.
// It also exposes the page's real ytcfg innertube context, which an isolated content
// script cannot read.
//
// Talks to content.js via window.postMessage (source tag 'yts-cs' -> 'yts-page').

(() => {
  if (window.__ytsBridgeInstalled) return;
  window.__ytsBridgeInstalled = true;

  const captured = new Map(); // videoId -> latest timedtext URL that carried a pot

  function record(url) {
    try {
      const u = new URL(String(url), location.origin);
      if (!u.pathname.includes('/api/timedtext')) return;
      if (!u.searchParams.get('pot')) return;
      const v = u.searchParams.get('v');
      if (v) captured.set(v, u.toString());
    } catch {}
  }

  // Intercept XHR + fetch so we never depend on the (size-limited) resource-timing buffer.
  try {
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      record(url);
      return origOpen.apply(this, arguments);
    };
  } catch {}
  try {
    const origFetch = window.fetch;
    window.fetch = function (input) {
      try { record(typeof input === 'string' ? input : input?.url); } catch {}
      return origFetch.apply(this, arguments);
    };
  } catch {}
  try { performance.setResourceTimingBufferSize?.(2000); } catch {}

  function scanPerformance(videoId) {
    try {
      for (const e of performance.getEntriesByType('resource')) record(e.name);
    } catch {}
    return captured.get(videoId) || null;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function getPlayer() {
    return document.getElementById('movie_player');
  }

  function captionsOn() {
    const b = document.querySelector('.ytp-subtitles-button');
    return b?.getAttribute('aria-pressed') === 'true';
  }

  function pickTrack(tracks) {
    if (!Array.isArray(tracks) || !tracks.length) return null;
    const lang = (t) => t.languageCode || t.vss_id?.replace(/^a?\./, '') || '';
    const isAsr = (t) => t.kind === 'asr' || String(t.vss_id || '').startsWith('a.');
    return (
      tracks.find((t) => lang(t) === 'en' && !isAsr(t)) ||
      tracks.find((t) => lang(t) === 'en') ||
      tracks.find((t) => lang(t).startsWith('en')) ||
      tracks[0]
    );
  }

  async function waitForCaptured(videoId, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const hit = captured.get(videoId) || scanPerformance(videoId);
      if (hit) return hit;
      await sleep(200);
    }
    return null;
  }

  async function transcriptViaPlayer(videoId) {
    const p = getPlayer();
    if (!p) throw new Error('player element not found');
    const current = p.getVideoData?.()?.video_id;
    if (current && current !== videoId) throw new Error('player is on a different video');

    let url = captured.get(videoId) || scanPerformance(videoId);

    if (!url) {
      const wasOn = captionsOn();
      try {
        p.loadModule?.('captions');
        await sleep(300);
        const list = p.getOption?.('captions', 'tracklist') || [];
        const prTracks =
          p.getPlayerResponse?.()?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
        if (!list.length && !prTracks.length) {
          throw new Error('player reports no caption tracks');
        }
        const chosen = pickTrack(list) || pickTrack(prTracks);
        if (chosen) {
          const opt = list.length
            ? chosen
            : { languageCode: chosen.languageCode, ...(chosen.kind ? { kind: chosen.kind } : {}) };
          p.setOption?.('captions', 'track', opt);
        }
        if (!captionsOn()) {
          if (typeof p.toggleSubtitlesOn === 'function') p.toggleSubtitlesOn();
          else document.querySelector('.ytp-subtitles-button')?.click();
        }
        url = await waitForCaptured(videoId, 8000);
      } finally {
        // Restore the user's caption state.
        if (!wasOn) {
          try {
            if (captionsOn()) {
              if (typeof p.toggleSubtitles === 'function') p.toggleSubtitles();
              else document.querySelector('.ytp-subtitles-button')?.click();
            }
          } catch {}
        }
      }
    }

    if (!url) throw new Error('player never requested captions (no pot-signed URL captured)');

    const u = new URL(url);
    u.searchParams.set('fmt', 'json3');
    if (!u.searchParams.get('c')) u.searchParams.set('c', 'WEB');
    const res = await fetch(u.toString(), { credentials: 'include' });
    if (!res.ok) throw new Error(`timedtext HTTP ${res.status}`);
    const body = await res.text();
    if (!body.trim()) throw new Error('timedtext empty even with pot');
    let json;
    try { json = JSON.parse(body); } catch { throw new Error('timedtext non-JSON response'); }
    // Keep each caption event's start time so the summary can link to video positions.
    const segments = (json.events || [])
      .filter((e) => e.segs)
      .map((e) => ({ ms: e.tStartMs, text: e.segs.map((s) => s.utf8 || '').join('') }))
      .filter((s) => s.text.trim());
    if (!segments.length) throw new Error('timedtext had no text segments');
    return segments;
  }

  async function transcriptViaInnertube(params) {
    const cfg = window.ytcfg;
    if (!cfg?.get) throw new Error('ytcfg not available');
    const context = cfg.get('INNERTUBE_CONTEXT');
    const apiKey = cfg.get('INNERTUBE_API_KEY');
    if (!context) throw new Error('no INNERTUBE_CONTEXT');
    const headers = {
      'Content-Type': 'application/json',
      'X-Youtube-Client-Name': String(cfg.get('INNERTUBE_CONTEXT_CLIENT_NAME') || 1),
      'X-Youtube-Client-Version': String(
        cfg.get('INNERTUBE_CLIENT_VERSION') || context?.client?.clientVersion || ''
      ),
    };
    const visitor = cfg.get('VISITOR_DATA') || context?.client?.visitorData;
    if (visitor) headers['X-Goog-Visitor-Id'] = visitor;

    const url = `/youtubei/v1/get_transcript?prettyPrint=false${apiKey ? `&key=${apiKey}` : ''}`;
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify({ context, params }),
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`innertube HTTP ${res.status} — ${raw.slice(0, 200)}`);
    return JSON.parse(raw); // content.js extracts the segments
  }

  window.addEventListener('message', async (ev) => {
    if (ev.source !== window) return;
    const msg = ev.data;
    if (!msg || msg.source !== 'yts-cs' || !msg.id) return;
    const reply = (payload) =>
      window.postMessage({ source: 'yts-page', id: msg.id, ...payload }, '*');
    try {
      if (msg.type === 'player-transcript') {
        reply({ ok: true, segments: await transcriptViaPlayer(msg.videoId) });
      } else if (msg.type === 'innertube-transcript') {
        reply({ ok: true, data: await transcriptViaInnertube(msg.params) });
      } else {
        reply({ ok: false, error: 'unknown request type' });
      }
    } catch (e) {
      reply({ ok: false, error: e?.message || String(e) });
    }
  });
})();
