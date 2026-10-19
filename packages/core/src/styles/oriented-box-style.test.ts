import { describe, expect, it, vi } from "vitest";

import { BaseOrientedBoxStyle } from "#styles/oriented-box-style";
import type { Detection } from "#types/detections";

const rotatedPoints = [
  { x: 100, y: 60 },
  { x: 140, y: 90 },
  { x: 120, y: 140 },
  { x: 80, y: 110 },
] as const;
const detection: Detection = {
  orientedBox: { points: rotatedPoints },
};
const context = {
  detectionIndex: 0,
  frame: { detections: [detection], mediaTime: 0 },
  mediaTime: 0,
};

describe("BaseOrientedBoxStyle", () => {
  it("resolves a rotated quadrilateral with the default fill and stroke", () => {
    const style = new BaseOrientedBoxStyle();

    expect(style.resolve(detection, context)).toEqual({
      fill: { alpha: 0.16, color: 0x00ff66 },
      points: rotatedPoints,
      stroke: { alpha: 1, color: 0x00ff66, width: 2 },
    });
  });

  it("does not draw when there is no orientedBox geometry", () => {
    const style = new BaseOrientedBoxStyle();

    expect(style.resolve({}, context)).toBeUndefined();
  });

  it("does not draw a malformed geometry with fewer than four vertices", () => {
    const style = new BaseOrientedBoxStyle();
    // A real detection is typed to carry exactly four points, but this
    // guards the runtime path against a caller that skips the type system,
    // such as data deserialized from an untyped source.
    const malformed = {
      orientedBox: { points: rotatedPoints.slice(0, 3) },
    } as unknown as Detection;

    expect(style.resolve(malformed, context)).toBeUndefined();
  });

  it("does not draw a degenerate (zero-area) quadrilateral", () => {
    const style = new BaseOrientedBoxStyle();
    const collinear = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 0 },
      { x: 30, y: 0 },
    ] as const;

    expect(
      style.resolve({ orientedBox: { points: collinear } }, context),
    ).toBeUndefined();
  });

  it("does not draw when any vertex coordinate is non-finite (NaN or Infinity)", () => {
    const style = new BaseOrientedBoxStyle();
    // polygonArea(points) === 0 does not catch this: arithmetic on a NaN
    // coordinate produces NaN, and NaN === 0 is false, so a NaN vertex would
    // otherwise slip past the degenerate-area check and reach the renderer.
    const withNaN = [
      { x: Number.NaN, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ] as const;
    const withInfinity = [
      { x: 0, y: 0 },
      { x: Number.POSITIVE_INFINITY, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ] as const;

    expect(
      style.resolve({ orientedBox: { points: withNaN } }, context),
    ).toBeUndefined();
    expect(
      style.resolve({ orientedBox: { points: withInfinity } }, context),
    ).toBeUndefined();
  });

  it("does not draw when hidden or when shouldRender returns false", () => {
    const style = new BaseOrientedBoxStyle({ shouldRender: () => false });

    expect(style.resolve(detection, context)).toBeUndefined();
    expect(
      new BaseOrientedBoxStyle().resolve(detection, {
        ...context,
        hidden: true,
      }),
    ).toBeUndefined();
  });

  it("omits fill or stroke when explicitly disabled", () => {
    const style = new BaseOrientedBoxStyle({ fill: null, stroke: null });
    const resolved = style.resolve(detection, context);

    expect(resolved).toEqual({ points: rotatedPoints });
    expect(resolved).not.toHaveProperty("fill");
    expect(resolved).not.toHaveProperty("stroke");
  });

  it("uses per-detection fill and stroke resolvers", () => {
    const fill = vi.fn(() => ({ alpha: 0.4, color: 0xff00ff }));
    const stroke = vi.fn(() => ({ color: 0x123456, width: 4 }));
    const style = new BaseOrientedBoxStyle({ fill, stroke });

    expect(style.resolve(detection, context)).toEqual({
      fill: { alpha: 0.4, color: 0xff00ff },
      points: rotatedPoints,
      stroke: { alpha: 1, color: 0x123456, width: 4 },
    });
    expect(fill).toHaveBeenCalledWith(detection, context);
    expect(stroke).toHaveBeenCalledWith(detection, context);
  });
});
