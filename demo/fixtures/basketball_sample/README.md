# Basketball Rapid Fixture

This fixture uses `basketball_sample.mp4`, a Rapid-transcoded sample video.

`inference-events.jsonl` preserves the raw Rapid streaming inference events for
future mask rendering work. `detections.json` is the normalized demo payload
derived from those SSE result events.

Rapid frame indexes are mapped onto media time at 30 fps:

```text
mediaTime = frameIndex / 30
```

The current Rapid predictions are masks. Demo boxes are derived from the COCO
compressed RLE masks, then scaled from the 1008x567 mask coordinate space into
the 1920x1080 video coordinate space.

To regenerate the normalized detections from the raw Rapid SSE JSONL, run:

```sh
node normalize-detections.mjs
```
