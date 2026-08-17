import { describe, expect, it } from "vitest";
import {
  DetectionMaskEncoding,
  DetectionTrackerState,
} from "../types/detections";
import { TrackingGeometry } from "../types/post-processing";
import {
  detectionPostProcessors,
  projectDetectionFrameForTracking,
} from "./tracking";

describe("detectionPostProcessors.tracking", () => {
  it("creates a serializable SORT descriptor", () => {
    expect(
      detectionPostProcessors.tracking({
        geometry: TrackingGeometry.Mask,
        maxAge: 12,
      }),
    ).toEqual({
      algorithm: "sort",
      geometry: "mask",
      kind: "tracking",
      options: {
        emitPredictions: true,
        iouThreshold: 0.3,
        matchByClass: true,
        maxAge: 12,
        minHits: 3,
      },
    });
  });

  it("projects only the selected geometry without copying heavy payloads", () => {
    const frame = {
      detections: [
        {
          className: "person",
          keypoints: {
            edges: [],
            points: [
              { x: 2, y: 4 },
              { x: 8, y: 10 },
            ],
          },
          mask: {
            counts: "11",
            encoding: DetectionMaskEncoding.CompressedRle,
            height: 2,
            width: 2,
          },
          rect: { height: 8, width: 6, x: 5, y: 7 },
        },
      ],
      frameIndex: 0,
      mediaTime: 0,
    };

    expect(
      projectDetectionFrameForTracking(frame, TrackingGeometry.Keypoints),
    ).toEqual([
      {
        className: "person",
        detectionIndex: 0,
        rect: { height: 6, width: 6, x: 5, y: 7 },
      },
    ]);
    expect(
      projectDetectionFrameForTracking(frame, TrackingGeometry.Mask)[0],
    ).not.toHaveProperty("mask");
  });

  it("does not feed materialized predictions back into the tracker", () => {
    const frame = {
      detections: [
        {
          rect: { height: 10, width: 10, x: 10, y: 10 },
        },
        {
          rect: { height: 10, width: 10, x: 20, y: 10 },
          trackerState: DetectionTrackerState.Predicted,
        },
      ],
      frameIndex: 0,
      mediaTime: 0,
    };

    expect(
      projectDetectionFrameForTracking(frame, TrackingGeometry.Box),
    ).toEqual([
      {
        detectionIndex: 0,
        rect: { height: 10, width: 10, x: 10, y: 10 },
      },
    ]);
  });
});
