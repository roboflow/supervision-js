import { describe, expect, it } from "vitest";

import { BaseOrientedBoxStyle } from "#styles/oriented-box-style";
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
          orientedBox: {
            points: [
              { x: 288, y: 162 },
              { x: 352, y: 162 },
              { x: 352, y: 198 },
              { x: 288, y: 198 },
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
    expect(detection?.orientedBox?.points).toEqual([
      { x: 576, y: 324 },
      { x: 704, y: 324 },
      { x: 704, y: 396 },
      { x: 576, y: 396 },
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

  it("scales a rotated oriented-box quadrilateral by independent axis factors", () => {
    // A 45-degree diamond around (100, 100) with a 20-pixel half-diagonal.
    const frame: DetectionFrame = {
      coordinateSpace: { height: 200, width: 200 },
      detections: [
        {
          id: "diamond",
          orientedBox: {
            points: [
              { x: 100, y: 80 },
              { x: 120, y: 100 },
              { x: 100, y: 120 },
              { x: 80, y: 100 },
            ],
          },
        },
      ],
      mediaTime: 0,
    };

    // A non-uniform target (2x horizontally, 3x vertically) stretches the
    // diamond into a non-square rotated quadrilateral, proving each vertex
    // scales along its own axis instead of a single uniform factor.
    const projected = projectDetectionFrame(frame, {
      height: 600,
      width: 400,
    });

    expect(projected.detections[0]?.orientedBox?.points).toEqual([
      { x: 200, y: 240 },
      { x: 240, y: 300 },
      { x: 200, y: 360 },
      { x: 160, y: 300 },
    ]);
  });

  it("keeps malformed oriented-box cardinality safely skippable through projection, not padded or truncated into apparently valid geometry", () => {
    // A real Detection is typed to carry exactly four oriented-box vertices,
    // but a caller that bypasses the type system (data deserialized from an
    // untyped source) can hand projection a different length. This is a
    // regression test for the *composed* path -- projectDetectionFrame
    // followed by BaseOrientedBoxStyle.resolve, not the style in isolation --
    // because scaleOrientedBox previously destructured into a synthetic
    // four-element tuple: three points padded a real `undefined` into the
    // fourth slot (crashing resolve() when it read `.x` off it), and five
    // points were silently truncated into a plausible-looking four-point box.
    const style = new BaseOrientedBoxStyle();
    const contextFor = (frame: DetectionFrame) => ({
      detectionIndex: 0,
      frame,
      mediaTime: 0,
    });

    const threePoints = {
      coordinateSpace: { height: 100, width: 100 },
      detections: [
        {
          orientedBox: {
            points: [
              { x: 0, y: 0 },
              { x: 10, y: 0 },
              { x: 10, y: 10 },
            ],
          },
        },
      ],
      mediaTime: 0,
    } as unknown as DetectionFrame;

    const fivePoints = {
      coordinateSpace: { height: 100, width: 100 },
      detections: [
        {
          orientedBox: {
            points: [
              { x: 0, y: 0 },
              { x: 10, y: 0 },
              { x: 10, y: 10 },
              { x: 0, y: 10 },
              { x: -1, y: 5 },
            ],
          },
        },
      ],
      mediaTime: 0,
    } as unknown as DetectionFrame;

    for (const frame of [threePoints, fivePoints]) {
      expect(() => {
        const projected = projectDetectionFrame(frame, {
          height: 200,
          width: 200,
        });
        return style.resolve(projected.detections[0]!, contextFor(projected));
      }).not.toThrow();

      const projected = projectDetectionFrame(frame, {
        height: 200,
        width: 200,
      });
      expect(
        style.resolve(projected.detections[0]!, contextFor(projected)),
      ).toBeUndefined();
    }
  });
});
