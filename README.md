# Vidigest YouTube Summarizer

A Chrome/Brave extension that summarizes YouTube videos with your choice of LLM: **Claude, GPT, Gemini, or local Ollama**. Bring your own API key; no backend, no data collection.

[![CI](https://github.com/ebcodev/vidigest-youtube-summarizer/actions/workflows/ci.yml/badge.svg)](https://github.com/ebcodev/vidigest-youtube-summarizer/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)

![Demo](store-assets/screenshots/demo.gif)

<sub>The demo shows an earlier UI; the panel now also has a pager and a minimize button.</sub>

## Features

- **TL;DR, Key Points and Takeaways**, written in the video's language. Every key point ends with a `[m:ss]` link that jumps the video to that moment.
- **Long videos are summarized in parts**, shown as pages (‹ › and part dots). Each part knows it is "part 2 of 3" and gets the earlier parts' summaries; Takeaways for the whole video come in the final part. Works with custom prompts too.
- **Saved summaries**: reopen a video's summary instantly from **Summarize** or the toolbar icon, without calling the AI again. `↻` regenerates.
- **Minimize** the panel while a summary keeps generating.
- **Reliable transcripts**: reads captions through YouTube's own player, with three fallbacks.
- **Rate-limit retries** with a countdown, optional **chapter thumbnails** for vision models, and a **custom prompt** option.

## Install

1. `git clone https://github.com/ebcodev/vidigest-youtube-summarizer.git`
2. Open `chrome://extensions` (or `brave://extensions`), enable **Developer mode**, click **Load unpacked** and select the `extension/` folder.
3. Click the extension icon → **Settings**, pick a provider, paste your API key, save.

Requires Chrome/Brave 111 or newer.

## Usage

On any YouTube video, click **✨ Summarize**.

Panel: `⎘` copy all parts · `↻` regenerate · `–` minimize · `✕` close (stops a summary still generating) · `‹ ›` change part · click `[m:ss]` to jump.

## Providers

Defaults follow each provider's current recommendation; any model name can be typed in Settings.

| Provider | Get a key | Default model |
|---|---|---|
| Anthropic (Claude) | [console.anthropic.com](https://console.anthropic.com/settings/keys) | `claude-opus-5-5` |
| OpenAI (GPT) | [platform.openai.com](https://platform.openai.com/api-keys) | `gpt-6.2-astra` |
| Google Gemini | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | `gemini-3.8-flash` |
| Ollama (local) | — | `gemma4` |

**Ollama:** allow only this extension before starting the server (its ID is shown in Settings):

```bash
export OLLAMA_ORIGINS='chrome-extension://<extension-id>'
ollama serve
```

## Long videos

Settings → **Max transcript characters per request** (default 80,000, roughly 20–27k tokens). Longer transcripts are split into balanced parts. Lower it if you hit rate-limit errors; raise it for fewer parts. Most videos under ~1.5 hours fit in one request.

## Privacy

Transcripts, titles and (optionally) thumbnails go only to the provider you chose. API keys stay in your browser's extension storage; transcripts (24 h) and summaries (30 days) are stored only on your device. No telemetry. See [PRIVACY.md](PRIVACY.md).

## Development

No build step. Edit `extension/`, reload the extension, reload the YouTube tab. Architecture notes are in [CLAUDE.md](CLAUDE.md).

```bash
for f in extension/lib/parsers.js extension/*.js; do node --check "$f"; done
node --test tests/*.test.js
```

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Written with [Claude Code](https://claude.com/claude-code) assistance.
