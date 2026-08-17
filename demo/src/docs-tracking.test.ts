import { describe, expect, it } from "vitest";
import {
  DetectionMaskEncoding,
  DetectionTrackerState,
  TrackingGeometry,
  type Detection,
} from "supervision";
import { createDocsTrackingPresentation } from "./docs-tracking";

describe("docs tracking presentation", () => {
  it("renders untracked raw detections for every selectable geometry", () => {
    const rawDetection: Detection = {
      className: "yellow team player",
      keypoints: {
        edges: [[0, 1]],
        points: [
          { x: 20, y: 30 },
          { x: 22, y: 42 },
        ],
      },
      mask: {
        counts: "021",
        encoding: DetectionMaskEncoding.CompressedRle,
        height: 2,
        width: 2,
      },
      rect: { height: 40, width: 20, x: 30, y: 40 },
    };
    const context = styleContext(rawDetection);

    const boxes = createDocsTrackingPresentation(TrackingGeometry.Box, "raw");
    const masks = createDocsTrackingPresentation(TrackingGeometry.Mask, "raw");
    const keypoints = createDocsTrackingPresentation(
      TrackingGeometry.Keypoints,
      "raw",
    );

    expect(boxes.boxStyle?.resolve(rawDetection, context)).toBeDefined();
    expect(boxes.labelStyle?.resolve(rawDetection, context)?.text).toBe(
      "yellow team player",
    );
    expect(masks.maskStyle?.resolve(rawDetection, context)).toBeDefined();
    expect(
      keypoints.keypointStyle?.resolve(rawDetection, context),
    ).toBeDefined();
  });

  it("renders only identified detections in the tracked presentation", () => {
    const rawDetection: Detection = {
      className: "player",
      rect: { height: 40, width: 20, x: 30, y: 40 },
    };
    const trackedDetection: Detection = {
      ...rawDetection,
      trackerId: 7,
      trackerState: DetectionTrackerState.Observed,
    };
    const predictedDetection: Detection = {
      ...rawDetection,
      trackerAge: 2,
      trackerId: 7,
      trackerState: DetectionTrackerState.Predicted,
    };
    const trackedBoxes = createDocsTrackingPresentation(
      TrackingGeometry.Box,
      "tracked",
    );
    const trackedMasks = createDocsTrackingPresentation(
      TrackingGeometry.Mask,
      "tracked",
    );

    expect(
      trackedBoxes.boxStyle?.resolve(rawDetection, styleContext(rawDetection)),
    ).toBeUndefined();
    expect(
      trackedBoxes.labelStyle?.resolve(
        trackedDetection,
        styleContext(trackedDetection),
      )?.text,
    ).toBe("player #7");
    expect(
      trackedMasks.boxStyle?.resolve(
        predictedDetection,
        styleContext(predictedDetection),
      ),
    ).toBeDefined();
    expect(
      trackedMasks.labelStyle?.resolve(
        predictedDetection,
        styleContext(predictedDetection),
      )?.text,
    ).toBe("player #7 · predicted +2f");
  });
});

function styleContext(detection: Detection) {
  return {
    detectionIndex: 0,
    frame: { detections: [detection], mediaTime: 0 },
    mediaTime: 0,
  };
}
