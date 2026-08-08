# Inference Fixture Tooling

This directory contains one-time authoring commands for frozen demo fixtures.
They call a loopback-only Roboflow Inference server, preserve raw responses,
then normalize deterministic detection and tracking data for the browser.
Nothing here runs in tests, the published package, the docs, or deployed demos.

## Pipeline

1. `run.py` probes the input with FFprobe, extracts frames while retaining their
   exact presentation timestamps, submits each frame to Inference, and writes
   raw JSONL responses.
2. `track.py` reads those records and attaches confirmed IDs through the
   pinned `trackers` ByteTrack implementation. It does not alter raw outputs.
3. `create-fixture.mjs` assigns stable browser detection ids, converts server
   center-based boxes, derives time-bounded center traces as semantic open
   paths, and writes the existing chunked fixture manifest.
4. `tools/sam3-fixture/chunk-detections.mjs` creates one-second chunks from
   the normalized timeline.

The current first fixture is `people_walking_detection_v1`. Its CC0 source,
model artifact checksum, Inference image digest, tracker configuration, raw
responses, association output, and normalized result are all committed beside
the fixture. Do not use a live request in a browser or test as a replacement.

## Authoring Requirements

- FFmpeg and FFprobe;
- an Inference server bound to a loopback endpoint, normally
  `http://127.0.0.1:9001`;
- a Python environment containing the pinned `supervision` and `trackers`
  versions recorded by the fixture. The Inference container is a suitable
  authoring environment.

`run.py` rejects non-loopback server URLs and requires an explicit immutable
server image digest, model-weight SHA-256, and model license. It does not
accept or write API keys.

## Rebuild The Current Fixture

The concrete commands and verified hashes are in the fixture README. The shape
is intentionally explicit:

```bash
python tools/inference-fixture/run.py \
  --server http://127.0.0.1:9001 \
  --source demo/fixtures/people_walking_detection_v1/people-walking.webm \
  --output demo/fixtures/people_walking_detection_v1/raw-yolov8n-640.jsonl \
  --model yolov8n-640 \
  --model-license AGPL-3.0 \
  --model-weights-sha256 <verified checksum> \
  --inference-image-digest sha256:<verified digest> \
  --confidence 0.25 \
  --class-filter person

python tools/inference-fixture/track.py \
  --input demo/fixtures/people_walking_detection_v1/raw-yolov8n-640.jsonl \
  --output demo/fixtures/people_walking_detection_v1/bytetrack-associations.jsonl \
  --frame-rate 25

npm run fixture:inference:create
node tools/sam3-fixture/chunk-detections.mjs \
  --input demo/fixtures/people_walking_detection_v1/detections.json \
  --fixture-dir demo/fixtures/people_walking_detection_v1 \
  --dataset-id people_walking_detection_v1 \
  --compact
```

Run the fixture-tool unit tests and the repository checks after regeneration.
