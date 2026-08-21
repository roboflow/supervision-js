# Basketball Region Effects Fixture

This fixture reuses the committed basketball media and the frozen
`basketball_geometry` model inputs for the focused Region annotation renderer
playground. It adds a derived `head` detection for each segmented team player
with a sufficiently visible frozen facial pose.

The versioned `player-mask-pose-head-clip-v2` authoring transform uses frozen
COCO face and shoulder points to locate a conservative head ellipse, then
intersects that ellipse with the player's mask-derived polygon. The resulting
polygon is its own semantic detection (`sourceId: "derived-head-polygon"`) with
a tight rectangle and no keypoints. The browser renderer uses that polygon as
stencil coverage, so enlarged media crops contain player pixels and
transparency instead of a rectangular patch of background.

This is deterministic fixture authoring, not additional model output. Pose is
used only to author the committed head detections; the renderer and hosted
playground consume polygons and never depend on keypoints. The manifest records
the derivation and input hashes. No inference, key, or network access is used by
the docs or demo at runtime.

Regenerate the fixture from the committed SAM3 and pose inputs:

```bash
npm run fixture:geometry:create -- \
  --dataset-id basketball_regions_v1 \
  --derive-player-heads \
  --fixture-dir demo/fixtures/basketball_regions \
  --output tools/geometry-fixture/output/region-detections.json
```

The media is reused from `../basketball_sample/basketball_sample.mp4`; no new
video binary is committed.
