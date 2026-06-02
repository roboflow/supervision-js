# 70s Horse Trail

Generated SAM3 fixture for `1min-horse-video.mov`.

## Runtime Shape

The demo loads the original media file and normalizes it in-browser to the same
30fps WebM timeline used to extract the frames for SAM3. Detections are loaded
from committed JSON chunks instead of calling SAM3 at runtime.

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
