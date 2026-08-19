# 70s Horse Trail

Generated SAM3 fixture for `1min-horse-video.mov`.

## Runtime Shape

The demo plays `proxy-30fps.webm`, declared as `media.proxyFile`. Frames for
SAM3 were extracted from a forced-CFR 30fps WebM transcode of the source, so
`frameIndex` counts slots on that grid rather than the source's own frames. The
source measures 30.004fps, which walks the two timelines apart over the clip:
playing the `.mov` put every detection 3ms off by 35s and 10ms off by 65s.
Detections are loaded from committed JSON chunks instead of calling SAM3 at
runtime.

## Prompts

- `person`
- `horse`
- `cow`

## Files

- `1min-horse-video.mov`: original source media copied by the fixture tool
- `proxy-30fps.webm`: the 30fps timeline the detections are indexed against,
  rebuilt with `npm run fixture:sam3:proxy -- --sample-name horse_trail`
- `raw-sam3.jsonl`: SAM3 responses with image payloads and API key omitted
- `detections.json`: normalized detection timeline
- `detections.manifest.json` and `detections/`: chunked demo runtime source

Temporary extracted frames are written outside the fixture folder at
`tools/sam3-fixture/output/horse_trail/frames.jsonl`.
