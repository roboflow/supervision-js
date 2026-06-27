import { describe, expect, it } from "vitest";

import {
  createDetectionPickKey,
  pickDetectionByMaskId,
  pickDetectionAtPoint,
} from "#interactions/detection-picker";
import { DetectionPickTarget } from "#types/interaction";
import type { DetectionFrame } from "#types/detections";

const frame: DetectionFrame = {
  detections: [
    {
      className: "person",
      id: "large",
      rect: { height: 100, width: 100, x: 0, y: 0 },
    },
    {
      className: "ball",
      id: "small",
      rect: { height: 10, width: 10, x: 45, y: 45 },
    },
  ],
  frameIndex: 12,
  mediaTime: 0.4,
};

describe("detection picker", () => {
  it("picks the smallest containing box so small objects win inside overlaps", () => {
    const pick = pickDetectionAtPoint(frame, { x: 50, y: 50 });

    expect(pick).toMatchObject({
      detection: expect.objectContaining({ id: "small" }),
      detectionIndex: 1,
      frame,
      mediaTime: frame.mediaTime,
      point: { x: 50, y: 50 },
      target: DetectionPickTarget.Box,
    });
  });

  it("supports padding around tiny boxes and creates stable pick keys", () => {
    const pick = pickDetectionAtPoint(frame, { x: 42, y: 42 }, { padding: 4 });

    expect(pick?.detection.id).toBe("small");
    expect(pick ? createDetectionPickKey(pick) : null).toBe(
      "12:0.4:small:1:box",
    );
  });

  it("returns null outside pickable detections", () => {
    expect(pickDetectionAtPoint(frame, { x: 120, y: 120 })).toBeNull();
  });

  it("picks the detection encoded by a prepared mask id", () => {
    const pick = pickDetectionByMaskId(frame, 2, { x: 47, y: 49 });

    expect(pick).toMatchObject({
      detection: expect.objectContaining({ id: "small" }),
      detectionIndex: 1,
      frame,
      mediaTime: frame.mediaTime,
      point: { x: 47, y: 49 },
      target: DetectionPickTarget.Mask,
    });
  });

  it("ignores background or out-of-range prepared mask ids", () => {
    expect(pickDetectionByMaskId(frame, 0, { x: 47, y: 49 })).toBeNull();
    expect(pickDetectionByMaskId(frame, 99, { x: 47, y: 49 })).toBeNull();
  });
});
