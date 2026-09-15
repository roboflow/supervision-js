import { describe, expect, it, vi } from "vitest";
import { RegionRendererMediaEffectKind } from "supervision-js-core";
import { createPixiRegionEffect } from "#renderers/pixi-region-effect";

describe("pixi region effects", () => {
  it("keeps blur strength stable in media pixels across viewport scales", () => {
    const filters: Array<{
      destroy: ReturnType<typeof vi.fn>;
      padding: number;
    }> = [];
    const BlurFilter = vi.fn(function BlurFilter(options) {
      const filter = { destroy: vi.fn(), options, padding: 0 };
      filters.push(filter);
      return filter;
    });
    const display: { filters?: readonly (typeof filters)[number][] | null } =
      {};
    const effect = createPixiRegionEffect({
      BlurFilter: BlurFilter as never,
      effect: {
        kind: RegionRendererMediaEffectKind.Blur,
        strength: 10,
      },
    });

    expect(effect).toBeDefined();
    effect?.apply(display as never, 0.5);
    effect?.apply(display as never, 0.5);
    expect(BlurFilter).toHaveBeenCalledWith({
      kernelSize: 5,
      quality: 2,
      repeatEdgePixels: true,
      strength: 5,
    });
    expect(filters).toHaveLength(1);
    expect(display.filters).toEqual([filters[0]]);
    expect(filters[0]?.padding).toBe(10);

    effect?.apply(display as never, 2);
    expect(BlurFilter).toHaveBeenLastCalledWith({
      kernelSize: 5,
      quality: 2,
      repeatEdgePixels: true,
      strength: 20,
    });
    expect(filters).toHaveLength(2);
    expect(filters[0]?.destroy).toHaveBeenCalledOnce();
    expect(display.filters).toEqual([filters[1]]);

    effect?.destroy();
    expect(display.filters).toBeNull();
    expect(filters[1]?.destroy).toHaveBeenCalledOnce();
  });

  it("scales pixel blocks with the viewport without exposing the Pixi filter contract", () => {
    const filters: Array<{
      destroy: ReturnType<typeof vi.fn>;
      padding: number;
    }> = [];
    const from = vi.fn(() => {
      const filter = { destroy: vi.fn(), padding: 0 };
      filters.push(filter);
      return filter;
    });
    const display: { filters?: readonly (typeof filters)[number][] | null } =
      {};
    const effect = createPixiRegionEffect({
      Filter: { from } as never,
      defaultFilterVert: "default-filter-vertex",
      effect: {
        kind: RegionRendererMediaEffectKind.Pixelate,
        size: 14,
      },
    });

    expect(effect).toBeDefined();
    effect?.apply(display as never, 0.5);
    expect(from).toHaveBeenCalledWith(
      expect.objectContaining({
        gl: expect.objectContaining({
          fragment: expect.stringContaining("uBlockSize"),
          vertex: "default-filter-vertex",
        }),
        resources: {
          regionEffectUniforms: {
            uBlockSize: { type: "f32", value: 7 },
          },
        },
      }),
    );
    effect?.apply(display as never, 2);
    expect(from).toHaveBeenLastCalledWith(
      expect.objectContaining({
        resources: {
          regionEffectUniforms: {
            uBlockSize: { type: "f32", value: 28 },
          },
        },
      }),
    );
    expect(filters[0]?.destroy).toHaveBeenCalledOnce();
  });
});
