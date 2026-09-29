#!/usr/bin/env python3
"""Freeze Patrick's confirmed anomaly tracks into semantic heatmap detections.

The input folder is deliberately external to the repo. The generated fixture
keeps scores, not colours, and only emits heat for tracker-confirmed anomalies.
"""

import argparse
import hashlib
import json
import shutil
from pathlib import Path

import numpy as np
from PIL import Image


FPS = 30000 / 1001
SCHEMA = "supervision-js.detection-frame-chunk-manifest"
SOURCE_WIDTH = 3600
SOURCE_HEIGHT = 1570
TRACK_LABELS = {5: "bolt", 23: "stick"}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def rect(xyxy: list[int]) -> dict[str, float]:
    x0, y0, x1, y1 = xyxy
    return {
        "x": (x0 + x1) / 2,
        "y": (y0 + y1) / 2,
        "width": x1 - x0,
        "height": y1 - y0,
    }


def heatmap_for_track(frame: dict, tracker_id: int, image: np.ndarray, threshold: float):
    matches = [
        spot for spot in frame["hot_spots"]
        if spot["part_of_anomaly"] == tracker_id
    ]
    if not matches:
        return None
    x0 = max(0, min(spot["xyxy"][0] for spot in matches) - 24)
    y0 = max(0, min(spot["xyxy"][1] for spot in matches) - 24)
    x1 = min(SOURCE_WIDTH, max(spot["xyxy"][2] for spot in matches) + 24)
    y1 = min(SOURCE_HEIGHT, max(spot["xyxy"][3] for spot in matches) + 24)
    crop = image[y0:y1, x0:x1]
    # A max over each 2x2 cell retains narrow peaks when the demo is displayed
    # at half source resolution. Pad only the last row/column of odd crops.
    padded = np.pad(crop, ((0, crop.shape[0] % 2), (0, crop.shape[1] % 2)))
    downsampled = padded.reshape(
        padded.shape[0] // 2, 2, padded.shape[1] // 2, 2
    ).max(axis=(1, 3))
    return {
        "bounds": rect([x0, y0, x1, y1]),
        "width": int(downsampled.shape[1]),
        "height": int(downsampled.shape[0]),
        "values": downsampled.reshape(-1).astype(int).tolist(),
        "valueScale": 1 / 65535,
        "threshold": threshold,
    }


def generate(source: Path, destination: Path, media: Path, frame_count: int):
    raw_file = source / "detections.json"
    data = json.loads(raw_file.read_text())
    assert data["model_id"] == "odysseus-vceuf/anomaly-in-pebbles-01-1-foundad-t1"
    assert data["video"]["width"] == SOURCE_WIDTH
    assert data["video"]["height"] == SOURCE_HEIGHT
    assert 0 < frame_count <= len(data["frames"])
    destination.mkdir(parents=True, exist_ok=True)
    (destination / "detections").mkdir(exist_ok=True)
    shutil.copy2(raw_file, destination / "raw-patrick-detections.json")
    shutil.copy2(media, destination / "pebbles-1800.mp4")

    frames = []
    detection_count = 0
    heatmap_count = 0
    for index in range(frame_count):
        original = data["frames"][index]
        assert original["frame"] == index
        heat_image = None
        if any(anomaly["state"] == "hit" for anomaly in original["anomalies"]):
            heat_image = np.asarray(
                Image.open(source / "heatmaps" / f"frame_{index:03d}.png")
            )
            assert heat_image.shape == (SOURCE_HEIGHT, SOURCE_WIDTH)
            assert heat_image.dtype == np.uint16
        detections = []
        for anomaly in original["anomalies"]:
            track_id = anomaly["tracker_id"]
            heatmap = (
                heatmap_for_track(original, track_id, heat_image, data["anomaly_threshold"])
                if heat_image is not None and anomaly["state"] == "hit"
                else None
            )
            detection = {
                "id": f"{index}:{track_id}",
                "trackerId": track_id,
                "className": TRACK_LABELS.get(track_id, "anomaly"),
                "rect": rect(anomaly["xyxy"]),
                "metadata": {
                    "state": anomaly["state"],
                    "peak": anomaly["peak"],
                    "source": "patrick-tracker",
                },
            }
            if heatmap is not None:
                detection["heatmap"] = heatmap
                heatmap_count += 1
            detections.append(detection)
        start = index / FPS
        frames.append({
            "frameIndex": index,
            "mediaTime": round(start, 7),
            "endTime": round((index + 1) / FPS, 7),
            "detections": detections,
        })
        detection_count += len(detections)

    chunks = []
    for chunk_index in range(int((frame_count - 1) / FPS) + 1):
        chunk_start = chunk_index
        chunk_end = min(chunk_index + 1, frame_count / FPS)
        selected = [
            frame for frame in frames
            if chunk_start <= frame["mediaTime"] < chunk_index + 1
        ]
        if not selected:
            continue
        filename = f"detections/{chunk_index:06d}.json"
        (destination / filename).write_text(
            json.dumps({"frames": selected}, separators=(",", ":")) + "\n"
        )
        chunks.append({
            "chunkIndex": chunk_index,
            "startTime": chunk_start,
            "endTime": chunk_end,
            "frameCount": len(selected),
            "src": filename,
        })

    manifest = {
        "schema": SCHEMA,
        "version": 1,
        "datasetId": "pebbles_anomaly_patrick_v1",
        "classNames": ["bolt", "stick"],
        "chunkDurationSeconds": 1,
        "chunks": chunks,
        "duration": frame_count / FPS,
        "frameCount": frame_count,
        "frameRate": FPS,
        "detectionCount": detection_count,
        "geometry": {
            "boxDetectionCount": detection_count,
            "keypointDetectionCount": 0,
            "maskDetectionCount": 0,
            "polygonDetectionCount": 0,
            "polylineDetectionCount": 0,
            "heatmapDetectionCount": heatmap_count,
        },
        "inference": {
            "frameRate": FPS,
            "modelId": data["model_id"],
            "sourceFile": "raw-patrick-detections.json",
            "missingFrameIndexes": [],
        },
        "provenance": {
            "rawSha256": sha256(raw_file),
            "mediaSha256": sha256(media),
            "sourceFrameCount": len(data["frames"]),
            "includedFrameCount": frame_count,
            "policy": "Only confirmed tracker anomalies are detections. Hit frames carry score crops from matching hot spots; coast frames carry boxes but no synthetic heat.",
            "raster": "16-bit stitched scalar PNG / 65535, cropped to matched hot spots + 24 px, 2x2 max pooled. Zero outside requested tiles is missing evidence, not a model score.",
        },
        "video": {
            "file": "pebbles-1800.mp4",
            "width": SOURCE_WIDTH,
            "height": SOURCE_HEIGHT,
            "frameRate": FPS,
            "duration": frame_count / FPS,
            "frameCount": frame_count,
            "firstTimestamp": 0,
        },
    }
    (destination / "detections.manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n"
    )
    meta = {
        "schema": "supervision-js.demo.fixture-meta",
        "version": 1,
        "datasetId": manifest["datasetId"],
        "displayName": "Pebbles anomaly (Patrick)",
        "inferenceLabel": "FoundAD + causal tracker",
        "sampleName": "pebbles_anomaly",
        "showInDemo": True,
        "media": {
            "file": "pebbles-1800.mp4",
            "loadingStatusLabel": "opening pebbles anomaly sample",
            "readyStatusLabel": "pebbles anomaly | 320 decodable frames",
        },
        "presentation": {
            "boxesEnabled": False,
            "heatmapsEnabled": True,
            "confidenceThreshold": 0,
            "labelsEnabled": False,
            "masksEnabled": False,
            "polygonsEnabled": False,
            "polylinesEnabled": False,
        },
    }
    (destination / "fixture.meta.json").write_text(
        json.dumps(meta, indent=2) + "\n"
    )
    print(f"Wrote {frame_count} frames, {detection_count} tracks, {heatmap_count} heatmaps")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--media", type=Path, required=True)
    parser.add_argument("--frame-count", type=int, required=True)
    args = parser.parse_args()
    generate(args.source, args.destination, args.media, args.frame_count)


if __name__ == "__main__":
    main()
