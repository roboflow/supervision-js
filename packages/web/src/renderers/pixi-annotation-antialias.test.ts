import {
  Filter,
  RenderTarget,
  Texture,
  TexturePoolClass,
  TextureSource,
} from "pixi.js";
import type { FilterSystem, UniformGroup } from "pixi.js";
import { describe, expect, it } from "vitest";
import {
  createPixiAnnotationAntialiasFilter,
  resolvePixiAnnotationAntialiasResolution,
} from "./pixi-annotation-antialias";

describe("annotation AA mask targets", () => {
  it.each([1, 2])(
    "follows the alpha-mask origin at output resolution %s without changing the input",
    (resolution) => {
      const filter = createFilter(true);
      const source = new TextureSource({ width: 128, height: 96, resolution });
      const texture = new Texture({ source });
      const target = new RenderTarget({ colorTextures: [texture] });
      let offset = { x: 18, y: 4 };
      const snapshots: number[][] = [];
      const manager = {
        renderer: {
          renderTarget: { getRenderTarget: () => target },
          globalUniforms: {
            get globalUniformData() {
              return { offset, resolution: target.size };
            },
          },
        },
        applyFilter(actual, input, output, clear) {
          expect([actual, input, output, clear]).toEqual([
            filter,
            texture,
            texture,
            false,
          ]);
          snapshots.push(readOffset(actual));
        },
      } satisfies Pick<FilterSystem, "applyFilter"> & { renderer: unknown };

      try {
        filter.apply(
          manager as unknown as FilterSystem,
          texture,
          texture,
          false,
        );
        offset = { x: -12.5, y: 7.25 };
        filter.apply(
          manager as unknown as FilterSystem,
          texture,
          texture,
          false,
        );
        expect(snapshots).toEqual([
          [18, 4, resolution, 1],
          [-12.5, 7.25, resolution, 1],
        ]);
        expect(source.resolution).toBe(resolution);
      } finally {
        filter.destroy();
        target.destroy();
        texture.destroy(true);
      }
    },
  );

  it("leaves an intermediate filter target at its local origin", () => {
    const filter = createFilter(true);
    const mask = new RenderTarget({ width: 128, height: 96 });
    const intermediate = new RenderTarget({ width: 128, height: 96 });
    const texture = new Texture({ source: intermediate.colorTexture });
    const manager = {
      renderer: {
        renderTarget: { getRenderTarget: () => intermediate },
        globalUniforms: {
          globalUniformData: {
            offset: { x: 18, y: 4 },
            resolution: mask.size,
          },
        },
      },
      applyFilter() {
        expect(readOffset(filter)[3]).toBe(0);
      },
    } as unknown as FilterSystem;
    try {
      filter.apply(manager, texture, texture, false);
    } finally {
      filter.destroy();
      texture.destroy();
      mask.destroy();
      intermediate.destroy();
    }
  });
});

function createFilter(maskCoverage: boolean) {
  return createPixiAnnotationAntialiasFilter({
    Filter: {
      from: (options) => {
        if (!options.gpu)
          throw Error("The AA factory must provide WebGPU source");
        return Filter.from({ ...options, gpu: options.gpu, gl: undefined });
      },
    },
    defaultFilterVert: "",
    maskCoverage,
  });
}

function readOffset(filter: Filter): number[] {
  const uniforms = filter.resources.coverageAaUniforms as UniformGroup;
  return Array.from(uniforms.uniforms.uOutputOffset as Float32Array);
}

describe("annotation AA texture bounds", () => {
  it.each([
    {
      width: 2560,
      height: 1440,
      output: 2,
      limit: 8192,
      scale: 2 as const,
      expected: undefined,
    },
    { width: 768, height: 512, output: 1, limit: 8192, expected: 1 },
    {
      width: 768,
      height: 512,
      output: 1,
      limit: 8192,
      scale: 2 as const,
      expected: 2,
    },
    {
      width: 768,
      height: 512,
      output: 2,
      limit: 8192,
      scale: 2 as const,
      expected: 4,
    },
    {
      width: 750,
      height: 2800,
      output: 2,
      limit: 8192,
      scale: 2 as const,
      expected: undefined,
    },
    {
      width: 2560,
      height: 1440,
      output: 2,
      limit: 12288,
      scale: 2 as const,
      expected: undefined,
    },
    {
      width: 5000.25,
      height: 1800.75,
      output: 1.5,
      limit: 8192,
      scale: 2 as const,
      expected: undefined,
    },
  ])(
    "fits a $width by $height viewport at DPR $output within $limit texels",
    ({ width, height, output, limit, scale, expected }) => {
      const resolution = resolvePixiAnnotationAntialiasResolution(
        output,
        { width, height },
        limit,
        scale,
      );
      expect(resolution).toBeGreaterThan(0);
      expect(resolution).toBeLessThanOrEqual(output * (scale ?? 1));
      if (expected !== undefined) expect(resolution).toBe(expected);

      const pool = new TexturePoolClass();
      const texture = pool.getOptimalTexture(
        Math.ceil(width * resolution) / resolution,
        Math.ceil(height * resolution) / resolution,
        resolution,
        false,
      );
      expect(texture.source.pixelWidth).toBeLessThanOrEqual(limit);
      expect(texture.source.pixelHeight).toBeLessThanOrEqual(limit);
      pool.returnTexture(texture);
      const roundedMask = pool.getOptimalTexture(
        Math.ceil(width) + 6,
        Math.ceil(height) + 6,
        resolution,
        false,
      );
      expect(roundedMask.source.pixelWidth).toBeLessThanOrEqual(limit);
      expect(roundedMask.source.pixelHeight).toBeLessThanOrEqual(limit);
      pool.returnTexture(roundedMask);
      pool.clear();
    },
  );
});
