# Horse Trail

Generated SAM3 fixture for `1min-horse-video.mov`.

## Runtime Shape

The demo plays this original media file. Detections were extracted from the same
file's own frames at its native frame rate, so `frameIndex` counts presented
source frames and detections land on the pixels they were computed from. The
demo loads them from committed JSON chunks instead of calling SAM3 at runtime.

## Prompts

- `person`
- `horse`
- `cow`

## Files

- `1min-horse-video.mov`: original source media copied by the fixture tool
- `raw-sam3.jsonl`: SAM3 responses with image payloads and API key omitted
- `detections.json`: normalized detection timeline
- `detections.manifest.json` and `detections/`: chunked demo runtime source

Temporary extracted frames are written outside the fixture folder at
`tools/sam3-fixture/output/horse_trail/frames.jsonl`.
