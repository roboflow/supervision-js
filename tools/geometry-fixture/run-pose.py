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
      --frames-dir /tmp/geometry-fixture/frames \
      --output demo/fixtures/basketball_geometry/raw-pose.jsonl

Frames must be named `<frameIndex>.png` (zero padded) and share the frame grid
of the detection fixture they will be merged into. No image payloads and no
credentials are written to the output.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
import sys
from pathlib import Path

RAW_POSE_SCHEMA = "supervision-js.tools.geometry-fixture.raw-pose"
DEFAULT_MODEL = "yolov8m-pose.pt"
DEFAULT_CONFIDENCE = 0.25


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--frames-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--confidence", default=DEFAULT_CONFIDENCE, type=float)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    frame_paths = sorted(args.frames_dir.glob("*.png"))

    if not frame_paths:
        print(f"No .png frames found in {args.frames_dir}", file=sys.stderr)
        return 1

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
                    "frameCount": len(frame_paths),
                    "pythonVersion": platform.python_version(),
                    "torchVersion": torch.__version__,
                    "ultralyticsVersion": ultralytics.__version__,
                },
                separators=(",", ":"),
            )
            + "\n"
        )

        for frame_path in frame_paths:
            frame_index = int(frame_path.stem)
            result = model.predict(
                source=frame_path,
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

    print(f"Wrote raw pose output for {len(frame_paths)} frames to {args.output}")
    return 0


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
