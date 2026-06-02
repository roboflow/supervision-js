# SAM3 Fixture Tooling

This internal tool creates committed demo fixtures from local videos. It is
deliberately demo-owned: the reusable library feature is loading normalized
media plus chunked detections; SAM3 calls are only fixture/demo tooling.

## One-Command Fixture Creation

```sh
export ROBOFLOW_API_KEY=...
npm run fixture:sam3:create -- \
  --input /absolute/path/video.mov \
  --sample-name horse_trail \
  --classes "person, horse"
```

Quoted home-directory paths are supported too:

```sh
npm run fixture:sam3:create -- \
  --input "~/Downloads/1min-horse-video.mov" \
  --sample-name horse_trail \
  --classes "person, horse, cow"
```

The command:

1. Copies the original media into `demo/fixtures/<sample-name>/`.
2. Starts the fixture Vite page and a Chrome remote-debug session if needed.
3. Normalizes the copied media in the browser to WebM VP9 at 30fps.
4. Extracts deterministic normalized-frame JPEGs from the center of each frame
   slot.
5. Calls Roboflow Serverless SAM3 for the requested class prompts.
6. Writes `detections.json`, chunked `detections/*.json`, and
   `detections.manifest.json`.
7. Writes `fixture.meta.json`, which lets the demo discover the sample.

SAM3 `output_prob_thresh` is fixed at `0.1` so generated fixtures are dense
enough to stress-test mask rendering.

The generated demo fixture uses the original media file at runtime. The browser
normalizes that media live through the same `createMediaSession(..., normalize:
{ stream: true })` path used by uploads, then reads detections from the
committed chunk cache instead of calling SAM3 again.

Useful options:

```sh
npm run fixture:sam3:create -- \
  --input /path/video.mov \
  --sample-name smoke_test \
  --classes "horse" \
  --limit 60 \
  --concurrency 10
```

`--limit` is useful for smoke-testing the pipeline on a small frame count before
running a full 1-2 minute sample.

## Output Shape

Generated sample folders look like:

```text
demo/fixtures/<sample-name>/
  fixture.meta.json
  README.md
  <original-media-file>
  raw-sam3.jsonl
  detections.json
  detections.manifest.json
  detections/
    000000.json
    000001.json
```

`raw-sam3.jsonl` keeps request/response provenance without the API key or image
payloads. Extracted JPEG frame JSONL is temporary and written under
`tools/sam3-fixture/output/<sample-name>/frames.jsonl`, which is ignored by git.

## Lower-Level Commands

The one-command creator composes these scripts:

```sh
npm run fixture:sam3:extract -- \
  --output tools/sam3-fixture/output/my_sample/frames.jsonl \
  --sample-name my_sample \
  --source-file video.mov \
  --source-url /@fs//absolute/repo/path/demo/fixtures/my_sample/video.mov

npm run fixture:sam3:run -- \
  --input tools/sam3-fixture/output/my_sample/frames.jsonl \
  --raw-output demo/fixtures/my_sample/raw-sam3.jsonl \
  --detections-output demo/fixtures/my_sample/detections.json \
  --classes "person, horse" \
  --concurrency 10

npm run fixture:sam3:chunk -- \
  --input demo/fixtures/my_sample/detections.json \
  --fixture-dir demo/fixtures/my_sample \
  --dataset-id my_sample_v1
```

The browser extractor still exposes backwards-compatible basketball aliases:

```js
await window.prepareBasketballSam3Fixture();
await window.getBasketballSam3FrameBatch({ startFrameIndex: 0, count: 30 });
```

The generic equivalents are:

```js
await window.prepareSam3Fixture({
  sampleName: "my_sample",
  sourceFile: "video.mov",
  sourceUrl: "/@fs//absolute/repo/path/demo/fixtures/my_sample/video.mov",
});
await window.getSam3FrameBatch({ startFrameIndex: 0, count: 30 });
```

## Frame Semantics

Frames are requested by deterministic normalized frame index and sampled from
the center of each frame slot:

```text
sampleQueryTime = (frameIndex + 0.5) / 30
```

Each detection frame stores:

```text
frameIndex = deterministic 30fps slot
mediaTime = decoded normalized sample timestamp
endTime = mediaTime + decoded sample duration
```

The renderer uses `DetectionFrameSelectionMode.NearestFrameIndex` with
`frameRate = 30`, so samples resolve by the same normalized timeline used for
SAM3 extraction.

## Verification

```sh
npm run fixture:sam3:build
```

This builds the package, typechecks the fixture page, and builds the Vite
fixture tool. It intentionally does not call SAM3.
