import { describe, expect, it } from "vitest";

import { MarkerShape, MarkerSizeSpace } from "#types/shape-style";
import { resolveMarkerGeometry, sampleEllipseArc } from "#utils/shape-geometry";

describe("shape geometry", () => {
  it("samples a closed ellipse without repeating the first point", () => {
    const { closed, points } = sampleEllipseArc(
      { center: { x: 10, y: 20 }, radiusX: 4, radiusY: 2 },
      16,
    );

    expect(closed).toBe(true);
    expect(points).toHaveLength(16);
    expect(points[0]).toEqual({ x: 14, y: 20 });
    expect(points[4]!.x).toBeCloseTo(10);
    expect(points[4]!.y).toBeCloseTo(22);
    expect(points[8]!.x).toBeCloseTo(6);
    expect(points[8]!.y).toBeCloseTo(20);
  });

  it("samples an open arc including both endpoints", () => {
    const { closed, points } = sampleEllipseArc(
      {
        center: { x: 0, y: 0 },
        endAngle: Math.PI,
        radiusX: 5,
        radiusY: 5,
        startAngle: 0,
      },
      8,
    );

    expect(closed).toBe(false);
    expect(points).toHaveLength(9);
    expect(points[0]!.x).toBeCloseTo(5);
    expect(points[0]!.y).toBeCloseTo(0);
    expect(points[8]!.x).toBeCloseTo(-5);
    expect(points[8]!.y).toBeCloseTo(0);
  });

  it("rotates sampled ellipse points around the center", () => {
    const { points } = sampleEllipseArc(
      {
        center: { x: 0, y: 0 },
        radiusX: 4,
        radiusY: 2,
        rotation: Math.PI / 2,
      },
      4,
    );

    expect(points[0]!.x).toBeCloseTo(0);
    expect(points[0]!.y).toBeCloseTo(4);
  });

  it("is deterministic for identical inputs", () => {
    const options = {
      center: { x: 3, y: 7 },
      endAngle: 4.1,
      radiusX: 9,
      radiusY: 5,
      rotation: 0.3,
      startAngle: -0.8,
    };

    expect(sampleEllipseArc(options)).toEqual(sampleEllipseArc(options));
  });

  it("divides screen-space marker sizes by the viewport scale", () => {
    const geometry = resolveMarkerGeometry(
      {
        point: { x: 0, y: 0 },
        shape: MarkerShape.Circle,
        size: 12,
        sizeSpace: MarkerSizeSpace.Screen,
      },
      2,
    );

    expect(geometry).toEqual({
      center: { x: 0, y: 0 },
      kind: "circle",
      radius: 3,
    });
  });

  it("keeps media-space marker sizes unscaled", () => {
    const geometry = resolveMarkerGeometry(
      {
        point: { x: 0, y: 0 },
        shape: MarkerShape.Circle,
        size: 12,
        sizeSpace: MarkerSizeSpace.Media,
      },
      2,
    );

    expect(geometry).toEqual({
      center: { x: 0, y: 0 },
      kind: "circle",
      radius: 6,
    });
  });

  it("builds a downward-pointing triangle at rotation zero", () => {
    const geometry = resolveMarkerGeometry({
      point: { x: 10, y: 10 },
      shape: MarkerShape.Triangle,
      size: 8,
      sizeSpace: MarkerSizeSpace.Media,
    });

    expect(geometry.kind).toBe("subpaths");

    if (geometry.kind !== "subpaths") return;

    expect(geometry.closed).toBe(true);
    const [apex, right, left] = geometry.subpaths[0]!;
    expect(apex).toEqual({ x: 10, y: 14 });
    expect(right!.y).toBeCloseTo(8);
    expect(left!.y).toBeCloseTo(8);
    expect(right!.x).toBeGreaterThan(10);
    expect(left!.x).toBeLessThan(10);
  });

  it("builds crosses as two open diagonal subpaths", () => {
    const geometry = resolveMarkerGeometry({
      point: { x: 0, y: 0 },
      shape: MarkerShape.Cross,
      size: 10,
      sizeSpace: MarkerSizeSpace.Media,
    });

    expect(geometry.kind).toBe("subpaths");

    if (geometry.kind !== "subpaths") return;

    expect(geometry.closed).toBe(false);
    expect(geometry.subpaths).toHaveLength(2);
    expect(geometry.subpaths[0]).toEqual([
      { x: -5, y: -5 },
      { x: 5, y: 5 },
    ]);
  });

  it("rotates square markers around the anchor", () => {
    const geometry = resolveMarkerGeometry({
      point: { x: 0, y: 0 },
      rotation: Math.PI / 4,
      shape: MarkerShape.Square,
      size: 10,
      sizeSpace: MarkerSizeSpace.Media,
    });

    if (geometry.kind !== "subpaths") throw new Error("expected subpaths");

    const corner = geometry.subpaths[0]![0]!;
    expect(corner.x).toBeCloseTo(0);
    expect(corner.y).toBeCloseTo(-Math.SQRT2 * 5);
  });
});
