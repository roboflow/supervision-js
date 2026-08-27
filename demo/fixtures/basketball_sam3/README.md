# Basketball Sample Fixture (9s)

Every vector geometry supervision-js renders today on one 9 second clip: boxes,
SAM3 masks, mask-derived polygons, a basketball trajectory polyline, and pose
keypoints with skeleton edges. It is a deterministic offline composition of two
model outputs. The demo loads it through the chunk-manifest path with no API key
and no runtime inference.

## Runtime shape

The demo plays `../basketball_sample/basketball_sample.mp4`, which this fixture
shares rather than copying. Both models read that file's own frames at its
native 25fps, so `frameIndex` counts presented source frames and
every detection lands on the pixels it was computed from. There is no proxy
transcode and no resampled grid.

    duration      9s
    frames        225 at 25fps
    media         1920 x 1080
    detections    5948

## Sources

1. **Segmentation, `sourceId: "sam3"`** from `detections.json`, model
   `sam3/sam3_final`, prompts `white team player`, `yellow team player`,
   `basketball`. Detections keep their original ids, center-based rects and
   compressed RLE masks. `raw-sam3.jsonl` holds the responses with image
   payloads and the API key omitted.
2. **Pose, `sourceId: "yolo-pose"`** from `raw-pose.jsonl`, model
   `yolov8m-pose-640` run through the hosted
   `roboflow_core/roboflow_keypoint_detection_model@v3` block at
   `https://serverless.roboflow.com/infer/workflows`, confidence threshold
   `0.25`, COCO-17 keypoints. The run was hosted, so the provenance block
   records the model id, runtime, endpoint and block in place of a local weights
   checksum.

## Geometry coverage

Not every detection carries every kind, and the counts say which:

    boxes       5948   every detection
    masks       5948   every detection
    polygons    5948   derived from every mask
    keypoints   2005   34 percent of detections
    polyline     224   one trace segment per frame but the first

Keypoint coverage is partial by design. Pose association is one-to-one center
rect IoU at a minimum of `0.3` against `white team player` and
`yellow team player` only, so the 1690 unmatched pose detections are the crowd
and the officials and are dropped rather than added as generic `person`
detections. The 1702 unmatched target detections are players the pose model did
not resolve at that frame.

## Geometry policies

- **Polygons** come from the SAM3 masks through `convertDetectionMaskToPolygon()`
  and are then simplified deterministically (Ramer-Douglas-Peucker, 2px
  tolerance, escalating with a uniform-decimation cap) to at most 48 integer
  points. The source mask stays on the same detection so mask and polygon
  presentation can be compared per object.
- **Pose boxes** convert model `xyxy` corners to center-based rects.
- **Skeleton edges** convert the one-based COCO-17 edge list used by Python
  Supervision annotators to supervision-js zero-based `KeypointEdge` pairs.
- **Visibility** maps keypoint confidence `>= 0.5` to `Visible(2)` and everything
  else to `NotLabeled(0)`. Pose output carries no occlusion state, so
  `Occluded(1)` is never invented. An edge with a `NotLabeled` endpoint is
  dropped.
- **Pose association** copies matched keypoints onto the SAM3 detection, which
  stays authoritative for id, class, confidence, box, mask, polygon and label.
- **Basketball trajectory** is a motion-gated association across SAM3
  `basketball` detections. SAM3 source ids swap between frames, so the fixture
  selects the nearest physically reachable center (up to 2700 px/s, 12px
  tolerance) regardless of source id. It retains up to 60 points from the last
  second and breaks the trace after 0.1s without a reachable observation rather
  than drawing a false long segment. The selected detection carries
  `metadata.trajectoryTrackId: "basketball-track:0"`, so its mask and polyline
  always describe the same frozen detection. This is a versioned derived field
  with no interpolation, not separate model output.

## Confidence

Detections are committed unfiltered, down to `0.10`. `fixture.meta.json` opens
the demo at a `0.5` confidence gate, which leaves 2462 of the 5948 detections
visible. A surface that needs the full timeline has to set its own threshold.

A drawn trajectory spans up to a second of observations, so the detection's own
score answers a question about one frame rather than about the path, and a
single weak frame would erase a path built from twenty-five strong ones. The
frame carrying a polyline therefore also carries
`metadata.trajectoryConfidence`: the median SAM3 confidence of the observations
composing that window. Filter a trajectory on it and every other layer on
`confidence`. Under the fixture's own `0.5` gate that draws the trail across the
whole tracked run and hides the final restarted segment, whose observations all
score between `0.10` and `0.23`.

## Files

    fixture.meta.json          demo discovery metadata
    detections.json            normalized SAM3 timeline, git-ignored
    detections.manifest.json   chunk manifest with geometry counts and provenance
    detections/*.json          one-second DetectionFrame chunks (compact JSON)
    raw-sam3.jsonl             SAM3 responses, image payloads and key omitted
    raw-pose.jsonl             raw pose output plus its generator metadata

The media is not here. `fixture.meta.json` points at
`../basketball_sample/basketball_sample.mp4`, so the clip is tracked once for
every fixture that uses it.

The exact values, input hashes and policies are recorded in the `provenance`
block of `detections.manifest.json`.

## Regeneration

The merge is deterministic given the committed inputs and needs no network. It
reads the pre-merge SAM3 timeline from `detections.json`, which is git-ignored,
so restore that first:

```bash
npm run fixture:sam3:restore -- --sample-name basketball_sam3
npm run fixture:geometry:create
```

The restore renormalizes the committed `raw-sam3.jsonl` and verifies the result
against the sha256 this fixture was committed at, which `detections.manifest.json`
also records under `provenance.sources`. The chunks are the merge's own output
and already carry polygons, polylines and keypoints, so they cannot stand in for
that input.

Both raw inputs behind that merge have a committed path back to them. Both models
read one extraction of the source's own frames, so a full rebuild is four
commands:

```bash
npm run fixture:sam3:extract -- \
  --output tools/sam3-fixture/output/basketball_sam3/frames.jsonl \
  --sample-name basketball_sam3 \
  --source-file basketball_sample.mp4 \
  --source-url /@fs//absolute/repo/path/demo/fixtures/basketball_sample/basketball_sample.mp4

npm run fixture:sam3:run -- \
  --input tools/sam3-fixture/output/basketball_sam3/frames.jsonl \
  --raw-output demo/fixtures/basketball_sam3/raw-sam3.jsonl \
  --detections-output demo/fixtures/basketball_sam3/detections.json \
  --classes "white team player, yellow team player, basketball"

python3 tools/geometry-fixture/run-pose.py \
  --frames-jsonl tools/sam3-fixture/output/basketball_sam3/frames.jsonl \
  --output demo/fixtures/basketball_sam3/raw-pose.jsonl

npm run fixture:geometry:create
```

The extraction needs the fixture page from `npm run fixture:sam3:dev` and a
Chrome remote-debug session, which `tools/sam3-fixture/README.md` describes. The
SAM3 step needs a Roboflow API key in `ROBOFLOW_API_KEY`. The pose step needs a
local `ultralytics` install and no key.

That rebuild remakes `raw-sam3.jsonl` from the model and prompts recorded above,
and it replaces `raw-pose.jsonl` with a different model's output. The committed
pose came from the hosted
`roboflow_core/roboflow_keypoint_detection_model@v3` block, and no driver for
that hosted run is committed. `tools/geometry-fixture/run-pose.py` runs an
Ultralytics checkpoint locally over the extracted JPEG frames, and its header
records `yolov8m-pose.pt` with a weights checksum where the committed header
records a hosted model id, runtime, endpoint and block. Every count on this page
describes the committed file, so a rerun of the pose step moves the keypoint
coverage and the association totals.
