import { describe, expect, it, vi } from "vitest";
import { RegionRendererMediaEffectKind } from "supervision-js-core";
import { createPixiRegionEffect } from "#renderers/pixi-region-effect";

describe("pixi region effects", () => {
  it("creates one bounded blur filter and keeps it attached across redraws", () => {
    const filter = { destroy: vi.fn(), padding: 0 };
    const BlurFilter = vi.fn(function BlurFilter(options) {
      Object.assign(filter, { options });
      return filter;
    });
    const display: { filters?: readonly (typeof filter)[] | null } = {};
    const effect = createPixiRegionEffect({
      BlurFilter: BlurFilter as never,
      effect: {
        kind: RegionRendererMediaEffectKind.Blur,
        strength: 10,
      },
    });

    expect(effect).toBeDefined();
    effect?.apply(display);
    effect?.apply(display);
    expect(BlurFilter).toHaveBeenCalledWith({
      kernelSize: 5,
      quality: 2,
      repeatEdgePixels: true,
      strength: 10,
    });
    expect(display.filters).toEqual([filter]);
    expect(filter.padding).toBe(20);

    effect?.destroy();
    expect(display.filters).toBeNull();
    expect(filter.destroy).toHaveBeenCalledOnce();
  });

  it("creates a pixelate shader without exposing the Pixi filter contract", () => {
    const filter = { destroy: vi.fn(), padding: 0 };
    const from = vi.fn(() => filter);
    const effect = createPixiRegionEffect({
      Filter: { from } as never,
      defaultFilterVert: "default-filter-vertex",
      effect: {
        kind: RegionRendererMediaEffectKind.Pixelate,
        size: 14,
      },
    });

    expect(effect).toBeDefined();
    expect(from).toHaveBeenCalledWith(
      expect.objectContaining({
        gl: expect.objectContaining({
          fragment: expect.stringContaining("uBlockSize"),
          vertex: "default-filter-vertex",
        }),
        resources: {
          regionEffectUniforms: {
            uBlockSize: { type: "f32", value: 14 },
          },
        },
      }),
    );
  });
});
