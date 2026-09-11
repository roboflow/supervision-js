# Finite-video duration browser regression

This fixture uses the actual published-package entrypoint built from this checkout, a real browser decoder, and synthetic test-pattern video. It tests undersized/oversized media-header durations, a valid control, and a positive edit-list timestamp offset. Each case seeks to the presentation end and checks the captured final frame timestamp.

```sh
npm run build
npx vite build --config tools/video-duration/vite.config.ts
python3 -m http.server 4189 --bind 127.0.0.1 --directory dist/video-duration
```

Open http://127.0.0.1:4189 and click **Run all cases and seek to End**. Stop the server afterwards. This is a static build: no filesystem watcher is required.

Expected: all durations are 3.4 seconds; the final frame and matching overlay are at 3.2 seconds, or 5.2 seconds for the file starting at 2 seconds.
