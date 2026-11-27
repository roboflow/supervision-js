import { describe, expect, it } from "vitest";

import { KeypointVisibility } from "#types/detections";
import {
  centerRectToTopLeftRect,
  distanceToSegment,
  getDetectionRect,
  pointInPolygon,
  polygonArea,
  topLeftRectToCenterRect,
} from "#utils/geometry";

describe("geometry utilities", () => {
  it("round-trips semantic center rects through top-left render rects", () => {
    const rect = { height: 20, width: 40, x: 30, y: 40 };

    expect(centerRectToTopLeftRect(rect)).toEqual({
      height: 20,
      width: 40,
      x: 10,
      y: 30,
    });
    expect(topLeftRectToCenterRect(centerRectToTopLeftRect(rect))).toEqual(
      rect,
    );
  });

  it("computes mixed geometry bounds", () => {
    expect(
      getDetectionRect({
        polygon: {
          points: [
            { x: 4, y: 8 },
            { x: 12, y: 2 },
            { x: 10, y: 16 },
          ],
        },
      }),
    ).toEqual({ height: 14, width: 8, x: 8, y: 9 });
  });

  it("falls back to a rotated oriented-box quadrilateral's axis-aligned bounds", () => {
    // A 45-degree diamond around (50, 50) with a 10-pixel half-diagonal.
    expect(
      getDetectionRect({
        orientedBox: {
          points: [
            { x: 50, y: 40 },
            { x: 60, y: 50 },
            { x: 50, y: 60 },
            { x: 40, y: 50 },
          ],
        },
      }),
    ).toEqual({ height: 20, width: 20, x: 50, y: 50 });
  });

  it("prefers rect and polygon over an oriented box, and an oriented box over polyline or keypoints", () => {
    const orientedBox = {
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ],
    } as const;

    expect(
      getDetectionRect({
        orientedBox,
        rect: { height: 4, width: 4, x: 2, y: 2 },
      }),
    ).toEqual({ height: 4, width: 4, x: 2, y: 2 });
    expect(
      getDetectionRect({
        orientedBox,
        polyline: {
          points: [
            { x: 90, y: 90 },
            { x: 99, y: 99 },
          ],
        },
      }),
    ).toEqual({ height: 10, width: 10, x: 5, y: 5 });
  });

  it("ignores NotLabeled keypoints when falling back to keypoint bounds", () => {
    expect(
      getDetectionRect({
        keypoints: {
          edges: [],
          points: [
            { x: 600, y: 400 },
            { x: 700, y: 500 },
            { x: 0, y: 0 },
            { x: 650, y: 450 },
          ],
          visibility: [
            KeypointVisibility.Visible,
            KeypointVisibility.Occluded,
            KeypointVisibility.NotLabeled,
            KeypointVisibility.Visible,
          ],
        },
      }),
    ).toEqual({ height: 100, width: 100, x: 650, y: 450 });
  });

  it("keeps keypoints that have no visibility entry in the bounds", () => {
    expect(
      getDetectionRect({
        keypoints: {
          edges: [],
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 20 },
          ],
        },
      }),
    ).toEqual({ height: 20, width: 10, x: 5, y: 10 });
  });

  it("has no keypoint bounds when every keypoint is NotLabeled", () => {
    const keypoints = {
      edges: [],
      points: [
        { x: 0, y: 0 },
        { x: 0, y: 0 },
      ],
      visibility: [
        KeypointVisibility.NotLabeled,
        KeypointVisibility.NotLabeled,
      ],
    };

    expect(getDetectionRect({ keypoints })).toBeUndefined();
    expect(
      getDetectionRect({
        keypoints,
        rect: { height: 4, width: 4, x: 2, y: 2 },
      }),
    ).toEqual({ height: 4, width: 4, x: 2, y: 2 });
  });

  it("has no keypoint bounds when NotLabeled points hold real coordinates", () => {
    expect(
      getDetectionRect({
        keypoints: {
          edges: [],
          points: [
            { x: 50, y: 60 },
            { x: 70, y: 80 },
          ],
          visibility: [
            KeypointVisibility.NotLabeled,
            KeypointVisibility.NotLabeled,
          ],
        },
      }),
    ).toBeUndefined();
  });

  it("collapses to a zero-size rect when one labeled keypoint remains", () => {
    expect(
      getDetectionRect({
        keypoints: {
          edges: [],
          points: [
            { x: 600, y: 400 },
            { x: 0, y: 0 },
            { x: 0, y: 0 },
          ],
          visibility: [
            KeypointVisibility.Visible,
            KeypointVisibility.NotLabeled,
            KeypointVisibility.NotLabeled,
          ],
        },
      }),
    ).toEqual({ height: 0, width: 0, x: 600, y: 400 });
  });

  it("uses even-odd polygon containment", () => {
    const polygon = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];

    expect(pointInPolygon({ x: 5, y: 5 }, polygon)).toBe(true);
    expect(pointInPolygon({ x: 15, y: 5 }, polygon)).toBe(false);
    expect(polygonArea(polygon)).toBe(100);
  });

  it("measures distance to the nearest point on a segment", () => {
    expect(
      distanceToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 }),
    ).toBe(3);
  });
});
