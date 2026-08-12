import { beforeEach, describe, expect, it, vi } from "vitest";

import { PreparedMaskFrameKind } from "#render-preparation/mask-frame-artifact";
import { BaseMaskStyle } from "supervision-js-core";

const preparedWindow = vi.hoisted(() => ({
  frame: undefined as
    | {
        detectionFrame: { detections: never[]; mediaTime: number };
        key: string;
        maskStatus: string;
      }
    | undefined,
  options: undefined as
    | {
        onMaskFramePrepared?: (frame: unknown) => void;
      }
    | undefined,
}));

vi.mock("#render-preparation/prepared-render-window", () => ({
  PreparedRenderFrameMaskStatus: {
    Disabled: "disabled",
    Empty: "empty",
    Pending: "pending",
    Prepared: "prepared",
  },
  createPreparedRenderWindow: vi.fn((options) => {
    preparedWindow.options = options;
    return {
      destroy: vi.fn(),
      getFrame: vi.fn(() => preparedWindow.frame),
      setMaskStyle: vi.fn(),
      setTimelineContext: vi.fn(),
      waitForReady: vi.fn(() => Promise.resolve()),
    };
  }),
}));

import { createPixiMaskLayer } from "#renderers/pixi-mask-layer";

beforeEach(() => {
  preparedWindow.frame = undefined;
  preparedWindow.options = undefined;
});

describe("pixi mask layer", () => {
  it("notifies when the active ID-mask frame finishes preparing", () => {
    const onActiveIdMaskFramePresented = vi.fn();
    const layer = createPixiMaskLayer({
      ImageSource: FakeImageSource as never,
      Sprite: FakeSprite as never,
      Texture: FakeTexture as never,
      detectionTimeline: {} as never,
      maskStyle: new BaseMaskStyle(),
      onActiveIdMaskFramePresented,
    });

    layer.createSprite({ height: 80, width: 120 });
    preparedWindow.frame = {
      detectionFrame: { detections: [], mediaTime: 0.1 },
      key: "mask-frame",
      maskStatus: "pending",
    };
    layer.drawFrame(0.1);

    preparedWindow.options?.onMaskFramePrepared?.({
      close: vi.fn(),
      fillPalette: new Float32Array(),
      hasStroke: false,
      height: 80,
      key: "mask-frame",
      kind: PreparedMaskFrameKind.PngIdMask,
      maxStrokeWidth: 0,
      png: new Uint8Array(),
      source: {},
      strokePalette: new Float32Array(),
      strokeWidths: new Float32Array(),
      width: 120,
    });

    expect(onActiveIdMaskFramePresented).toHaveBeenCalledOnce();
    expect(layer.getActiveIdMaskFrameTexture()?.frame.key).toBe("mask-frame");
  });

  it("renders a mask halo from the live style when instructions request one", () => {
    vi.stubGlobal("document", {
      createElement: vi.fn(() => ({ height: 0, width: 0 })),
    });

    const detection = {
      className: "horse",
      mask: { counts: "04", encoding: "compressedRle", height: 2, width: 2 },
      rect: { height: 10, width: 10, x: 5, y: 5 },
    };
    const detectionFrame = { detections: [detection], mediaTime: 0.1 };
    const haloMeshes: FakeMesh[] = [];
    const blurFilters: { strength: number }[] = [];
    const uniformGroups: FakeUniformGroup[] = [];
    const layer = createPixiMaskLayer({
      BlurFilter: class {
        strength: number;

        constructor(options: { strength: number }) {
          this.strength = options.strength;
          blurFilters.push(this);
        }
      },
      Container: FakeContainer as never,
      ImageSource: FakeImageSource as never,
      Mesh: class extends FakeMesh {
        constructor(options: unknown) {
          super(options);
          haloMeshes.push(this);
        }
      } as never,
      MeshGeometry: FakeMeshGeometry as never,
      Shader: { from: () => ({ destroy() {}, resources: {} }) } as never,
      Sprite: FakeSprite as never,
      Texture: FakeTexture as never,
      UniformGroup: class extends FakeUniformGroup {
        constructor(options: unknown) {
          super(options);
          uniformGroups.push(this);
        }
      } as never,
      detectionTimeline: {
        selectFrame: () => detectionFrame,
      } as never,
      maskStyle: {
        resolve: (resolved: { mask?: unknown }) =>
          resolved.mask
            ? {
                alpha: 0.4,
                color: 0x123456,
                halo: { alpha: 0.6, color: 0x123456, spread: 16 },
                mask: resolved.mask,
              }
            : undefined,
      } as never,
    });

    layer.createSprite({ height: 80, width: 120 });
    preparedWindow.frame = {
      detectionFrame: detectionFrame as never,
      key: "mask-frame",
      maskStatus: "pending",
    };
    layer.drawFrame(0.1);
    preparedWindow.options?.onMaskFramePrepared?.({
      close: vi.fn(),
      fillPalette: new Float32Array(),
      hasStroke: false,
      height: 80,
      key: "mask-frame",
      kind: PreparedMaskFrameKind.PngIdMask,
      maxStrokeWidth: 0,
      png: new Uint8Array(),
      source: {},
      strokePalette: new Float32Array(),
      strokeWidths: new Float32Array(),
      width: 120,
    });

    // Mesh order: halo first, then the id-mask mesh.
    const haloMesh = haloMeshes[0]!;
    expect(haloMesh.visible).toBe(true);
    expect(blurFilters[0]!.strength).toBe(16);
    const haloGroup = uniformGroups.find(
      (group) => group.uniforms.uHaloPalette !== undefined,
    );
    const palette = haloGroup?.uniforms.uHaloPalette as Float32Array;
    // Mask id 1 carries the premultiplied halo alpha.
    expect(palette[7]).toBeCloseTo(0.6);
  });
});

class FakeContainer {
  readonly children: unknown[] = [];

  addChild(...children: unknown[]) {
    this.children.push(...children);
  }
}

class FakeMesh {
  alpha = 1;
  visible = true;
  shader: unknown;
  uniformValues: Record<string, unknown> | undefined;

  constructor(options: unknown) {
    this.shader = (options as { shader?: unknown }).shader;
  }

  destroy() {}
}

class FakeMeshGeometry {
  constructor(readonly _options: unknown) {}

  destroy() {}
}

class FakeUniformGroup {
  readonly uniforms: Record<string, unknown> = {};

  constructor(readonly _options: unknown) {}

  update() {}
}

class FakeImageSource {
  readonly style = {};

  constructor(readonly _options: unknown) {}
}

class FakeTexture {
  static readonly EMPTY = new FakeTexture({});
  readonly source = {};

  constructor(readonly _options: unknown) {}
}

class FakeSprite {
  alpha = 1;
  height = 0;
  texture: unknown;
  visible = true;
  width = 0;
}
