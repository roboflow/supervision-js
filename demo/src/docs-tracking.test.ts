import { describe, expect, it } from "vitest";
import {
  DetectionInteractionState,
  DetectionMaskEncoding,
  DetectionPickTarget,
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
    };
    const trackedBoxes = createDocsTrackingPresentation(
      TrackingGeometry.Box,
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
      trackedBoxes.boxStyle?.resolve(
        trackedDetection,
        styleContext(trackedDetection),
      )?.stroke?.dash,
    ).toBeUndefined();
  });

  it("highlights masks through their class-colored silhouette", () => {
    const detection: Detection = {
      className: "yellow team player",
      mask: {
        counts: "021",
        encoding: DetectionMaskEncoding.CompressedRle,
        height: 2,
        width: 2,
      },
      rect: { height: 40, width: 20, x: 30, y: 40 },
      trackerId: 7,
    };
    const presentation = createDocsTrackingPresentation(
      TrackingGeometry.Mask,
      "tracked",
    );
    const context = styleContext(detection);
    const hover = presentation.interactionStyle?.resolve(detection, {
      ...context,
      point: { x: 35, y: 45 },
      state: DetectionInteractionState.Hovered,
      target: DetectionPickTarget.Mask,
    });
    const renderedMask = presentation.maskStyle?.resolve(detection, context);
    const hoveredMask = hover?.maskStyle?.resolve(detection, context);

    expect(hover?.boxStyle).toBeNull();
    expect(hoveredMask?.stroke?.color).toBe(renderedMask?.stroke?.color);
    expect(hoveredMask?.stroke?.width).toBeGreaterThan(
      renderedMask?.stroke?.width ?? 0,
    );
  });
});

function styleContext(detection: Detection) {
  return {
    detectionIndex: 0,
    frame: { detections: [detection], mediaTime: 0 },
    mediaTime: 0,
  };
}
