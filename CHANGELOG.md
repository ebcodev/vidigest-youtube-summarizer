# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.0] - 2026-11-22

First release as **Vidigest YouTube Summarizer**. Licensed under Apache 2.0.

### Added
- **Multi-part summaries for long transcripts.** Transcripts over *Max transcript characters per request* (new setting, default 80,000) are split into balanced parts on line boundaries and summarized sequentially. Each request is told it is part *i* of *N* and its time range, and receives the earlier parts' summaries as context. With the default prompt each part gets a TL;DR and Key Points, and only the final part writes whole-video **Takeaways**; custom prompts get equivalent instructions (whole-video sections only in the final part). Safety cap of 20 parts.
- **Paginated panel:** ‹ › buttons, a "Part 2 of 3 · 20:00–40:00" label and clickable status dots; the panel follows the live part until you browse away.
- **Timestamped transcripts:** every extraction method keeps caption times and emits `[m:ss]` lines, so key points link to the right moment. The default prompt now requires a timestamp at the end of every key point.
- **Saved summaries** (`sum:<videoId>`, 30 days, max 100). *Summarize* reopens a saved summary instead of calling the AI; `↻` regenerates.
- **Minimize** button; the toolbar popup shows **Open summary** for videos with a saved, minimized or in-progress summary. `✕` now also stops a summary that is still generating.
- **Rate-limit retries:** HTTP 429/503/529 before any text streamed are retried (up to 4 times) after the provider's `retry-after`, with a countdown in the panel.
- Default prompt writes the summary in the transcript's language.
- Nested (indented) bullet lists and numbered lists render as real lists.
- Version shown in the toolbar tooltip and the Settings title.

### Changed
- Default models updated to each provider's current recommendation: `claude-opus-5-5`, `gpt-6.2-astra`, `gemini-3.8-flash`, `gemma4` (Ollama). Model presets refreshed; saved settings naming a shut-down model (Gemini 2.0/1.5, o3-mini) fall back to the default.
- Output cap raised from 1,500 to 16,000 tokens: current models' thinking/reasoning tokens count toward it and could cut summaries short. OpenAI requests use `max_completion_tokens` (reasoning models reject `max_tokens`).
- Thumbnails are fetched only when *Include video thumbnails* is on, are cached in memory for Regenerate, and each part only gets thumbnails in its time range.
- Transcript cache key is now `tr2:` (timed format); old `tr:` entries are evicted.

### Security
- Gemini API key is sent in the `x-goog-api-key` header instead of the URL query string.
- Ollama instructions recommend `OLLAMA_ORIGINS=chrome-extension://<this extension's id>` instead of `chrome-extension://*`, which let every installed extension use the local server.

### Fixed
- Transcript cache eviction only ran on every 10th write per page load, so expired transcripts accumulated toward the 10 MB storage quota; it now runs on every write.

## [1.2.4] - 2026-11-21

### Fixed
- **Transcripts failed on every video** ("This video may not have captions"). YouTube now requires a player-minted Proof-of-Origin token (`&pot=`) on timedtext requests and returns an empty 200 without it. New `page-bridge.js` (main-world content script, Chrome 111+) reuses the caption URL YouTube's own player signs. Innertube `get_transcript` is now sent with the page's real `INNERTUBE_CONTEXT`, avoiding `400 FAILED_PRECONDITION`. DOM scrape recognizes newer transcript-panel elements.
- The final error no longer claims a video "may not have captions" when a caption track was found.

## [1.2.3] - 2026-04-18

### Fixed
- `manifest.json` `description` field was 136 characters — Chrome Web Store rejects any description over 132 characters at upload time. Trimmed to 117 characters while keeping the provider list, the multi-modal angle, and the output shape (TL;DR / key points / takeaways). No functional changes.

## [1.2.2] - 2026-04-18

### Fixed
- **WebP thumbnails rejected by Anthropic.** YouTube now returns some chapter thumbnails (and `maxresdefault`) as `image/webp`, but the extension hard-coded `media_type: 'image/jpeg'` on every image sent to the LLM. Anthropic responded with `HTTP 400 — The image was specified using the image/jpeg media type, but the image appears to be a image/webp image`. `fetchAsBase64()` now reads the MIME from `blob.type` (falling back to URL-extension sniff, then `image/jpeg`), restricted to the four formats Anthropic supports (`jpeg | png | gif | webp`). The real MIME flows through to `callAnthropic`, `callOpenAI`, and `callGemini` request bodies.
- **"Empty transcript response" was a misleading last-fallback error.** When all three transcript strategies failed, the user only saw whatever the XML fallback threw. `getTranscript()` now collects each strategy's failure message and surfaces a single actionable error listing all reasons, e.g.:
  > No transcript could be extracted. Tried:
  > • DOM scrape: "Show transcript" button not found on page
  > • innertube: HTTP 400
  > • legacy: no captionTracks on this video — it probably has no captions
  >
  > This video may not have captions, or may be age/region restricted.
- `.yts-error` block now uses `white-space: pre-line` so multi-line error messages render as intended.

## [1.2.1] - 2026-04-18

### Fixed
- **GitHub Pages logo + favicon 404** — icons were referenced via `../extension/icons/` but Pages serves from `/docs`. Copied icons into `docs/` and updated the paths.
- **Streams could wedge indefinitely on hung providers.** All four providers now wrap their streaming body in a 60 s idle-timeout `AbortController`. The timer resets on every chunk; if it fires, the stream aborts and surfaces a short "stream stalled" error instead of leaving the UI spinning.
- **Mid-stream disconnect silently rendered partial text as if the model finished.** The footer now shows a `⚠ stream ended early` indicator when the port closes before a `done` message.
- **`seekVideo()` could target the wrong `<video>` element** (YouTube sidebar previews). Now prefers `#movie_player video`. Also clamps the target time to `[0, video.duration]`.
- **Transcript cache trusted malformed entries.** `getCachedTranscript` now validates `{ts: number, text: string}` shape and evicts bad entries on read.

### Changed
- Extracted pure parsing/rendering helpers (`sseEvents`, `ndjson`, `sliceBalancedJson`, `escapeHtml`, `renderMarkdown`, `findTranscriptParams`, `extractTranscriptTexts`) into `extension/lib/parsers.js`. Loaded by both the service worker (`importScripts`) and the content script (manifest).
- Transcript cache eviction scan now runs only every 10 writes, rather than on every write.
- Removed the dead `chrome.runtime.onMessage` `summarize` path — all summarization now uses the streaming port.
- CI `YOUR_USERNAME` check widened to cover `docs/` and `*.html`; uses explicit `--exclude=CLAUDE.md` instead of a fragile pipe grep.
- `manifest.json` `homepage_url` now points at the GitHub Pages site.

### Added
- **Unit tests** (`tests/parsers.test.js`, 31 cases) covering the extracted helpers — SSE/NDJSON parser correctness including chunk boundaries and `[DONE]`, balanced-brace JSON extraction with escaped quotes, markdown XSS safety, timestamp linkification, and YouTube innertube walkers. Wired into CI.
- README "Contributors" section acknowledging Claude Code as AI pair-programmer. Future commits carry a `Co-Authored-By: Claude …` trailer.

## [1.2.0] - 2026-04-18

### Added
- **Streaming responses** — summary text renders token-by-token as the model emits it, via a long-lived `chrome.runtime.connect` port. Service worker handles SSE for Anthropic / OpenAI / Gemini and NDJSON for Ollama.
- **Clickable timestamps** — `[mm:ss]` and `[h:mm:ss]` references in the summary become click-to-seek links that jump the YouTube player to the moment being described. Default prompt now instructs the model to emit them when useful.
- **Transcript caching** — extracted transcripts are stored in `chrome.storage.local` for 24 h (keyed on `videoId`) with opportunistic LRU-style eviction at 50 entries. Second and subsequent summaries of the same video skip the ~2–5 s extraction pipeline.
- Blinking cursor indicator during streaming.

### Changed
- `background.js` provider functions now always request streaming responses from the upstream API and surface them via an optional `onDelta` callback. Non-streaming `chrome.runtime.sendMessage({ type: 'summarize' })` still works for callers that prefer one-shot.
- Default system prompt updated to encourage `[mm:ss]` timestamp references in Key Points.

## [1.1.0] - 2026-04-17

### Added
- **Bring Your Own Model (BYOM)** — support for four providers, switchable per user in Settings:
  - Anthropic (Claude)
  - OpenAI (GPT)
  - Google Gemini
  - Ollama (local)
- **Multi-modal** — optional toggle to send video thumbnails alongside the transcript. Uses chapter thumbnails (one per chapter, up to 10) if the video has chapters, otherwise the main `maxresdefault.jpg`. Requires a vision-capable model on the selected provider.
- Provider registry in `background.js` with per-provider request/response translators.
- Automatic storage migration from v1.0.x flat keys (`apiKey`, `model`) to the new nested shape (`activeProvider`, `providers.{name}.*`).
- Per-provider model presets plus a custom model input.
- Panel footer now shows provider + model + token usage.

### Changed
- Options page redesigned for the provider dropdown with conditional fields.
- `manifest.json` `host_permissions` expanded for new providers: `api.openai.com`, `generativelanguage.googleapis.com`, `localhost`, `127.0.0.1`, and `i.ytimg.com` for thumbnails.

### Notes
- Ollama requires setting `OLLAMA_ORIGINS=chrome-extension://*` before `ollama serve` to allow CORS from the extension.

## [1.0.4] - 2026-04-17

### Added
- **DOM-scrape primary transcript method**: programmatically clicks YouTube's "Show transcript" button and reads rendered segments via `MutationObserver`. Uses YouTube's own auth — bypasses all token/signature issues. Auto-closes the panel when done.
- `VISITOR_DATA` extraction and `X-Goog-Visitor-Id` header for innertube requests.
- Detailed response-body logging on innertube 4xx/5xx errors.

### Changed
- Method order: DOM scrape → innertube → legacy baseUrl (json3 → XML).

## [1.0.3] - 2026-04-17

### Added
- Innertube `/youtubei/v1/get_transcript` as primary transcript method — uses YouTube's internal API rather than public caption URLs.
- Recursive walker for innertube response that handles both `transcriptSegmentRenderer` (new) and `transcriptCueRenderer` (older) shapes.

## [1.0.2] - 2026-04-17

### Added
- XML + `DOMParser` fallback when `fmt=json3` returns empty.
- Balanced-brace JSON extractor for `ytInitialPlayerResponse` (replaces fragile non-greedy regex that could stop short inside nested objects).

### Fixed
- "Failed to execute 'json' on 'Response'" error when caption URL returned empty body.

## [1.0.1] - 2026-04-17

### Added
- Floating red button fallback when YouTube's action row cannot be located.
- `[YT Summarizer]` console logging for diagnostics.
- Multiple selector strategies for the action row (8 variants covering current YouTube layouts).

### Changed
- Retry window extended for action-row detection.

## [1.0.0] - 2026-04-17

### Added
- Initial release.
- Manifest V3 Chrome extension.
- Inline "Summarize" button in YouTube action row.
- Side panel with TL;DR, Key Points, Takeaways.
- Model selection: Haiku 4.5 (default), Sonnet 4.6, Opus 4.7.
- Configurable system prompt.
- Copy-as-markdown and regenerate actions.
