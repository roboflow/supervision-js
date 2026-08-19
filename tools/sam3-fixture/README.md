# SAM3 Fixture Tooling

This internal tool creates committed demo fixtures from local videos. It is
deliberately demo-owned: the reusable library feature is loading media plus
chunked detections; SAM3 calls are only fixture/demo tooling.

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
3. Builds the source frame time table from the copied media's own packets.
4. Extracts one JPEG per source frame, at that frame's own timestamp.
5. Calls Roboflow Serverless SAM3 for the requested class prompts.
6. Writes `detections.json`, chunked `detections/*.json`, and
   `detections.manifest.json`.
7. Writes `fixture.meta.json`, which lets the demo discover the sample.

SAM3 `output_prob_thresh` is fixed at `0.1` so generated fixtures are dense
enough to stress-test mask rendering.

The demo plays the same original file the frames came from, and reads detections
from the committed chunk cache instead of calling SAM3 again.

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

## Frame Identity

There is no transcode, no proxy, and no forced frame rate. A resampled proxy
duplicates or drops frames relative to the file the demo plays, which detaches
every detection index from the pixels it was computed from.

`prepareSam3Fixture` opens the original file with mediabunny's `ALL_FORMATS` and
walks its primary video track with `EncodedPacketSink`, collecting every packet's
timestamp and duration. Packets iterate in **decode** order, so B-frame
reordering puts them out of presentation order: the horse trail sample starts
`0, 0.1333, 0.0667, 0.0333, ...`. Sorting the collected packets by timestamp
produces the presentation order the table is built from.

```text
frameIndex = position in the timestamp-sorted table
mediaTime  = table[frameIndex].timestamp
endTime    = table[frameIndex + 1].timestamp, or the track end for the last frame
```

Batches map ordinals straight through that table. A batch of
`startFrameIndex..startFrameIndex + count` becomes the exact timestamps of those
frames, requested through `CanvasSink.canvasesAtTimestamps` with a sub-millisecond
offset that keeps each query strictly inside its own frame interval. Every
decoded canvas is checked against its table entry within 2ms; a drift throws with
both the expected and the decoded timestamp rather than writing a mispaired
frame. Requesting past the end of the table throws instead of returning a short
batch.

At playback the demo selects detections with
`DetectionFrameSelectionMode.NearestFrameIndex`, using the manifest's real
`frameRate` and `frameIndexOriginTime = video.firstTimestamp`.

### Constant vs variable frame rate

Constant frame rate is the validated path. The two committed samples measure as:

| sample                  | frames | duration | frameRate |
| ----------------------- | -----: | -------: | --------: |
| `basketball_sample.mp4` |    225 |     9.0s |     25.00 |
| `1min-horse-video.mov`  |   2113 |  70.423s |    30.004 |

The horse trail source is not perfectly uniform: 64 of its 2112 intervals are one
timescale tick off (31.667ms or 35ms instead of 33.333ms). It still round-trips
exactly, and the manifest reports that as `video.frameIndexRoundTripError: 0`,
meaning `round((mediaTime - firstTimestamp) * frameRate)` recovers the source
frame index for every frame in the file.

On genuinely variable-rate media that error will be non-zero, and index-based
selection can land on a neighbouring frame. Detection frames always carry exact
`mediaTime` and `endTime`, so such a fixture should be played back with
`DetectionFrameSelectionMode.Interval` instead, which pairs by interval rather
than by grid position. Check `frameIndexRoundTripError` in the extractor manifest
before committing a fixture from a new source.

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
payloads. Extracted JPEG frames and the source frame manifest are temporary and
written under `tools/sam3-fixture/output/<sample-name>/` as `frames.jsonl` and
`frames.meta.json`, which git ignores.

## Rebuilding a v1 Fixture's Proxy

Fixtures generated before the frame-identity rewrite were inferred against a
forced-CFR 30fps VP9 WebM transcode, and their `frameIndex` values count slots
on that grid. Playing the source instead puts every detection on the wrong
frame, so those fixtures declare the transcode as `media.proxyFile` and the demo
plays it:

```sh
npm run fixture:sam3:dev      # in one terminal
npm run fixture:sam3:proxy -- --sample-name horse_trail
```

The command writes `proxy-30fps.webm` beside the fixture's source media and adds
`media.proxyFile` to `fixture.meta.json`. It reuses the same
`normalizeMedia` call the v1 pipeline used (WebM, VP9, `forceTranscode`, 30fps,
1 second key frame interval), which reproduces the committed
`basketball_sample.normalized.webm` timestamp for timestamp.

Mediabunny's default quality has risen about sixfold since those fixtures were
made, which turns the 70 second 1504x2016 horse sample into 627MB, so the rate
defaults to the committed proxy's own 0.07038 bits per pixel instead. Override
with `--bits-per-pixel` or an absolute `--bitrate`; neither moves a frame
boundary.

New fixtures need none of this: they pair detections with the source's own
frames and declare no proxy.

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

`fixture:sam3:extract` writes `frames.meta.json` next to its `--output`.
`fixture:sam3:run` reads the source frame rate, frame count, duration, and first
timestamp from it; pass `--frames-meta` to point somewhere else.

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

## Manifest

`prepareSam3Fixture` returns a version 2 manifest. Version 1 described a WebM
proxy and a forced 30fps grid; it had a `normalized` block, which version 2 does
not.

```json
{
  "schema": "supervision-js.tools.sam3-fixture.manifest",
  "version": 2,
  "sampleName": "horse_trail",
  "source": { "url": "...", "file": "...", "size": 0, "mimeType": null },
  "video": {
    "width": 1504,
    "height": 2016,
    "duration": 70.42333333333333,
    "firstTimestamp": 0,
    "frameCount": 2113,
    "frameRate": 30.00425995172055,
    "averagePacketRate": 30.00425995172117,
    "frameIndexRoundTripError": 0,
    "estimatedFrameCount": 2113
  }
}
```

`frameRate` is `frameCount / duration`. `averagePacketRate` is the same count
over the summed packet durations, kept as the raw unsmoothed reading.
`estimatedFrameCount` is the version 1 name for `frameCount` and now carries the
real table length, not a duration estimate.

## Verification

```sh
npm run fixture:sam3:build
npx vitest run tools/sam3-fixture
```

The build typechecks the fixture page and builds the Vite fixture tool. The tests
cover the frame time table: decode-order sorting, duplicate and missing timestamp
rejection, batch mapping at the table tail, and last-frame `endTime`. Neither
calls SAM3.
