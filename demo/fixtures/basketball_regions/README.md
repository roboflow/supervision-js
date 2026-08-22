# Basketball Region Effects Fixture

This fixture drives the focused Region annotation renderer playground. It
reuses the committed basketball media and adds direct SAM3 `head` masks
associated with white and yellow team-player detections.

It indexes a 30fps grid, so it carries its own frozen model inputs:
`raw-pose.jsonl` is the local Ultralytics `yolov8m-pose.pt` run over that grid,
and `head-detections.json` is the normalized output of the SAM3 `head` prompt.
The 25fps `basketball_sam3` fixture is a separate run on a separate grid and
shares neither file.

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
within each stable player track. Observed frames record the original SAM3
bounds in `metadata.rawSam3MaskRect`; gap-filled frames omit that field and
retain `headObservation: "gap-filled"` plus their source detection and
translation metadata. No bounded polygon approximation is used.
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
  --output tools/geometry-fixture/output/region-detections.json \
  --pose-input demo/fixtures/basketball_regions/raw-pose.jsonl \
  --sam3-input <a 30fps segmentation timeline>
```

That last flag has no committed value. `detections.manifest.json` records this
fixture's segmentation input as `../basketball_sam3/detections.json` at sha256
`5fad854b...`, and the file at that path is now the merged 25fps timeline at
sha256 `2052a6ac...`. Rebuilding against it would land every head mask on a
different frame grid. The committed chunks stay authoritative until a 30fps
segmentation input is committed alongside them.

The media is reused from `../basketball_sample/basketball_sample.mp4`; no new
video binary is committed. The detections index a forced-CFR 30fps grid rather
than the source's own variable-rate frames, so `fixture.meta.json` declares
`../basketball_sample/proxy-30fps.webm` as `media.proxyFile` and the demo plays
that. The proxy is the same `normalizeMedia` output the v1 pipeline produced,
timestamp for timestamp, so frame index N still names the frame the detections
were computed on.
