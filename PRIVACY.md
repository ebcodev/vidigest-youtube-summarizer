# Privacy Policy

**Effective date:** 2026-11-22

## What data is collected by this extension

**None.** Vidigest YouTube Summarizer does not collect, log, or transmit any data to its author or any third-party service other than the ones explicitly described below, and only when you initiate a summary.

## What data is sent, where, and why

When you click **Summarize** on a YouTube video:

1. The video's **transcript** is extracted from the YouTube page you are currently viewing. Extraction happens entirely in your browser — by asking YouTube's own video player to load the captions, by reading YouTube's transcript panel, by calling YouTube's internal transcript API at `youtube.com/youtubei/v1/get_transcript`, or by parsing caption URLs from the page HTML.

2. If you have enabled **Include video thumbnails**, the extension fetches chapter thumbnails (or the main thumbnail) from `i.ytimg.com` — YouTube's public thumbnail CDN.

3. The transcript, the video title, the video channel name, and (if enabled) the thumbnails are sent directly from your browser to the LLM provider **you have selected in Settings**. One of:
   - **Anthropic** — `api.anthropic.com` · [privacy policy](https://www.anthropic.com/legal/privacy)
   - **OpenAI** — `api.openai.com` · [privacy policy](https://openai.com/policies/privacy-policy)
   - **Google Gemini** — `generativelanguage.googleapis.com` · [privacy policy](https://policies.google.com/privacy)
   - **Ollama (local)** — the base URL you've configured (typically `http://localhost:11434`). Data never leaves your machine.

4. The provider returns a summary, which is rendered in the side panel.

## What is stored on your device

In `chrome.storage.local` (never synced, never sent anywhere):

- **Transcripts** of videos you summarized, keyed by video ID, for 24 hours (at most 50), so regenerating doesn't refetch them.
- **Finished summaries**, keyed by video ID, for 30 days (at most 100), so you can reopen them without calling the AI again.

Because these are keyed by video ID, they reveal which videos you summarized to anyone with access to your browser profile. Uninstalling the extension deletes them.

## Where your API keys live

Your API keys are stored in `chrome.storage.sync` under the provider key:

```
providers.anthropic.apiKey
providers.openai.apiKey
providers.gemini.apiKey
```

This means:
- They are stored locally in your Chrome profile.
- If you are signed into Chrome with sync enabled, Google syncs them between your Chrome installations.
- Each key is transmitted only to its own provider's endpoint, as the standard auth header for that provider.
- The extension author cannot access your keys.

## Third parties

- **YouTube** (`youtube.com`, `i.ytimg.com`) — for transcript and thumbnail extraction. No additional data is sent beyond what the page you're viewing already sends.
- **Whichever LLM provider you configure** — receives the transcript, title, channel, and (optionally) thumbnails.

No analytics. No telemetry. No advertising networks. No error reporting services. No data sharing between providers.

## Your control

- **Switch providers:** Settings → change provider → pick a different one. The inactive provider's keys remain saved for next time.
- **Delete an API key:** Settings → switch to the provider → clear the API key field → Save.
- **Turn off multi-modal:** Settings → untoggle "Include video thumbnails".
- **Stop all external calls:** pick Ollama and use a local model, or uninstall the extension.
- **Delete all stored data** (settings, keys, transcripts, saved summaries): uninstall the extension from `chrome://extensions`.

## Changes to this policy

Material changes will be documented in `CHANGELOG.md` and the effective date at the top of this document updated.

## Contact

Open an issue at [github.com/ebcodev/vidigest-youtube-summarizer/issues](https://github.com/ebcodev/vidigest-youtube-summarizer/issues).
