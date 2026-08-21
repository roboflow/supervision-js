import { describe, expect, it, vi } from "vitest";

import { MAX_ID_MASK_PALETTE_ENTRIES } from "#render-preparation/mask-frame-compositor";
import {
  buildMaskHaloPalette,
  createPixiMaskHaloRenderer,
} from "#renderers/pixi-mask-halo";
import type { PreparedIdMaskFrame } from "#render-preparation/mask-frame-artifact";

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

function createHarness() {
  const getContext = vi.fn();

  vi.stubGlobal("document", {
    createElement: vi.fn(() => ({ getContext, height: 0, width: 0 })),
  });

  const uniformGroups: { uniforms: Record<string, unknown> }[] = [];
  const blurFilters: { strength: number }[] = [];
  const meshes: { visible: boolean; shader: unknown }[] = [];
  const renderer = createPixiMaskHaloRenderer({
    BlurFilter: class {
      strength: number;

      constructor(options: { strength: number }) {
        this.strength = options.strength;
        blurFilters.push(this);
      }
    },
    Container: class {
      alpha = 1;
      readonly children: unknown[] = [];
      visible = true;

      addChild(...children: unknown[]) {
        this.children.push(...children);
      }

      destroy() {}
    } as never,
    ImageSource: class {
      readonly style = {};

      constructor(readonly _options: unknown) {}
    } as never,
    Mesh: class {
      visible = true;
      shader: unknown;

      constructor(options: { shader: unknown }) {
        this.shader = options.shader;
        meshes.push(this);
      }

      destroy() {}
    } as never,
    MeshGeometry: class {
      constructor(readonly _options: unknown) {}

      destroy() {}
    } as never,
    Rectangle: class {
      constructor(
        readonly x: number,
        readonly y: number,
        readonly width: number,
        readonly height: number,
      ) {}
    },
    Shader: {
      from: () => ({
        destroy() {},
        resources: {} as Record<string, unknown>,
      }),
    } as never,
    UniformGroup: class {
      readonly uniforms: Record<string, unknown> = {};

      constructor(readonly _options: unknown) {
        uniformGroups.push(this);
      }

      update() {}
    } as never,
    mediaHeight: 80,
    mediaWidth: 120,
  });
  const frame = { height: 80, width: 120 } as PreparedIdMaskFrame;
  const texture = { source: { style: {} } };

  return {
    blurFilters,
    frame,
    getContext,
    meshes,
    renderer,
    texture,
    uniformGroups,
  };
}

describe("mask halo renderer", () => {
  it("renders one pooled blur pass per distinct spread", () => {
    const { blurFilters, frame, meshes, renderer, texture, uniformGroups } =
      createHarness();
    const narrow = buildMaskHaloPalette(
      new Map([[1, { alpha: 0.6, color: 0x00ff00 }]]),
    );
    const wide = buildMaskHaloPalette(
      new Map([[2, { alpha: 0.4, color: 0xff0000 }]]),
    );

    expect(renderer.display.visible).toBe(false);

    renderer.render(frame, texture as never, [
      { palette: narrow, spread: 4 },
      { palette: wide, spread: 24 },
    ]);

    // Each spread gets its own pass so a 4px halo never blurs at 24px.
    expect(renderer.display.visible).toBe(true);
    expect(meshes).toHaveLength(2);
    expect(blurFilters.map((filter) => filter.strength)).toEqual([4, 24]);
    expect(uniformGroups[0]!.uniforms.uHaloPalette).toBe(narrow);
    expect(uniformGroups[1]!.uniforms.uHaloPalette).toBe(wide);

    // A later frame with one spread hides the extra pooled pass.
    renderer.render(frame, texture as never, [{ palette: narrow, spread: 8 }]);

    expect(meshes).toHaveLength(2);
    expect(meshes[0]!.visible).toBe(true);
    expect(meshes[1]!.visible).toBe(false);
    expect(blurFilters[0]!.strength).toBe(8);
  });

  it("gives its placeholder canvas a rendering context", () => {
    const { getContext } = createHarness();

    // WebGPU builds the placeholder into the shader's first bind group, and a
    // canvas that was never given a rendering context has nothing to bind.
    expect(getContext).toHaveBeenCalledWith("2d");
  });

  it("hides the display when no group renders", () => {
    const { frame, renderer, texture } = createHarness();

    renderer.render(frame, texture as never, [
      {
        palette: buildMaskHaloPalette(
          new Map([[1, { alpha: 1, color: 0xffffff }]]),
        ),
        spread: 10,
      },
    ]);
    expect(renderer.display.visible).toBe(true);

    renderer.render(frame, texture as never, []);
    expect(renderer.display.visible).toBe(false);

    renderer.hide();
    expect(renderer.display.visible).toBe(false);
  });
});
