import { describe, expect, it } from "vitest";

import {
  idMaskStrokeCoverageGlsl,
  idMaskStrokeCoverageWgsl,
} from "#renderers/id-mask-stroke-coverage";

describe.each([
  ["WebGL", idMaskStrokeCoverageGlsl],
  ["WebGPU", idMaskStrokeCoverageWgsl],
])("%s mask border coverage", (_backend, source) => {
  const bandCoverage = shaderScalar(source, "subtexelStrokeCoverage", [
    "distance",
    "width",
    "alignment",
    "pixelWidth",
  ]);
  const coverage = (distance: number, radius: number, footprint: number) =>
    bandCoverage(distance, radius * 2, 0.5, footprint);
  const distance = shaderScalar(source, "neighborCellDistance", [
    "offset",
    "position",
  ]);
  const radius = shaderScalar(source, "strokeScanRadius", [
    "maxWidth",
    "pixelWidth",
  ]);

  it("keeps IDs and fractional coverage on the same cell at float32 UV seams", () => {
    const height = 192;
    const uv = Math.fround(25 / height);
    const position = Math.fround(uv * height);
    const sourceY = Math.floor(position);
    const legacyNeighbor = Math.floor(
      Math.fround(Math.fround(uv - Math.fround(1 / height)) * height),
    );
    expect(position).toBe(25);
    expect(legacyNeighbor).toBe(23);
    const sample = sampler(source, { width: 256, height }, (_x, y) =>
      y >= 24 && y < 52 ? 1 : 0,
    );
    expect(sample({ x: 40, y: sourceY })).toBe(1);
    expect(sample({ x: 40, y: sourceY - 1 })).toBe(1);
    const result = runStrokeKernel(source, {
      centerId: sample({ x: 40, y: sourceY }),
      alignment: 0,
      cell: { x: 0.5, y: position - sourceY },
      width: 1,
      strokePixelRatio: 4,
      pixelWidth: 1 / 3,
      sample: (x, y) => sample({ x: 40 + x, y: sourceY + y }),
    });
    expect(result.coverage).toBe(0);
  });

  it("clamps exact categorical fetches at texture edges and retains distinct IDs", () => {
    const sample = sampler(
      source,
      { width: 3, height: 2 },
      (x, y) => 1 + y * 3 + x,
    );
    expect(sample({ x: -1, y: -1 })).toBe(1);
    expect(sample({ x: 1, y: 0 })).toBe(2);
    expect(sample({ x: 2, y: 0 })).toBe(3);
    expect(sample({ x: 1, y: 1 })).toBe(5);
    expect(sample({ x: 30, y: 20 })).toBe(6);
  });

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

  it("includes partial cells for every width and bounds the scan", () => {
    expect(radius(0, 1)).toBe(1);
    expect(radius(0.5, 0.25)).toBe(1);
    expect(radius(0.99, 0.25)).toBe(2);
    expect(radius(1.9814, 1)).toBe(3);
    expect(radius(4.1, 1)).toBe(5);
    expect(radius(40, 1)).toBe(17);
  });

  it("keeps the same physical border on both sides at different raster densities", () => {
    const points = Array.from(
      { length: 32 },
      (_, index) => -3.875 + index * 0.25,
    );
    const expected = points.map((point) => coverage(Math.abs(point), 2, 0.5));

    for (const density of [0.25, 0.5, 1, 2]) {
      const rendered = points.map((point) => {
        const x = point * density;
        const column = Math.floor(x);
        return runStrokeKernel(source, {
          centerId: point < 0 ? 0 : 1,
          cell: { x: x - column, y: 0.5 },
          width: 2 * density,
          pixelWidth: 0.5 * density,
          sample: (offsetX) => (column + offsetX < 0 ? 0 : 1),
        }).coverage;
      });
      expect(rendered).toEqual(expected);
    }
  });

  it("extends the inner stroke past one boundary cell", () => {
    expect(
      runStrokeKernel(source, {
        centerId: 1,
        cell: { x: 0.5, y: 0.5 },
        width: 2,
        pixelWidth: 0.25,
        sample: (offsetX) => (1 + offsetX < 0 ? 0 : 1),
      }).coverage,
    ).toBe(1);
  });

  it("keeps a fractional outer edge when the width exceeds one texel", () => {
    expect(
      runStrokeKernel(source, {
        centerId: 0,
        cell: { x: 0.5, y: 0.5 },
        width: 1.5,
        pixelWidth: 0.25,
        sample: (offsetX) => (-2 + offsetX < 0 ? 0 : 1),
      }).coverage,
    ).toBe(0.5);
  });

  it("uses the closest cell of the chosen detection instead of a faint diagonal", () => {
    expect(
      runStrokeKernel(source, {
        centerId: 0,
        cell: { x: 0.9, y: 0.5 },
        width: 0.5,
        pixelWidth: 0.25,
        sample: (offsetX) => (offsetX >= 1 ? 1 : 0),
      }).coverage,
    ).toBe(1);
  });

  it("covers an inner diagonal boundary and stops after full coverage", () => {
    const diagonal = runStrokeKernel(source, {
      centerId: 1,
      cell: { x: 0.75, y: 0.75 },
      width: 0.5,
      pixelWidth: 0.25,
      sample: (offsetX, offsetY) => (offsetX === 1 && offsetY === 1 ? 0 : 1),
    });
    expect(diagonal.coverage).toBe(1);
    expect(diagonal.lookups).toBe(1);
  });

  it("keeps the center detection's border at an overlapping ID boundary", () => {
    expect(
      runStrokeKernel(source, {
        centerId: 1,
        cell: { x: 0.75, y: 0.75 },
        width: 0.5,
        pixelWidth: 0.25,
        sample: (offsetX, offsetY) => (offsetX === 1 && offsetY === 1 ? 2 : 1),
      }).coverage,
    ).toBe(1);
  });

  it("retains descending outer palette priority and skips invisible strokes", () => {
    const fixture = {
      centerId: 0,
      cell: { x: 0.5, y: 0.5 },
      width: 1,
      pixelWidth: 0.25,
      sample: (offsetX: number, offsetY: number) =>
        offsetY === 0 && offsetX === 1
          ? 2
          : offsetY === 0 && offsetX === -1
            ? 1
            : 0,
    };
    expect(runStrokeKernel(source, fixture).id).toBe(2);
    expect(
      runStrokeKernel(source, { ...fixture, alpha: (id) => (id === 2 ? 0 : 1) })
        .id,
    ).toBe(1);
    expect(
      runStrokeKernel(source, {
        ...fixture,
        strokeWidth: (id) => (id === 2 ? 0 : 1),
      }).id,
    ).toBe(1);
  });

  it("preserves total CSS widths 1–4 across fit, DPR, AA and pixel phases", () => {
    for (const width of [1, 2, 3, 4]) {
      for (const alignment of [0, 0.5, 1]) {
        for (const rasterDensity of [0.5, 1, 2]) {
          for (const strokePixelRatio of [1, 2, 4]) {
            for (const phase of [0, 0.5]) {
              let total = 0;
              for (let index = 0; index < 16 * strokePixelRatio; index += 1) {
                const cssX = -8 + (index + 0.5 + phase) / strokePixelRatio;
                const rasterX = cssX * rasterDensity;
                const column = Math.floor(rasterX);
                const point = -cssX;
                const pixelMin = point - 0.5 / strokePixelRatio;
                const pixelMax = point + 0.5 / strokePixelRatio;
                const expected =
                  Math.max(
                    0,
                    Math.min(width * (1 - alignment), pixelMax) -
                      Math.max(-width * alignment, pixelMin),
                  ) * strokePixelRatio;
                const actual = runStrokeKernel(source, {
                  alignment,
                  centerId: column < 0 ? 0 : 1,
                  cell: { x: rasterX - column, y: 0.5 },
                  pixelWidth: rasterDensity / strokePixelRatio,
                  sample: (x) => (column + x < 0 ? 0 : 1),
                  strokePixelRatio,
                  width,
                });
                expect(actual.coverage).toBeCloseTo(expected, 10);
                total += actual.coverage / strokePixelRatio;
              }
              expect(total).toBeCloseTo(width, 10);
            }
          }
        }
      }
    }
  });

  it("reports the bounded width at dense capture resolutions", () => {
    const widthInTexels = shaderScalar(
      source,
      "strokeWidthInTexels",
      ["maskId", "pixelWidth"],
      {
        readStrokeAlignment: () => 0,
        readStrokeWidth: () => 4,
        uStrokePixelRatio: 8,
        maskUniforms: { uStrokePixelRatio: 8 },
      },
    );
    expect(widthInTexels(1, 1)).toBe(16);
    expect(widthInTexels(1, 1) / 8).toBe(2);
  });

  it("does no sampling for zero width and never scans beyond the bound", () => {
    const fixture = {
      centerId: 1,
      cell: { x: 0.5, y: 0.5 },
      width: 0,
      pixelWidth: 0.25,
      sample: () => 1,
    };
    expect(runStrokeKernel(source, fixture)).toMatchObject({
      coverage: 0,
      lookups: 0,
    });
    const offsets: number[] = [];
    const wide = runStrokeKernel(source, {
      ...fixture,
      width: 16,
      sample: (x, y) => {
        offsets.push(Math.abs(x), Math.abs(y));
        return 1;
      },
    });
    expect(wide.coverage).toBe(0);
    expect(Math.max(...offsets)).toBe(16);
    expect(wide.lookups).toBeLessThanOrEqual(33 * 33 - 1);
  });
});

function shaderBody(source: string, name: string) {
  const start = source.indexOf("{", source.indexOf(`${name}(`));
  let depth = 1;
  let end = start + 1;
  for (; depth > 0 && end < source.length; end += 1) {
    if (source[end] === "{") depth += 1;
    if (source[end] === "}") depth -= 1;
  }
  return source.slice(start + 1, end - 1);
}

function sampler(
  source: string,
  dimensions: { width: number; height: number },
  read: (x: number, y: number) => number,
) {
  const uTextureSize = { x: dimensions.width, y: dimensions.height };
  const load = (_texture: unknown, cell: { x: number; y: number }) => ({
    r: read(cell.x, cell.y) / 255,
  });
  return shaderScalar(source, "sampleMaskIdCell", ["cell"], {
    uTexture: null,
    uTextureSize,
    maskUniforms: { uTextureSize },
    int: Math.trunc,
    i32: Math.trunc,
    ivec2: (x: number, y: number) => ({ x, y }),
    texelFetch: load,
    textureLoad: load,
  });
}

function shaderScalar(
  source: string,
  name: string,
  parameters: string[],
  extra: Record<string, unknown> = {},
) {
  const run = new Function(
    ...parameters,
    ...Object.keys(extra),
    "clamp",
    "max",
    "min",
    "floor",
    "ceil",
    shaderBody(source, name)
      .replace(/\b(?:float|int)\s+(\w+)\s*=/g, "let $1 =")
      .replace(/vec2<i32>/g, "ivec2"),
  );
  const clamp = (value: number, low: number, high: number) =>
    Math.min(high, Math.max(low, value));

  return (...values: unknown[]): number =>
    run(
      ...values,
      ...Object.values(extra),
      clamp,
      Math.max,
      Math.min,
      Math.floor,
      Math.ceil,
    ) as number;
}

type StrokeKernelOptions = {
  centerId: number;
  cell: { x: number; y: number };
  width: number;
  alignment?: number;
  strokePixelRatio?: number;
  pixelWidth: number;
  sample: (x: number, y: number) => number;
  alpha?: (id: number) => number;
  strokeWidth?: (id: number) => number;
};

function runStrokeKernel(source: string, options: StrokeKernelOptions) {
  const name =
    options.centerId > 0 ? "innerStrokeCoverage" : "findNeighborStroke";
  const body = shaderBody(source, name)
    .replace(
      /sampleMaskIdCell\(sourceCell \+ (?:ivec2|vec2<i32>)\(offsetX, offsetY\)\)/g,
      "sampleMaskId(offsetX, offsetY)",
    )
    .replace(/\b(?:float|int|vec2|let|var)\s+(\w+)\s*=/g, "let $1 =")
    .replace(/vec2<f32>/g, "vec2");
  let lookups = 0;
  const alignment = options.alignment ?? 0.5;
  const strokePixelRatio = options.strokePixelRatio ?? 1;
  const cssScale =
    options.alignment === undefined
      ? 2 / (options.pixelWidth * strokePixelRatio)
      : 1;
  const palette = {
    uBorderEnabled: options.width > 0 ? 1 : 0,
    uMaxStrokeWidth: options.width * cssScale * (1 - alignment),
    uStrokePixelRatio: strokePixelRatio,
  };
  const extras = {
    ...palette,
    maskUniforms: palette,
    readStrokeWidth: (id: number) =>
      (options.strokeWidth?.(id) ?? options.width) * cssScale,
    readStrokeAlignment: () => alignment,
  };
  const resolveWidth = shaderScalar(
    source,
    "strokeWidthInTexels",
    ["maskId", "pixelWidth"],
    extras,
  );
  const globals = {
    ...extras,
    centerId: options.centerId,
    cell: options.cell,
    width: resolveWidth(options.centerId, options.pixelWidth),
    pixelWidth: options.pixelWidth,
    sampleMaskId: (x: number, y: number) => {
      lookups += 1;
      return options.sample(x, y);
    },
    readStroke: (id: number) => ({ a: options.alpha?.(id) ?? 1 }),
    differs: (left: number, right: number) => Math.abs(left - right) > 0.5,
    strokeWidthInTexels: resolveWidth,
    strokeScanRadius: shaderScalar(source, "strokeScanRadius", [
      "maxWidth",
      "pixelWidth",
    ]),
    neighborCellDistance: shaderScalar(source, "neighborCellDistance", [
      "offset",
      "position",
    ]),
    subtexelStrokeCoverage: shaderScalar(source, "subtexelStrokeCoverage", [
      "distance",
      "width",
      "alignment",
      "pixelWidth",
    ]),
    clamp: (value: number, low: number, high: number) =>
      Math.min(high, Math.max(low, value)),
    max: Math.max,
    min: Math.min,
    int: Math.trunc,
    i32: Math.trunc,
    float: Number,
    f32: Number,
    vec2: (x: number, y = x) => ({ x, y }),
  };
  const run = new Function(...Object.keys(globals), body);
  const result = run(...Object.values(globals)) as
    number | { x: number; y: number };
  return {
    coverage: typeof result === "number" ? result : result.y,
    id: typeof result === "number" ? options.centerId : result.x,
    lookups,
  };
}
