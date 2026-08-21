# Basketball Region Effects Fixture

This fixture reuses the committed basketball media and the frozen
`basketball_geometry` model inputs for the focused Region annotation renderer
playground. It adds direct SAM3 `head` masks associated with the existing white
and yellow team-player detections.

The versioned `sam3-head-top-center-v1` authoring transform keeps SAM3 head
predictions with confidence at least `0.7`, then performs deterministic
one-to-one matching against plausible player rectangles. The score measures
distance from the head center to the top-center of the player rectangle. This
avoids relying on player masks that can temporarily omit the neck or head.

The selected SAM3 mask remains unchanged. Its exact coverage is converted into
a bounded polygon for Region renderer stencil coverage, and the committed head
detection retains both the compressed RLE mask and polygon under
`sourceId: "sam3-head"`. The renderer therefore enlarges clean head pixels with
transparency and has no runtime keypoint dependency.

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
