# Basketball SAM3 Fixture Tooling

This internal tool creates a repeatable two-phase fixture path for the
`basketball_sample.mp4` demo media without adding anything to the production
library or demo runtime.

## Phase 1: Extract Exact Normalized Frames

Run the Vite page:

```sh
npm run fixture:sam3:dev
```

Open `http://127.0.0.1:5175`, then use the browser console or automation:

```js
await window.prepareBasketballSam3Fixture();
await window.getBasketballSam3NormalizedMedia();
await window.getBasketballSam3FrameBatch({
  startFrameIndex: 0,
  count: 30,
  quality: 0.92,
});
await window.getBasketballSam3FixtureManifest();
```

The page fetches
`demo/fixtures/basketball_sample/basketball_sample.mp4`, normalizes it through
the existing `normalizeMedia` path to WebM VP9 at 30fps, video-only, forced
transcode, and `keyFrameInterval: 1`, then reopens the normalized Blob with
Mediabunny `Input`, `BlobSource`, `WEBM`, and `CanvasSink`.

Save the return value of `getBasketballSam3NormalizedMedia()` to:

```text
demo/fixtures/basketball_sam3/basketball_sample.normalized.webm
```

The returned object contains WebM metadata plus base64 without a data URL
prefix. The page only renders a short preview of this base64 so the UI remains
inspectable.

Frames are requested by deterministic normalized frame index, but sampled from
the center of each frame slot:

```text
sampleQueryTime = (frameIndex + 0.5) / 30
```

Each extracted frame includes JPEG base64, `frameIndex`, requested media time,
decoded sample timestamp/duration, and canvas width/height. Save one JSON object
per line as temporary local artifacts for the Node phase, such as
`tools/sam3-fixture/frames.jsonl` or files under `tools/sam3-fixture/output/`.
`frameIndex` is the requested normalized 30fps slot. `mediaTime` is the actual
decoded WebM sample timestamp because WebM stores timestamps on a millisecond
timebase, which produces `0.033s` / `0.034s` sample durations instead of exact
recurring thirds.

For repeatable automated extraction, start the fixture page in Chrome with a
remote debugging port, then run:

```sh
npm run fixture:sam3:extract -- \
  --output tools/sam3-fixture/output/frames.jsonl \
  --count 270 \
  --batch-size 1 \
  --url http://127.0.0.1:5175/
```

The Node script also accepts batch objects with a `frames` array, so automation
can write the return value of `getBasketballSam3FrameBatch(...)` directly as
JSONL.

This avoids service-side frame-index ambiguity because SAM3 is prompted from the
exact frames decoded out of the normalized 30fps media that the browser demo
uses, rather than from a separate video timeline. Keeping the normalized WebM
fixture beside the final detections lets deterministic sync checks render the
same media used for frame extraction.

## Phase 2: Run SAM3 Later

The Node runner is ready for an explicitly approved SAM3 run. It does not store
an API key and refuses to run unless `ROBOFLOW_API_KEY` is present in the
environment.

```sh
ROBOFLOW_API_KEY=... node tools/sam3-fixture/run-sam3.mjs \
  --input tools/sam3-fixture/frames.jsonl \
  --raw-output tools/sam3-fixture/raw-sam3.jsonl \
  --detections-output tools/sam3-fixture/detections.json \
  --limit 30 \
  --start-frame 0 \
  --concurrency 1
```

The runner posts to
`https://serverless.roboflow.com/sam3/concept_segment` with these exact prompts:

- `white team player`
- `yellow team player`
- `basketball`

Defaults are `output_prob_thresh: 0.1`, `format: "rle"`,
`model_id: "sam3/sam3_final"`, and `nms_iou_threshold: 0.5`.

Raw SAM3 responses are appended incrementally as JSONL with request metadata but
without the API key or image payload. This makes partial runs inspectable and
resumable.

The normalizer writes a detections JSON shaped like the existing basketball demo
fixture as much as possible. It accepts `prompt_results[].echo.text` or prompt
index for class names, polygons, and RLE masks. COCO-style compressed RLE string
counts become `compressedRle` masks. Uncompressed or uncertain RLE shapes are
kept under detection metadata and only used for box derivation when width,
height, and counts are clear.

After writing the normalized detections JSON, generate the chunked runtime
fixture:

```sh
npm run fixture:sam3:chunk
```

This writes `detections.manifest.json` plus one-second JSON chunks under
`demo/fixtures/basketball_sam3/detections/`. The demo imports those chunks as
separate Vite URL assets, which keeps the manifest cheap and lets the renderer
load only the buffered detection window.

Treat extracted frame JSONL, raw SAM3 JSONL, and other files in
`tools/sam3-fixture/output/` as temporary local artifacts. The fixture outputs to
keep are the normalized WebM at
`demo/fixtures/basketball_sam3/basketball_sample.normalized.webm` and the
normalized detection timeline plus chunked manifest in the same fixture
directory.

## Verification

Use the focused build:

```sh
npm run fixture:sam3:build
```

This script builds the package first so `supervision-js` self-imports resolve,
typechecks the Vite tool, and builds the fixture page. It is intentionally not
part of `npm run verify` because it is internal, depends on the package build
output, and may copy large fixture media during Vite builds.
