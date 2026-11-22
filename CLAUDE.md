# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Vidigest YouTube Summarizer: Chrome Manifest V3 extension that summarizes YouTube videos. Multi-provider (Anthropic / OpenAI / Gemini / Ollama), optional multi-modal (chapter thumbnails), vanilla JS, zero build step. User-facing docs are `README.md`.

## Architecture

Two JS files carry almost all the logic. Understand both before editing either.

### `extension/background.js` — service worker, provider dispatcher

- Central `PROVIDERS` registry (one entry per provider) declares `label`, `needsApiKey` / `needsBaseUrl`, `defaultModel`, `modelOptions`, `supportsVision`, and a `call()` function. Adding a new provider = adding one entry plus one `callXxx()` function; options page picks up `modelOptions` and conditional fields from `getProviders` message automatically.
- `summarizeInParts()` is the dispatcher: loads config, splits the timed transcript with `splitTranscript()` (max `maxChunkChars`, default 80k), then summarizes parts sequentially. Each part's system prompt gets a MULTI-PART MODE addendum (`multiPartInstructions`: part i/N, range, Takeaways or whole-video sections only in the final part; separate wording for default vs custom prompts) and its user message gets the earlier parts' summaries (`priorSummariesSection`, capped at 24k chars). Port protocol to the panel: `plan / part-start / chunk / status / part-done / done / error`.
- `callWithRetry()` retries HTTP 429/503/529 that happen before any text streamed, honoring `retry-after`; its countdown `status` messages also keep the MV3 worker alive.
- `OUTPUT_TOKEN_CAP` (16k) is the max output per request: current models think/reason first and those tokens count toward it. OpenAI uses `max_completion_tokens`; Gemini sends its key in `x-goog-api-key`, never in the URL.
- `RETIRED_MODELS` maps saved model IDs the providers shut down back to the provider default.
- `getConfig()` performs one-shot migration from v1.0.x flat keys (`apiKey`, `model`) into the nested v1.1 shape (`activeProvider`, `providers.{name}.{apiKey|baseUrl|model}`). Preserve this migration until v1.0.x users are fully washed out.
- Errors from providers go through `apiError()` which extracts `body.error.message` when available — keep user-visible strings short and actionable.

### `extension/content.js` — injected into YouTube watch pages

- **Transcript extraction (`getTranscript`)** produces *timed* text (`[m:ss] …` lines via `segmentsToTimedText`) so summaries can cite positions. Strategies in order, each load-bearing because YouTube breaks the others periodically:
  0. **Player captions** via `extension/page-bridge.js` (MAIN world, `document_start`): YouTube's timedtext endpoint returns an empty 200 without a player-minted PoToken (`&pot=`). The bridge records timedtext URLs the player requests (XHR/fetch hooks + resource timing), makes the player load captions when needed, re-fetches that signed URL as `json3`, and restores the user's caption state. content.js talks to it with `window.postMessage` (`askPage`).
  1. **DOM scrape** — click "Show transcript", wait for segment nodes, read text + `.segment-timestamp`.
  2. **Innertube** `get_transcript` — first sent from the page with the real `ytcfg` `INNERTUBE_CONTEXT` (a hand-built context causes 400 FAILED_PRECONDITION), then the old hand-built request.
  3. **Legacy caption URLs** (`json3` → XML). Empty without a `pot`; last resort.
  Cache: `tr2:<videoId>` in `chrome.storage.local` (24 h). `tr:` keys are the pre-1.3 untimed format and get evicted.
- `sliceBalancedJson()` is used for extracting `ytInitialData` / `ytInitialPlayerResponse` — it walks characters tracking brace depth and string escapes. **Do not** replace it with a regex; nested braces in YouTube's JSON broke that in the past.
- **Image pipeline (`getImages`)** — if the video has chapters (`markersMap` keyed `DESCRIPTION_CHAPTERS` or `AUTO_CHAPTERS`), fetch up to 10 chapter thumbnails with their titles and start times. Otherwise fall back to `maxresdefault.jpg` → `hqdefault.jpg`. All images are base64-encoded JPEGs sent to the provider only if `includeImages` is on in settings.
- **Button injection** tries a list of 8 action-row selectors covering current YouTube layouts. If none match within ~5 s, falls back to a floating button so the user always has an entry point.
- **SPA navigation** — listens on `yt-navigate-finish` and polls `location.href` every 500 ms. Button + panel are cleared and re-injected on every video change.
- `renderMarkdown()` is a deliberately tiny renderer that **escapes first, then applies transforms** — safe against XSS from model output. Supports nested (indented) and numbered lists. Do not replace with a library.
- **Panel** — `view` holds one page per part; `renderPanel()` never opens the panel by itself (so a minimized panel stays minimized while streaming); `openPanel()` is called only on explicit actions. Finished summaries are saved as `sum:<videoId>` (30 days, max 100); `openOrSummarize()` reopens a saved/in-progress summary before calling the AI. The toolbar popup asks the tab via `yts-status` / `yts-open` messages.

### Storage schema (`chrome.storage.sync`)

```js
{
  activeProvider: 'anthropic' | 'openai' | 'gemini' | 'ollama',
  providers: {
    anthropic: { apiKey, model },
    openai:    { apiKey, model },
    gemini:    { apiKey, model },
    ollama:    { baseUrl, model },
  },
  customPrompt: string,
  includeImages: boolean,
  maxChunkChars: number, // 0/absent = default 80000
}
```

`chrome.storage.local`: `tr2:<videoId>` transcripts, `sum:<videoId>` saved summaries.

## Development

No build step. Edit `extension/` files directly, reload the extension in `chrome://extensions`, reload the YouTube tab.

Syntax-check before committing:

```bash
node --check extension/background.js
node --check extension/content.js
node --check extension/page-bridge.js
node --check extension/options.js
node --check extension/popup.js
python3 -c "import json; json.load(open('extension/manifest.json'))"
```

## Cut a new release

1. Bump `version` in `extension/manifest.json` (semver).
2. Add a `## [X.Y.Z] - YYYY-MM-DD` section at the top of `CHANGELOG.md`.
3. Commit, tag, push:
   ```bash
   VERSION=1.1.1
   git commit -am "Release v${VERSION}"
   git tag "v${VERSION}"
   git push && git push --tags
   ```
4. Build the Chrome Web Store zip (ship only the contents of `extension/`):
   ```bash
   cd extension
   zip -r "../vidigest-youtube-summarizer-v${VERSION}.zip" . -x '.DS_Store' -x '*.bak'
   cd ..
   ```
5. GitHub release + Web Store upload:
   ```bash
   gh release create "v${VERSION}" "vidigest-youtube-summarizer-v${VERSION}.zip" \
     --title "v${VERSION}" --notes "See CHANGELOG.md"
   ```
   Then upload the same zip at https://chrome.google.com/webstore/devconsole (1–3 business day review).

## Code conventions

- Vanilla JS, 2-space indent, no framework, no bundler, no minifier (Chrome Web Store reviewers read the source).
- Console logs go through `log(...)` in `content.js` which prefixes `[YT Summarizer]`.
- Chrome refuses to load an unpacked extension containing files or folders whose names start with `_`; never add such paths under `extension/`.
- User-visible errors: short, actionable strings.
- Keep `manifest.json` `permissions` / `host_permissions` minimal — every addition extends the Web Store review. Current set: `storage` + hosts for `www.youtube.com`, `i.ytimg.com`, the four provider APIs, and `localhost`/`127.0.0.1` (Ollama).

## Do not

- Do not add `<all_urls>`, `tabs`, or `scripting` permissions unless strictly required.
- Do not bundle or minify.
- Do not add analytics, telemetry, or error-reporting services — the privacy promise in `PRIVACY.md` is absolute.
- Do not embed API keys or secrets anywhere in the repo.
- Do not replace `sliceBalancedJson` with a regex, or `renderMarkdown` with a library (see architecture notes).
