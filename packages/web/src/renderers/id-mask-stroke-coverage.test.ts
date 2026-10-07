import { describe, expect, it } from "vitest";

import {
  idMaskStrokeCoverageGlsl,
  idMaskStrokeCoverageWgsl,
} from "#renderers/id-mask-stroke-coverage";

describe.each([
  ["WebGL", idMaskStrokeCoverageGlsl],
  ["WebGPU", idMaskStrokeCoverageWgsl],
])("%s fractional mask border", (_backend, source) => {
  const coverage = shaderScalar(source, "subtexelStrokeCoverage", [
    "distance",
    "width",
    "pixelWidth",
  ]);
  const distance = shaderScalar(source, "neighborCellDistance", [
    "offset",
    "position",
  ]);
  const radius = shaderScalar(source, "strokeScanRadius", [
    "maxWidth",
    "fractionalWidth",
    "pixelWidth",
  ]);

  it("keeps a half-texel border within two screen pixels on either side", () => {
    const pixelCenters = [0.125, 0.375, 0.625, 0.875];
    const inside = pixelCenters.map((position) =>
      coverage(position, 0.5, 0.25),
    );
    const outside = pixelCenters.map((position) =>
      coverage(distance(-1, position), 0.5, 0.25),
    );

    expect(inside).toEqual([1, 1, 0, 0]);
    expect(outside).toEqual([1, 1, 0, 0]);
  });

  it("blends the fractional edge over one screen pixel", () => {
    expect(coverage(0.375, 0.5, 0.25)).toBe(1);
    expect(coverage(0.5, 0.5, 0.25)).toBe(0.5);
    expect(coverage(0.625, 0.5, 0.25)).toBe(0);
  });

  it("lets a stroke narrower than a screen pixel fade to zero", () => {
    expect(coverage(0.125, 0.0001, 0.25) * 2).toBeCloseTo(0.0008, 8);
    expect(coverage(0, 0, 0.25)).toBe(0);
    expect(coverage(0.125, 0, 0.25)).toBe(0);
  });

  it("finds the cell edge on either side and at an outer corner", () => {
    expect(distance(1, 0.875)).toBe(0.125);
    expect(distance(-1, 0.125)).toBe(0.125);
    expect(distance(0, 0.375)).toBe(0);
    expect(Math.max(distance(1, 0.875), distance(-1, 0.25))).toBe(0.25);
  });

  it("includes an antialias fringe without widening an ordinary fine scan", () => {
    expect(radius(0.5, 0.5, 0.25)).toBe(1);
    expect(radius(0.99, 0.99, 0.25)).toBe(2);
    expect(radius(1.9814, 0, 1)).toBe(1);
    expect(radius(4.1, 0, 1)).toBe(4);
    expect(radius(40, 0, 1)).toBe(16);
    expect(radius(40, 0.99, 1)).toBe(16);
  });
});

function shaderScalar(source: string, name: string, parameters: string[]) {
  const start = source.indexOf("{", source.indexOf(`${name}(`));
  let depth = 1;
  let end = start + 1;
  for (; depth > 0 && end < source.length; end += 1) {
    if (source[end] === "{") depth += 1;
    if (source[end] === "}") depth -= 1;
  }
  const run = new Function(
    ...parameters,
    "clamp",
    "max",
    "min",
    "floor",
    "ceil",
    source.slice(start + 1, end - 1),
  );
  const clamp = (value: number, low: number, high: number) =>
    Math.min(high, Math.max(low, value));

  return (...values: number[]): number =>
    run(...values, clamp, Math.max, Math.min, Math.floor, Math.ceil) as number;
}
