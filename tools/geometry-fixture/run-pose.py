#!/usr/bin/env python3
"""One-time pose generation for the geometry showcase fixture.

This follows the Python Supervision keypoint recipe
(https://supervision.roboflow.com/latest/keypoint/annotators/): run an
Ultralytics YOLO pose checkpoint over still frames, then keep the raw model
output. Normalization into supervision-js `DetectionFrame` records happens in
`create-geometry-fixture.mjs`, so this script intentionally writes model-native
values: `xyxy` corner boxes and COCO-17 keypoints with per-point confidence.

Usage:
    python3 run-pose.py \
      --frames-jsonl tools/sam3-fixture/output/basketball_sam3/frames.jsonl \
      --output demo/fixtures/basketball_sam3/raw-pose.jsonl

`--frames-jsonl` reads the frame manifest `tools/sam3-fixture/extract-frames.mjs`
writes and `tools/sam3-fixture/run-sam3.mjs` consumes, so both models see one
frame grid. `--frames-dir` reads `<frameIndex>.png` files (zero padded) on that
same grid. Exactly one of the two is required.

The `--frames-jsonl` path has been exercised only as far as the decoded frame it
hands the model: no Ultralytics install was available to run a pose over one.

No image payloads and no credentials are written to the output.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import platform
import sys
from pathlib import Path

RAW_POSE_SCHEMA = "supervision-js.tools.geometry-fixture.raw-pose"
DEFAULT_MODEL = "yolov8m-pose.pt"
DEFAULT_CONFIDENCE = 0.25


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    frames = parser.add_mutually_exclusive_group(required=True)
    frames.add_argument("--frames-dir", type=Path)
    frames.add_argument("--frames-jsonl", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--confidence", default=DEFAULT_CONFIDENCE, type=float)
    return parser.parse_args(argv)


def main() -> int:
    args = parse_args()

    if args.frames_dir is not None:
        frame_paths = sorted(args.frames_dir.glob("*.png"))

        if not frame_paths:
            print(f"No .png frames found in {args.frames_dir}", file=sys.stderr)
            return 1

        frame_count = len(frame_paths)
        frames = ((int(path.stem), path) for path in frame_paths)
    else:
        # frameCount stands in the header above every prediction, and
        # create-geometry-fixture.mjs rejects a run whose count disagrees with
        # the detection grid, so the manifest is counted before the model loads.
        frame_count = sum(1 for _ in read_extracted_frames(args.frames_jsonl))

        if frame_count == 0:
            print(f"No frames found in {args.frames_jsonl}", file=sys.stderr)
            return 1

        frames = (
            (frame_index, decode_frame_image(image_base64))
            for frame_index, image_base64 in read_extracted_frames(
                args.frames_jsonl
            )
        )

    from ultralytics import YOLO
    import torch
    import ultralytics

    model = YOLO(args.model)
    weights_path = Path(model.ckpt_path)
    args.output.parent.mkdir(parents=True, exist_ok=True)

    with args.output.open("w", encoding="utf-8") as output:
        output.write(
            json.dumps(
                {
                    "schema": RAW_POSE_SCHEMA,
                    "version": 1,
                    "model": weights_path.name,
                    "weightsSha256": sha256(weights_path),
                    "confidenceThreshold": args.confidence,
                    "keypointFormat": "coco-17",
                    "boxFormat": "xyxy",
                    "frameCount": frame_count,
                    "pythonVersion": platform.python_version(),
                    "torchVersion": torch.__version__,
                    "ultralyticsVersion": ultralytics.__version__,
                },
                separators=(",", ":"),
            )
            + "\n"
        )

        for frame_index, frame in frames:
            result = model.predict(
                source=frame,
                conf=args.confidence,
                device="cpu",
                verbose=False,
            )[0]
            output.write(
                json.dumps(serialize_frame(frame_index, result), separators=(",", ":"))
                + "\n"
            )

            if frame_index % 30 == 0:
                print(f"pose frame {frame_index}", flush=True)

    print(f"Wrote raw pose output for {frame_count} frames to {args.output}")
    return 0


def read_extracted_frames(path: Path):
    """The frame index and base64 JPEG of every frame in an extractor manifest.

    A line holds one extraction batch, which is one frame or many.
    """
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            record = line.strip()

            if not record:
                continue

            for frame in batch_frames(json.loads(record)):
                yield read_extracted_frame(frame)


def batch_frames(record) -> list:
    if isinstance(record, list):
        return record

    if isinstance(record, dict) and isinstance(record.get("frames"), list):
        return record["frames"]

    return [record]


def read_extracted_frame(frame) -> tuple[int, str]:
    if not isinstance(frame, dict):
        raise ValueError("Extracted frame entries must be objects.")

    frame_index = frame.get("frameIndex")
    image = frame.get("image")
    value = frame.get("jpegBase64")

    if not isinstance(value, str) and isinstance(image, dict):
        value = image.get("value")

    if not isinstance(frame_index, int) or frame_index < 0:
        raise ValueError("Extracted frame is missing a valid frameIndex.")

    if not isinstance(value, str) or not value:
        raise ValueError(
            f"Extracted frame {frame_index} is missing JPEG base64 image data."
        )

    return frame_index, strip_data_url_prefix(value)


def strip_data_url_prefix(value: str) -> str:
    return value.split(",", 1)[1] if value.startswith("data:") else value


def decode_frame_image(image_base64: str):
    from PIL import Image

    return Image.open(io.BytesIO(base64.b64decode(image_base64)))


def serialize_frame(frame_index: int, result) -> dict:
    detections = []
    boxes = result.boxes
    keypoints = result.keypoints

    if boxes is not None and keypoints is not None:
        xyxy = boxes.xyxy.tolist()
        confidences = boxes.conf.tolist()
        points = keypoints.xy.tolist()
        point_confidences = (
            keypoints.conf.tolist() if keypoints.conf is not None else []
        )

        for index in range(len(xyxy)):
            detections.append(
                {
                    "xyxy": [round(value, 1) for value in xyxy[index]],
                    "confidence": round(confidences[index], 4),
                    "keypoints": {
                        "xy": [
                            [round(x, 1), round(y, 1)] for x, y in points[index]
                        ],
                        "confidence": [
                            round(value, 4)
                            for value in (
                                point_confidences[index]
                                if index < len(point_confidences)
                                else []
                            )
                        ],
                    },
                }
            )

    return {"frameIndex": frame_index, "detections": detections}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()

    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)

    return digest.hexdigest()


if __name__ == "__main__":
    sys.exit(main())
