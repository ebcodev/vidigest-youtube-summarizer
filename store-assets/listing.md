# Chrome Web Store Listing

Copy the fields below into the Chrome Web Store developer console at [chrome.google.com/webstore/devconsole](https://chrome.google.com/webstore/devconsole).

---

## Title

```
Vidigest YouTube Summarizer
```

## Summary (132 character max — shown in search results)

```
Summarize YouTube videos with Claude, GPT, Gemini, or local Ollama. TL;DR, key points, takeaways. BYO API key. No backend.
```

## Description (plain text — Markdown is not rendered)

```
Summarize any YouTube video with the LLM of your choice, without leaving the page.

HOW IT WORKS
Click the Summarize button added to YouTube's action row (next to Like, Share, Save, Download). A side panel slides in with a structured summary: TL;DR, key points, and takeaways — streaming in token-by-token. Timestamps are clickable and jump the player. Copy as markdown, regenerate, or close.

WHY IT'S DIFFERENT
• Four providers, switch anytime: Anthropic (Claude), OpenAI (GPT), Google Gemini, or local Ollama.
• Multi-modal: optional toggle attaches chapter thumbnails so vision-capable models can actually see the video.
• No backend. Your API key stays in your browser. Requests go directly to the provider you chose. Nothing is logged by this extension.
• No subscription. Bring your own API key, pay the provider's standard per-token rates. Smaller models (e.g. Claude Haiku 5.5, GPT-6 Luna, Gemini 3.5 Flash-Lite) keep a typical video well under a cent. Ollama is free.
• Four transcript strategies (YouTube's own player captions, DOM scrape, YouTube's internal API, legacy caption URLs) for reliability across YouTube's frequent changes.
• Long videos are summarized in parts, shown as pages, with whole-video takeaways in the final part.
• Finished summaries are saved on your device and reopen instantly from the button or the toolbar icon.
• Streaming responses, a clickable [m:ss] jump link on every key point, 24-hour transcript cache.
• Open source. Code at github.com/ebcodev/vidigest-youtube-summarizer (Apache 2.0 license).
• Customizable system prompt if you want summaries in a specific style.

SETUP (one-time)
1. Install the extension.
2. Click the toolbar icon → Settings.
3. Pick a provider, paste your API key (or configure Ollama's local URL).
4. Pick a model. Provider-specific defaults are fast and cheap.

Click Summarize on any YouTube video with captions.

LIMITATIONS
• Requires captions (manual or auto-generated).
• Transcript-only — purely visual content without narration can't be summarized fully (thumbnail toggle helps).
• Ollama requires OLLAMA_ORIGINS=chrome-extension://<extension-id> (shown in Settings) before `ollama serve` so the extension can reach it.

PRIVACY
• No data collection by this extension. No analytics, no telemetry.
• Your API key is stored in Chrome's synced storage (local + Google sync).
• Transcripts and video titles are sent only to the provider you configured.
Full privacy policy: github.com/ebcodev/vidigest-youtube-summarizer/blob/main/PRIVACY.md

SOURCE CODE
github.com/ebcodev/vidigest-youtube-summarizer
```

## Category

```
Productivity
```

## Language

```
English (United States)
```

---

## Screenshots (required — upload 1 to 5)

None are kept in this repo; capture them when submitting. Suggested shots: the side panel open on a real video, a multi-part summary showing the pager, and the Settings page (blur or redact the API key).

Chrome Web Store required dimensions: **1280×800** or **640×400**, PNG or JPG.

## Promotional images (optional but recommended)

- Small promo tile: **440×280** PNG/JPG
- Large promo tile: **920×680** PNG/JPG
- Marquee: **1400×560** PNG/JPG

## Privacy practices section

When filling out the "Privacy practices" form in the Chrome Web Store console, the answers are:

- **Single purpose:** "Summarize YouTube videos using a user-selected LLM API (Anthropic, OpenAI, Google, or local Ollama)."
- **Permission justifications:**
  - `storage` → "Store the user's selected provider, API key(s), model choice, and custom system prompt locally, synced with their Chrome profile."
  - Host permission `https://www.youtube.com/*` → "The content script runs on YouTube watch pages to inject the Summarize button, extract the video's transcript, and render the summary panel."
  - Host permission `https://i.ytimg.com/*` → "Fetch chapter thumbnail images for the optional multi-modal mode."
  - Host permission `https://api.anthropic.com/*` → "Call the Anthropic Messages API when the user selects Claude."
  - Host permission `https://api.openai.com/*` → "Call the OpenAI Chat Completions API when the user selects GPT."
  - Host permission `https://generativelanguage.googleapis.com/*` → "Call the Google Gemini API when the user selects Gemini."
  - Host permission `http://localhost/*` + `http://127.0.0.1/*` → "Call a locally-running Ollama server when the user selects the local provider."
- **Remote code:** No.
- **Data usage disclosures:**
  - "Personally identifiable information": No.
  - "Health information": No.
  - "Financial and payment information": No.
  - "Authentication information": **Yes** — user's API key(s) stored locally and transmitted only to the selected provider's endpoint.
  - "Personal communications": No.
  - "Location": No.
  - "Web history": No.
  - "User activity": No.
  - "Website content": **Yes** — YouTube video transcripts (and optionally thumbnails) are read from the current page and sent to the user's selected LLM provider for summarization.

- **Certifications:**
  - ✅ I do not sell or transfer user data to third parties, outside of the approved use cases.
  - ✅ I do not use or transfer user data for purposes unrelated to my item's single purpose.
  - ✅ I do not use or transfer user data to determine creditworthiness or for lending purposes.

- **Privacy policy URL:**
  ```
  https://github.com/ebcodev/vidigest-youtube-summarizer/blob/main/PRIVACY.md
  ```

## Pricing

Free.

## Distribution

Public. All regions.

---

## Review notes

First-time submissions usually take 1–3 business days. Common rejection reasons for extensions like this:

- **Vague permission justifications** — the ones above are specific enough to pass.
- **Privacy policy not reachable** — make sure PRIVACY.md is pushed to GitHub before submitting.
- **Screenshots with irrelevant content** — keep them focused on the extension's UI, not full YouTube pages.

If rejected, the console shows the specific policy clause. Fix and resubmit.
