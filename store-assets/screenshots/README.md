# Demo GIF

`demo.gif` is the animated demo shown at the top of the repo `README.md` and on the GitHub Pages site (`docs/demo.gif`).

To replace it, record a short (5–12 s) clip and convert it:

- macOS: QuickTime → File → New Screen Recording. Crop in Finder/Preview.
- Windows: Xbox Game Bar (Win+G) or ShareX.
- Linux: `peek`, `kooha`, or `byzanz-record` — all record a window to GIF.
- Convert MP4 → GIF with ffmpeg:
  ```bash
  ffmpeg -i demo.mp4 -vf "fps=15,scale=900:-1:flags=lanczos" -loop 0 demo.gif
  ```

Keep it under ~5 MB so GitHub embeds reliably. Show: watch page → click ✨ Summarize → panel slides in with the result.
