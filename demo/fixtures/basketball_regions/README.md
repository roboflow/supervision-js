# Basketball Region Effects Fixture

This fixture reuses the committed basketball media and the frozen
`basketball_geometry` model inputs for the focused Region annotation renderer
playground. It adds direct SAM3 `head` masks associated with the existing white
and yellow team-player detections.

The versioned `sam3-head-temporal-mask-v4` authoring transform first runs the
supervision-js C-BIoU tracker over frozen team-player boxes. It then starts head
tracks from SAM3 predictions with confidence at least `0.7` and uses
predictions down to `0.5` only to continue an established track. Head matching
is deterministic and globally one-to-one. It preserves ownership for repeated
source masks and combines distance from the tracked player's top-center with
the head track's previous relative position and scale, rejecting implausible
single-frame jumps.

Internal gaps of at most seven frames are filled offline by translating the
nearest exact mask with player motion. If the frozen player detection is also
missing in a gap frame, its rectangle is interpolated from the two surrounding
observations. Each track's masks are normalized to a local 64 x 64 grid,
stabilized with a five-frame weighted temporal majority and a one-cell
morphological close, then projected into the current frame's SAM3 bounds so
the selected media pixels remain spatially aligned. Crop rectangles receive 6
px of padding, bidirectional exponential
smoothing, and a seven-frame local size envelope while remaining guaranteed to
contain every stabilized mask pixel. The committed detections keep stable ids
and tracker ids across frames.

The selected or translated SAM3 compressed RLE mask remains the authored source
under `sourceId: "sam3-head"`; the temporal pass only regularizes that mask
within each stable player track and records the original SAM3 bounds in
`metadata.rawSam3MaskRect`. No bounded polygon approximation is used.
The Region renderer reuses the prepared GPU id-mask artifact to enlarge only
the head pixels with transparency and has no runtime model or keypoint
dependency.

`head-detections.json` is the frozen normalized output of the SAM3 `head`
prompt. Inference and API credentials are authoring-only: the hosted docs and
demo read the generated chunk files and never perform network inference.

Regenerate the frozen SAM3 head input from the already-extracted frames:

```bash
ROBOFLOW_API_KEY="..." npm run fixture:sam3:run -- \
  --input tools/sam3-fixture/output/frames.jsonl \
  --raw-output tools/sam3-fixture/output/basketball-head.raw.jsonl \
  --detections-output demo/fixtures/basketball_regions/head-detections.json \
  --class head \
  --concurrency 10 \
  --sample-name basketball_regions_head \
  --source-file basketball_sample.normalized.webm
```

Then rebuild the Region fixture from the committed segmentation, pose, and head
inputs:

```bash
npm run fixture:geometry:create -- \
  --dataset-id basketball_regions_v1 \
  --head-sam3-input demo/fixtures/basketball_regions/head-detections.json \
  --fixture-dir demo/fixtures/basketball_regions \
  --output tools/geometry-fixture/output/region-detections.json
```

The media is reused from `../basketball_sample/basketball_sample.mp4`; no new
video binary is committed.
