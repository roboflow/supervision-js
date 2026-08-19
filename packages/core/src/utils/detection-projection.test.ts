import { describe, expect, it } from "vitest";

import {
  DetectionMaskEncoding,
  KeypointVisibility,
  type DetectionFrame,
} from "#types/detections";
import {
  projectDetectionFrame,
  projectDetectionFrames,
} from "#utils/detection-projection";

describe("detection coordinate-space projection", () => {
  it("scales rectangles, polygons, polylines, and keypoints into the target space", () => {
    const frame: DetectionFrame = {
      coordinateSpace: { height: 360, width: 640 },
      detections: [
        {
          id: "a",
          keypoints: {
            edges: [[0, 1]],
            points: [
              { x: 10, y: 20 },
              { x: 30, y: 40 },
            ],
            visibility: [
              KeypointVisibility.Visible,
              KeypointVisibility.Occluded,
            ],
          },
          polygon: {
            points: [
              { x: 0, y: 0 },
              { x: 64, y: 36 },
            ],
          },
          polyline: {
            points: [
              { x: 4, y: 8 },
              { x: 8, y: 16 },
            ],
          },
          rect: { height: 36, width: 64, x: 320, y: 180 },
        },
      ],
      mediaTime: 1,
    };

    const projected = projectDetectionFrame(frame, {
      height: 720,
      width: 1280,
    });
    const [detection] = projected.detections;

    expect(projected.coordinateSpace).toEqual({ height: 720, width: 1280 });
    expect(detection?.rect).toEqual({ height: 72, width: 128, x: 640, y: 360 });
    expect(detection?.polygon?.points).toEqual([
      { x: 0, y: 0 },
      { x: 128, y: 72 },
    ]);
    expect(detection?.polyline?.points).toEqual([
      { x: 8, y: 16 },
      { x: 16, y: 32 },
    ]);
    expect(detection?.keypoints?.points).toEqual([
      { x: 20, y: 40 },
      { x: 60, y: 80 },
    ]);
    expect(detection?.keypoints?.edges).toEqual([[0, 1]]);
    expect(detection?.keypoints?.visibility).toEqual([
      KeypointVisibility.Visible,
      KeypointVisibility.Occluded,
    ]);
  });

  it("keeps mask coordinates on their intrinsic mask dimensions", () => {
    const mask = {
      counts: "abc",
      encoding: DetectionMaskEncoding.CompressedRle,
      height: 90,
      width: 160,
    } as const;
    const frame: DetectionFrame = {
      coordinateSpace: { height: 360, width: 640 },
      detections: [{ id: "a", mask }],
      mediaTime: 0,
    };

    const projected = projectDetectionFrame(frame, {
      height: 720,
      width: 1280,
    });

    expect(projected.detections[0]?.mask).toEqual(mask);
  });

  it("returns frames without coordinate metadata unchanged", () => {
    const frame: DetectionFrame = {
      detections: [{ id: "a", rect: { height: 10, width: 10, x: 5, y: 5 } }],
      mediaTime: 0,
    };

    expect(projectDetectionFrame(frame, { height: 720, width: 1280 })).toBe(
      frame,
    );
  });

  it("returns frames already in the target space unchanged", () => {
    const frame: DetectionFrame = {
      coordinateSpace: { height: 720, width: 1280 },
      detections: [{ id: "a", rect: { height: 10, width: 10, x: 5, y: 5 } }],
      mediaTime: 0,
    };

    expect(projectDetectionFrame(frame, { height: 720, width: 1280 })).toBe(
      frame,
    );
  });

  it("ignores degenerate source and target spaces", () => {
    const frame: DetectionFrame = {
      coordinateSpace: { height: 0, width: 640 },
      detections: [{ id: "a", rect: { height: 10, width: 10, x: 5, y: 5 } }],
      mediaTime: 0,
    };

    expect(projectDetectionFrame(frame, { height: 720, width: 1280 })).toBe(
      frame,
    );
    expect(
      projectDetectionFrame(
        { ...frame, coordinateSpace: { height: 360, width: 640 } },
        { height: 0, width: 1280 },
      ).detections[0]?.rect,
    ).toEqual({ height: 10, width: 10, x: 5, y: 5 });
  });

  it("projects mixed batches and keeps the original array when nothing changes", () => {
    const withSpace: DetectionFrame = {
      coordinateSpace: { height: 360, width: 640 },
      detections: [{ id: "a", rect: { height: 10, width: 10, x: 5, y: 5 } }],
      mediaTime: 0,
    };
    const withoutSpace: DetectionFrame = {
      detections: [{ id: "b", rect: { height: 10, width: 10, x: 5, y: 5 } }],
      mediaTime: 1,
    };
    const frames = [withSpace, withoutSpace];

    const projected = projectDetectionFrames(frames, {
      height: 720,
      width: 1280,
    });

    expect(projected[0]?.detections[0]?.rect).toEqual({
      height: 20,
      width: 20,
      x: 10,
      y: 10,
    });
    expect(projected[1]).toBe(withoutSpace);
    expect(
      projectDetectionFrames([withoutSpace], { height: 720, width: 1280 }),
    ).toEqual([withoutSpace]);
  });
});
