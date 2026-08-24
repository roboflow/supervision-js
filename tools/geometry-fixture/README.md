# Geometry Fixture Tooling

Offline tooling that builds the demo's basketball fixtures: one combined
`DetectionFrame` timeline that carries SAM3 masks, mask-derived polygons, a
bounded basketball center trace, and YOLO pose keypoints on one shared frame
grid. It builds `basketball_sam3` by default and `basketball_regions` through
the flags that README records.
Nothing here runs in the browser; the demo only consumes the committed chunks.

## Pieces

- `run-pose.py` — one-time pose generation following the Python Supervision
  keypoint recipe (Ultralytics YOLO pose over extracted frames). Reads either
  the frame manifest `tools/sam3-fixture/extract-frames.mjs` writes, which is
  the file the SAM3 run consumes, so one extraction feeds both models, or a
  directory of zero-padded PNG frames on that same grid. Writes raw,
  model-native output (`xyxy` boxes, COCO-17 keypoints with confidence) plus a
  metadata header with model checksum and generator versions. No image
  payloads, no credentials.
- `geometry.mjs` — pure normalization helpers: bounded deterministic polygon
  simplification, `xyxy` to center-rect conversion, one-based to zero-based
  skeleton edge conversion, the keypoint visibility policy, and per-geometry
  counting. Unit-tested by `geometry.test.mjs` (`node --test`).
- `create-geometry-fixture.mjs` — reads the committed SAM3 timeline and the
  cached raw pose output, derives polygons from masks via
  `convertDetectionMaskToPolygon()` (requires the built `supervision-js-core`
  package), attaches a bounded center trace to the selected frozen basketball
  detection, merges pose detections into the same frame records, then chunks
  the result with `tools/sam3-fixture/chunk-detections.mjs --compact`.

## Usage

```bash
npm run fixture:geometry:create        # builds core, converts, chunks
node --test tools/geometry-fixture/*.test.mjs
```

See `demo/fixtures/basketball_sam3/README.md` for full provenance and the pose
regeneration steps.
