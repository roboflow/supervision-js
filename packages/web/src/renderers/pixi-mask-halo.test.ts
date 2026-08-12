import { describe, expect, it, vi } from "vitest";

import { MAX_ID_MASK_PALETTE_ENTRIES } from "#render-preparation/mask-frame-compositor";
import {
  buildMaskHaloPalette,
  createPixiMaskHaloRenderer,
} from "#renderers/pixi-mask-halo";
import type { PreparedPngIdMaskFrame } from "#render-preparation/mask-frame-artifact";

describe("mask halo palette", () => {
  it("premultiplies halo colors into per-id slots", () => {
    const palette = buildMaskHaloPalette(
      new Map([[2, { alpha: 0.5, color: 0xff0000 }]]),
    );

    expect(palette).toHaveLength(MAX_ID_MASK_PALETTE_ENTRIES * 4);
    expect(palette[8]).toBeCloseTo(0.5);
    expect(palette[9]).toBe(0);
    expect(palette[10]).toBe(0);
    expect(palette[11]).toBeCloseTo(0.5);
    // Background id stays transparent.
    expect(palette[0]).toBe(0);
    expect(palette[3]).toBe(0);
  });

  it("ignores background and out-of-range ids", () => {
    const palette = buildMaskHaloPalette(
      new Map([
        [0, { alpha: 1, color: 0xffffff }],
        [MAX_ID_MASK_PALETTE_ENTRIES, { alpha: 1, color: 0xffffff }],
      ]),
    );

    expect(palette.every((value) => value === 0)).toBe(true);
  });
});

describe("mask halo renderer", () => {
  it("shows the blurred mesh with the palette and spread applied", () => {
    vi.stubGlobal("document", {
      createElement: vi.fn(() => ({ height: 0, width: 0 })),
    });

    const update = vi.fn();
    const uniforms = { uniforms: {} as Record<string, unknown>, update };
    const blurFilters: { strength: number }[] = [];
    const renderer = createPixiMaskHaloRenderer({
      BlurFilter: class {
        strength: number;

        constructor(options: { strength: number }) {
          this.strength = options.strength;
          blurFilters.push(this);
        }
      },
      ImageSource: class {
        readonly style = {};

        constructor(readonly _options: unknown) {}
      } as never,
      Mesh: class {
        alpha = 1;
        visible = true;
        shader: unknown;

        constructor(options: { shader: unknown }) {
          this.shader = options.shader;
        }

        destroy() {}
      } as never,
      MeshGeometry: class {
        constructor(readonly _options: unknown) {}

        destroy() {}
      } as never,
      Shader: {
        from: () => ({
          destroy() {},
          resources: {} as Record<string, unknown>,
        }),
      } as never,
      UniformGroup: class {
        readonly uniforms = uniforms.uniforms;

        update() {
          update();
        }
      } as never,
      mediaHeight: 80,
      mediaWidth: 120,
    });
    const frame = { height: 80, width: 120 } as PreparedPngIdMaskFrame;
    const texture = { source: { style: {} } };
    const palette = buildMaskHaloPalette(
      new Map([[1, { alpha: 0.6, color: 0x00ff00 }]]),
    );

    expect(renderer.mesh.visible).toBe(false);

    renderer.render(frame, texture as never, palette, 14);

    expect(renderer.mesh.visible).toBe(true);
    expect(uniforms.uniforms.uHaloPalette).toBe(palette);
    expect(update).toHaveBeenCalled();
    expect(blurFilters[0]!.strength).toBe(14);

    renderer.hide();
    expect(renderer.mesh.visible).toBe(false);
  });
});
