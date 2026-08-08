#!/usr/bin/env python3
"""Generate raw, timestamped object-detection output for a frozen fixture.

This authoring-only command intentionally has no repository Python dependency:
it uses FFmpeg plus the local Inference HTTP API and writes model-native
responses as JSONL. Normalization, tracking, and chunking occur in separate,
versioned steps so the committed fixture remains reproducible and the hosted
demo never calls Inference.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import platform
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen


RAW_SCHEMA = "supervision-js.tools.inference-fixture.raw-object-detection"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", default="http://127.0.0.1:9001")
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--model", required=True)
    parser.add_argument("--model-license", required=True)
    parser.add_argument("--model-weights-sha256", required=True)
    parser.add_argument("--inference-image-digest", required=True)
    parser.add_argument("--confidence", default=0.25, type=float)
    parser.add_argument("--iou-threshold", default=0.3, type=float)
    parser.add_argument("--frame-stride", default=1, type=int)
    parser.add_argument("--class-filter", action="append", default=[])
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    validate_args(args)
    source = args.source.resolve()
    media = probe_media(source)
    server = inspect_server(args.server)
    ffmpeg_version = command_version("ffmpeg", "-version")

    with tempfile.TemporaryDirectory(prefix="supervision-js-inference-fixture-") as temp:
        temp_dir = Path(temp)
        frames = extract_frames(source, temp_dir, args.frame_stride)
        if not frames:
            raise RuntimeError("FFmpeg did not extract any video frames.")

        header = {
            "schema": RAW_SCHEMA,
            "version": 1,
            "authoring": {
                "ffmpegVersion": ffmpeg_version,
                "generator": "tools/inference-fixture/run.py",
                "gitCommit": git_commit(),
                "pythonVersion": platform.python_version(),
            },
            "inference": {
                "imageDigest": args.inference_image_digest,
                "server": server,
                "request": {
                    "classFilter": args.class_filter,
                    "confidence": args.confidence,
                    "disableActiveLearning": True,
                    "iouThreshold": args.iou_threshold,
                    "usageBillable": False,
                },
            },
            "model": {
                "alias": args.model,
                "license": args.model_license,
                "weightsSha256": args.model_weights_sha256,
            },
            "source": {
                "sha256": sha256(source),
                **media,
            },
        }

        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open("w", encoding="utf-8") as output:
            write_jsonl(output, header)
            for index, frame in enumerate(frames):
                response = infer_frame(
                    server=args.server,
                    model=args.model,
                    frame_path=frame["path"],
                    confidence=args.confidence,
                    iou_threshold=args.iou_threshold,
                    class_filter=args.class_filter,
                    request_id=f"fixture-{frame['sourceFrameIndex']:06d}",
                )
                end_time = (
                    frames[index + 1]["mediaTime"]
                    if index + 1 < len(frames)
                    else media["duration"]
                )
                write_jsonl(
                    output,
                    {
                        "endTime": end_time,
                        "frameImageSha256": sha256(frame["path"]),
                        "mediaTime": frame["mediaTime"],
                        "response": response,
                        "sourceFrameIndex": frame["sourceFrameIndex"],
                    },
                )
                if (index + 1) % 25 == 0 or index + 1 == len(frames):
                    print(f"inferred {index + 1}/{len(frames)} frames", flush=True)

    print(f"Wrote raw inference output to {args.output}")
    return 0


def validate_args(args: argparse.Namespace) -> None:
    parsed = urlparse(args.server)
    if parsed.scheme not in {"http", "https"} or parsed.hostname not in {
        "127.0.0.1",
        "::1",
        "localhost",
    }:
        raise ValueError("--server must be a loopback HTTP(S) endpoint.")
    if not args.source.is_file():
        raise ValueError(f"--source does not exist: {args.source}")
    if args.frame_stride < 1:
        raise ValueError("--frame-stride must be at least 1.")
    if not 0 <= args.confidence <= 1:
        raise ValueError("--confidence must be between 0 and 1.")
    if not 0 <= args.iou_threshold <= 1:
        raise ValueError("--iou-threshold must be between 0 and 1.")
    if not is_sha256(args.model_weights_sha256):
        raise ValueError("--model-weights-sha256 must be a 64-character SHA-256.")
    if not args.inference_image_digest.startswith("sha256:") or not is_sha256(
        args.inference_image_digest.removeprefix("sha256:")
    ):
        raise ValueError("--inference-image-digest must be sha256:<64 lowercase hex>.")


def probe_media(source: Path) -> dict:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=codec_name,width,height,r_frame_rate,duration",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            str(source),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    parsed = json.loads(result.stdout)
    stream = parsed["streams"][0]
    duration = float(stream.get("duration") or parsed["format"]["duration"])
    return {
        "codec": stream["codec_name"],
        "duration": round(duration, 6),
        "frameRate": stream["r_frame_rate"],
        "height": stream["height"],
        "width": stream["width"],
    }


def inspect_server(server: str) -> dict:
    with urlopen(f"{server.rstrip('/')}/info", timeout=10) as response:
        info = json.load(response)
    return {"name": info.get("name"), "version": info.get("version")}


def extract_frames(source: Path, temp_dir: Path, frame_stride: int) -> list[dict]:
    frame_times = probe_frame_times(source)
    selected = frame_times[::frame_stride]
    frames_dir = temp_dir / "frames"
    frames_dir.mkdir()
    subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(source),
            "-vf",
            f"select='not(mod(n\\,{frame_stride}))'",
            "-vsync",
            "0",
            "-q:v",
            "2",
            str(frames_dir / "%06d.jpg"),
        ],
        check=True,
    )
    paths = sorted(frames_dir.glob("*.jpg"))
    if len(paths) != len(selected):
        raise RuntimeError(
            f"FFmpeg frame count mismatch: extracted {len(paths)}, expected {len(selected)}."
        )
    return [
        {
            "mediaTime": selected[index]["mediaTime"],
            "path": path,
            "sourceFrameIndex": selected[index]["sourceFrameIndex"],
        }
        for index, path in enumerate(paths)
    ]


def probe_frame_times(source: Path) -> list[dict]:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "frame=best_effort_timestamp_time",
            "-show_frames",
            "-of",
            "json",
            str(source),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    frames = json.loads(result.stdout).get("frames", [])
    timestamps = [
        {
            "mediaTime": round(float(frame["best_effort_timestamp_time"]), 6),
            "sourceFrameIndex": index,
        }
        for index, frame in enumerate(frames)
        if frame.get("best_effort_timestamp_time") is not None
    ]
    if not timestamps:
        raise RuntimeError("The source has no decodable video presentation timestamps.")
    return timestamps


def infer_frame(
    *,
    server: str,
    model: str,
    frame_path: Path,
    confidence: float,
    iou_threshold: float,
    class_filter: list[str],
    request_id: str,
) -> dict:
    payload = {
        "class_filter": class_filter,
        "confidence": confidence,
        "disable_active_learning": True,
        "id": request_id,
        "image": {
            "type": "base64",
            "value": base64.b64encode(frame_path.read_bytes()).decode("ascii"),
        },
        "iou_threshold": iou_threshold,
        "model_id": model,
        "usage_billable": False,
    }
    request = Request(
        f"{server.rstrip('/')}/infer/object_detection",
        data=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urlopen(request, timeout=180) as response:
        return json.load(response)


def command_version(command: str, flag: str) -> str:
    executable = shutil.which(command)
    if not executable:
        raise RuntimeError(f"Required command is not available: {command}")
    result = subprocess.run(
        [executable, flag], check=True, capture_output=True, text=True
    )
    return result.stdout.splitlines()[0]


def git_commit() -> str:
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"], check=True, capture_output=True, text=True
    )
    return result.stdout.strip()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def is_sha256(value: str) -> bool:
    return len(value) == 64 and all(character in "0123456789abcdef" for character in value)


def write_jsonl(output, value: dict) -> None:
    output.write(json.dumps(value, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    sys.exit(main())
