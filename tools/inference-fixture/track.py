#!/usr/bin/env python3
"""Attach deterministic ByteTrack ids to preserved raw detection responses.

This is an authoring step, not browser or test runtime. It accepts the JSONL
written by run.py and records only deterministic associations plus explicit
tracker package provenance. The raw HTTP responses remain untouched.
"""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import platform
import sys
from pathlib import Path

import numpy as np
import supervision as sv
from trackers import ByteTrackTracker


TRACK_SCHEMA = "supervision-js.tools.inference-fixture.bytetrack"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--frame-rate", required=True, type=float)
    parser.add_argument("--track-activation-threshold", default=0.25, type=float)
    parser.add_argument("--high-confidence-threshold", default=0.25, type=float)
    parser.add_argument("--minimum-consecutive-frames", default=2, type=int)
    parser.add_argument("--minimum-iou-threshold", default=0.1, type=float)
    parser.add_argument("--lost-track-buffer", default=30, type=int)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.frame_rate <= 0:
        raise ValueError("--frame-rate must be positive.")
    records = [json.loads(line) for line in args.input.read_text().splitlines() if line]
    if not records or records[0].get("schema") != "supervision-js.tools.inference-fixture.raw-object-detection":
        raise ValueError("--input must start with a raw inference-fixture header.")

    tracker = ByteTrackTracker(
        frame_rate=args.frame_rate,
        high_conf_det_threshold=args.high_confidence_threshold,
        lost_track_buffer=args.lost_track_buffer,
        minimum_consecutive_frames=args.minimum_consecutive_frames,
        minimum_iou_threshold=args.minimum_iou_threshold,
        track_activation_threshold=args.track_activation_threshold,
    )
    header = {
        "schema": TRACK_SCHEMA,
        "version": 1,
        "algorithm": "roboflow-trackers-byte-track-v1",
        "frameRate": args.frame_rate,
        "parameters": {
            "highConfidenceThreshold": args.high_confidence_threshold,
            "lostTrackBuffer": args.lost_track_buffer,
            "minimumConsecutiveFrames": args.minimum_consecutive_frames,
            "minimumIouThreshold": args.minimum_iou_threshold,
            "trackActivationThreshold": args.track_activation_threshold,
        },
        "pythonVersion": platform.python_version(),
        "supervisionVersion": sv.__version__,
        "trackersVersion": importlib.metadata.version("trackers"),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8") as output:
        write_jsonl(output, header)
        for record in records[1:]:
            predictions = record["response"].get("predictions", [])
            detections = make_detections(predictions)
            tracked = tracker.update(detections)
            associations = sorted(
                (
                    {"predictionIndex": int(index), "trackId": int(track_id)}
                    for index, track_id in zip(
                        tracked.data.get("predictionIndex", []),
                        tracked.tracker_id if tracked.tracker_id is not None else [],
                    )
                    if track_id != -1
                ),
                key=lambda association: association["predictionIndex"],
            )
            write_jsonl(
                output,
                {
                    "associations": associations,
                    "sourceFrameIndex": record["sourceFrameIndex"],
                },
            )
    print(f"Wrote ByteTrack associations to {args.output}")
    return 0


def make_detections(predictions: list[dict]) -> sv.Detections:
    if not predictions:
        return sv.Detections.empty()
    xyxy = np.array(
        [
            [
                prediction["x"] - prediction["width"] / 2,
                prediction["y"] - prediction["height"] / 2,
                prediction["x"] + prediction["width"] / 2,
                prediction["y"] + prediction["height"] / 2,
            ]
            for prediction in predictions
        ],
        dtype=float,
    )
    return sv.Detections(
        xyxy=xyxy,
        confidence=np.array([prediction["confidence"] for prediction in predictions]),
        class_id=np.array([prediction["class_id"] for prediction in predictions]),
        data={"predictionIndex": np.arange(len(predictions))},
    )


def write_jsonl(output, value: dict) -> None:
    output.write(json.dumps(value, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    sys.exit(main())
