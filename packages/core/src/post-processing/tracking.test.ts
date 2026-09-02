import { describe, expect, it } from "vitest";
import {
  DetectionMaskEncoding,
  type DetectionFrame,
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
        lostTrackBuffer: 12,
      }),
    ).toEqual({
      algorithm: "sort",
      geometry: "mask",
      kind: "tracking",
      options: {
        frameRate: 30,
        lostTrackBuffer: 12,
        minimumConsecutiveFrames: 3,
        minimumIouThreshold: 0.3,
        trackActivationThreshold: 0.25,
      },
    });
  });

  it("creates a serializable ByteTrack descriptor with Python defaults", () => {
    expect(
      detectionPostProcessors.tracking({ algorithm: "bytetrack" }),
    ).toEqual({
      algorithm: "bytetrack",
      geometry: "box",
      kind: "tracking",
      options: {
        frameRate: 30,
        highConfidenceDetectionThreshold: 0.6,
        lostTrackBuffer: 30,
        minimumConsecutiveFrames: 2,
        minimumIouThreshold: 0.1,
        trackActivationThreshold: 0.7,
      },
    });
  });

  it("creates a serializable C-BIoU descriptor with Python defaults", () => {
    expect(detectionPostProcessors.tracking({ algorithm: "cbiou" })).toEqual({
      algorithm: "cbiou",
      geometry: "box",
      kind: "tracking",
      options: {
        bufferRatioFirst: 0.3,
        bufferRatioSecond: 0.5,
        frameRate: 30,
        highConfidenceDetectionThreshold: 0.6,
        instantFirstFrameActivation: true,
        lostTrackBuffer: 30,
        minimumConsecutiveFrames: 2,
        minimumIouThresholdFirstAssociation: 0.2,
        minimumIouThresholdSecondAssociation: 0.5,
        minimumIouThresholdUnconfirmedAssociation: 0.3,
        trackActivationThreshold: 0.7,
      },
    });
  });

  it("creates a serializable OC-SORT descriptor with Python defaults", () => {
    expect(detectionPostProcessors.tracking({ algorithm: "ocsort" })).toEqual({
      algorithm: "ocsort",
      geometry: "box",
      kind: "tracking",
      options: {
        deltaT: 3,
        directionConsistencyWeight: 0.2,
        frameRate: 30,
        highConfidenceDetectionThreshold: 0.6,
        lostTrackBuffer: 30,
        minimumConsecutiveFrames: 3,
        minimumIouThreshold: 0.3,
      },
    });
  });

  it("projects only the selected geometry without copying heavy payloads", () => {
    const frame: DetectionFrame = {
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
        detectionIndex: 0,
        rect: { height: 6, width: 6, x: 5, y: 7 },
      },
    ]);
    expect(
      projectDetectionFrameForTracking(frame, TrackingGeometry.Mask)[0],
    ).not.toHaveProperty("mask");
  });
});
