# Geometry Showcase Fixture (9s Basketball)

This fixture demonstrates every vector geometry supervision-js renders today —
boxes, masks, mask-derived polygons, a basketball trajectory polyline, and pose keypoints with skeleton edges —
on the existing 9 second basketball media. It is a deterministic, offline
composition of two model outputs; the demo loads it through the same
chunk-manifest path as the other samples, with no API key and no runtime
inference.

## Sources

1. **Segmentation (`sourceId: "sam3"`)** — the committed SAM3 timeline from
   the [`basketball_sam3` fixture](../basketball_sam3/README.md)
   (model `sam3/sam3_final`, prompts `white team player`,
   `yellow team player`, `basketball`). Detections keep their original ids,
   center-based rects, and compressed RLE masks.
2. **Pose (`sourceId: "yolo-pose"`)** — a one-time offline run of Ultralytics
   `yolov8m-pose.pt` following the Python Supervision keypoint recipe
   (<https://supervision.roboflow.com/latest/keypoint/annotators/>), cached in
   `raw-pose.jsonl`. See that file's first line for model checksum and
   generator versions (ultralytics 8.4.96, torch 2.13.0, python 3.12.9).

Both sources were produced from frames of
`../basketball_sam3/basketball_sample.normalized.webm`, so every detection
shares the SAM3 fixture's 30fps frame grid (`frameIndex` slots with decoded
sample `mediaTime`/`endTime`). Pose detections are attached to the existing
SAM3 frame records; pose output for a frame index without a SAM3 frame record
is dropped and reported by the generator.

## Geometry policies

- **Polygons** are derived offline from the SAM3 masks with
  `convertDetectionMaskToPolygon()` and then deterministically simplified
  (Ramer-Douglas-Peucker, tolerance 2px, escalating with a uniform-decimation
  cap) to at most 48 integer points. The source mask stays on the same
  detection so mask and polygon presentation can be compared per object.
- **Pose boxes** convert model `xyxy` corners to center-based rects.
- **Skeleton edges** convert the one-based COCO-17 edge list used by Python
  Supervision annotators to supervision-js zero-based `KeypointEdge` pairs.
- **Visibility** maps keypoint confidence `>= 0.5` to `Visible(2)` and
  everything else to `NotLabeled(0)`. Pose output has no occlusion state, so
  `Occluded(1)` is never invented. Edges with a `NotLabeled` endpoint are
  dropped.
- **Pose association** uses deterministic one-to-one center-rectangle IoU
  matching (minimum `0.3`) against `white team player` and
  `yellow team player` SAM3 detections. A match copies the pose keypoints onto
  the SAM3 detection, which remains authoritative for id, class, confidence,
  box, mask, polygon, and label. Unmatched YOLO poses are omitted, so the
  fixture does not create duplicate generic `person` detections or labels.
- **Basketball trajectory** is a deterministic motion-gated association across
  SAM3 `basketball` detections. SAM3 source ids can swap between frames, so the
  fixture selects the nearest physically reachable center (up to 2700 px/s,
with a 12 px tolerance), regardless of source id. It retains up to 60 points
from the last second and breaks the trace after 0.1 seconds without a
reachable observation, rather than drawing a false long segment. The selected
detection carries `metadata.trajectoryTrackId: "basketball-track:0"`; its
mask and polyline therefore always describe the same frozen detection. This
is a versioned derived field with no interpolation, not separate model output.

The exact values, input hashes, and policies are recorded in the `provenance`
block of `detections.manifest.json`.

## Files

```text
fixture.meta.json          demo discovery metadata (geometry-neutral schema)
raw-pose.jsonl             cached raw pose model output + generator metadata
detections.manifest.json   chunk manifest with geometry counts and provenance
detections/*.json          one-second DetectionFrame chunks (compact JSON)
```

The media is reused from `../basketball_sample/basketball_sample.mp4`
(sha256 `e013161a6b59088c35456c728639f11f4122adfe608437548389452dad53cd9d`);
no new media binary is committed. The combined `detections.json` intermediate
is not committed; it is regenerated on demand under
`tools/geometry-fixture/output/`.

Input checksums (sha256):

```text
raw-pose.jsonl                              b409674b1946a7bb313ef6a858520b9eec45bb357e96732f501d98875d803f52
../basketball_sam3/detections.json          5fad854bfeab82de38b3551272aff8e62df5f702120109e1de5c93c33628cb06
../basketball_sam3/*.normalized.webm        17c1f3c185b163a6f9fc4d409c6f681610a2dcc70529996aebea0de1e1ec8b43
```

## Regeneration

```bash
# 1. Extract the 270 30fps frames the models consume (lossless PNG).
mkdir -p /tmp/geometry-fixture/frames
ffmpeg -i demo/fixtures/basketball_sam3/basketball_sample.normalized.webm \
  -start_number 0 /tmp/geometry-fixture/frames/%06d.png

# 2. One-time pose run (writes raw-pose.jsonl; needs python3.12 + ultralytics).
python3 -m venv /tmp/geometry-fixture/venv
/tmp/geometry-fixture/venv/bin/pip install ultralytics
/tmp/geometry-fixture/venv/bin/python tools/geometry-fixture/run-pose.py \
  --frames-dir /tmp/geometry-fixture/frames \
  --output demo/fixtures/basketball_geometry/raw-pose.jsonl

# 3. Deterministic conversion + chunking (no Python, no network).
npm run fixture:geometry:create
```

Step 3 is fully deterministic given the committed inputs; steps 1-2 only need
to be repeated to change the pose model or media.

## Frozen segmentation source

`sam3-source.detections.json` is the exact SAM3 detections file this fixture's polygons were
derived from (the 30fps-proxy-era run; its SHA-256 is pinned in the manifest's provenance).
`../basketball_sam3/` has since been regenerated at native 25fps against the original MP4, so
the live file no longer matches this fixture's derivation. Rebuilding this fixture from the
native-fps detections (`npm run fixture:geometry:create`) also requires regenerating
`raw-pose.jsonl` on the same frame grid.
