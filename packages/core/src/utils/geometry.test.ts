import { describe, expect, it } from "vitest";

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
