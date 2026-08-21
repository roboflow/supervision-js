import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  IdMaskTextureFormat,
  PreparedMaskFrameKind,
} from "#render-preparation/mask-frame-artifact";
import { RenderPreparationArtifactKind } from "#types/render-preparation";
import type { RenderPreparationMaskFrameOptions } from "#types/render-preparation";
import { BaseMaskStyle } from "supervision-js-core";

const preparedWindow = vi.hoisted(() => ({
  frame: undefined as
    | {
        detectionFrame: { detections: never[]; mediaTime: number };
        key: string;
        maskFrame?: unknown;
        maskStatus: string;
      }
    | undefined,
  options: undefined as
    | {
        onPreparedWindowChange?: () => void;
        resolveMaxRasterWidth?: () => number | undefined;
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
      isArtifactPrepared: vi.fn(
        () => preparedWindow.frame?.maskStatus === "prepared",
      ),
      setMaskStyle: vi.fn(),
      setTimelineContext: vi.fn(),
      waitForReady: vi.fn(() => Promise.resolve()),
    };
  }),
}));

import { createPixiMaskLayer } from "#renderers/pixi-mask-layer";
import type { IdMaskDisplayBox } from "#renderers/pixi-mask-layer";

beforeEach(() => {
  preparedWindow.frame = undefined;
  preparedWindow.options = undefined;
});

describe("pixi mask layer", () => {
  it("leaves the drawn frame alone when a cook lands, and draws it on the redraw", () => {
    const onPreparedWindowChange = vi.fn();
    const layer = createPixiMaskLayer({
      BufferImageSource: FakeBufferImageSource as never,
      ImageSource: FakeImageSource as never,
      Sprite: FakeSprite as never,
      Texture: FakeTexture as never,
      detectionTimeline: {} as never,
      maskStyle: new BaseMaskStyle(),
      onPreparedWindowChange,
    });

    layer.createSprite({ height: 80, width: 120 });
    preparedWindow.frame = {
      detectionFrame: { detections: [], mediaTime: 0.1 },
      key: "mask-frame",
      maskStatus: "pending",
    };
    layer.drawFrame(0.1);

    preparedWindow.frame = {
      ...preparedWindow.frame,
      maskFrame: idMaskFrame(),
      maskStatus: "prepared",
    };
    preparedWindow.options?.onPreparedWindowChange?.();

    expect(onPreparedWindowChange).toHaveBeenCalledOnce();
    expect(layer.getActiveIdMaskFrameTexture()).toBeNull();

    layer.drawFrame(0.1);

    expect(layer.getActiveIdMaskFrameTexture()?.frame.key).toBe("mask-frame");
  });

  it("takes a shown frame off screen when asked to clear", () => {
    const layer = createPixiMaskLayer({
      BufferImageSource: FakeBufferImageSource as never,
      ImageSource: FakeImageSource as never,
      Sprite: FakeSprite as never,
      Texture: FakeTexture as never,
      detectionTimeline: {} as never,
      maskStyle: new BaseMaskStyle(),
    });
    const sprite = layer.createSprite({ height: 80, width: 120 }) as FakeSprite;

    preparedWindow.frame = {
      detectionFrame: { detections: [], mediaTime: 0.1 },
      key: "mask-frame",
      maskFrame: idMaskFrame(),
      maskStatus: "prepared",
    };
    layer.drawFrame(0.1);

    expect(sprite.visible).toBe(true);

    layer.clearFrame();

    expect(sprite.visible).toBe(false);
    expect(layer.getActiveIdMaskFrameTexture()).toBeNull();
  });

  it("puts none of a cooked frame on a later frame still owing its cook", () => {
    const layer = createPixiMaskLayer({
      BufferImageSource: FakeBufferImageSource as never,
      ImageSource: FakeImageSource as never,
      Sprite: FakeSprite as never,
      Texture: FakeTexture as never,
      detectionTimeline: {} as never,
      maskStyle: new BaseMaskStyle(),
    });
    const sprite = layer.createSprite({ height: 80, width: 120 }) as FakeSprite;

    preparedWindow.frame = {
      detectionFrame: { detections: [], mediaTime: 0.1 },
      key: "mask-frame",
      maskFrame: idMaskFrame(),
      maskStatus: "prepared",
    };
    layer.drawFrame(0.1);

    preparedWindow.frame = {
      detectionFrame: { detections: [], mediaTime: 0.12 },
      key: "owed-frame",
      maskStatus: "pending",
    };
    layer.drawFrame(0.12);

    // The fill holds for a moment against a flicker; the id raster, which
    // consumers read detections out of, never holds at all.
    expect(sprite.visible).toBe(true);
    expect(layer.getActiveIdMaskFrameTexture()).toBeNull();

    preparedWindow.frame = {
      ...preparedWindow.frame,
      detectionFrame: { detections: [], mediaTime: 0.3 },
    };
    layer.drawFrame(0.3);

    expect(sprite.visible).toBe(false);
  });

  it("uploads an odd-width id raster one byte per pixel on a renderer that takes it", () => {
    const upload = uploadIdMask(121, () => true);

    expect(upload.format).toBe(IdMaskTextureFormat.R8);
    expect(upload.resource.length).toBe(121 * 80);
    expect(upload.resource[121]).toBe(7);
  });

  it("pays four channels for an odd-width id raster the renderer would reject", () => {
    const upload = uploadIdMask(121, () => false);

    expect(upload.format).toBe(IdMaskTextureFormat.Rgba8);
    expect(upload.resource.length).toBe(121 * 80 * 4);
    expect([...upload.resource.slice(121 * 4, 121 * 4 + 4)]).toEqual([
      7, 0, 0, 255,
    ]);
  });

  it("uploads an aligned id raster one byte per pixel whatever the renderer takes", () => {
    for (const acceptsUnaligned of [true, false, undefined]) {
      const upload = uploadIdMask(
        120,
        acceptsUnaligned === undefined ? undefined : () => acceptsUnaligned,
      );

      expect(upload.format).toBe(IdMaskTextureFormat.R8);
      expect(upload.resource.length).toBe(120 * 80);
    }
  });

  it("cooks id rasters no wider than the declared display box shows", () => {
    const layer = maskLayerWithDisplayBox({
      acceptsUnalignedTextureRows: true,
    });

    layer.createSprite({ height: 2016, width: 1504 });

    // 767 / 2016 is the tighter fit of the two axes.
    expect(preparedWindow.options?.resolveMaxRasterWidth?.()).toBe(573);
  });

  it("keeps a cooked raster on the four-byte boundary the renderer needs", () => {
    const layer = maskLayerWithDisplayBox({
      acceptsUnalignedTextureRows: false,
    });

    layer.createSprite({ height: 2016, width: 1504 });

    expect(preparedWindow.options?.resolveMaxRasterWidth?.()).toBe(572);
  });

  it("asks for no width of its own before a sprite gives it media dimensions", () => {
    maskLayerWithDisplayBox({ acceptsUnalignedTextureRows: true });

    expect(preparedWindow.options?.resolveMaxRasterWidth?.()).toBeUndefined();
  });

  it("leaves a layer with no display box at the detections' own resolution", () => {
    const layer = createPixiMaskLayer({
      BufferImageSource: FakeBufferImageSource as never,
      ImageSource: FakeImageSource as never,
      Sprite: FakeSprite as never,
      Texture: FakeTexture as never,
      detectionTimeline: {} as never,
      maskStyle: new BaseMaskStyle(),
    });

    layer.createSprite({ height: 2016, width: 1504 });

    expect(preparedWindow.options?.resolveMaxRasterWidth?.()).toBeUndefined();
  });

  it("leaves a polygon frame at the size its geometry was rasterized to", () => {
    const layer = maskLayerWithDisplayBox({
      acceptsUnalignedTextureRows: true,
      artifactKind: RenderPreparationArtifactKind.PolygonFrame,
    });

    layer.createSprite({ height: 2016, width: 1504 });

    expect(preparedWindow.options?.resolveMaxRasterWidth?.()).toBeUndefined();
  });

  it("renders per-spread halo passes from the live halo style", () => {
    vi.stubGlobal("document", {
      createElement: vi.fn(() => ({
        getContext: () => ({
          createImageData: (width: number, height: number) => ({
            data: new Uint8ClampedArray(width * height * 4),
          }),
          putImageData: vi.fn(),
        }),
        height: 0,
        width: 0,
      })),
    });

    const detections = [
      {
        className: "horse",
        mask: { counts: "04", encoding: "compressedRle", height: 2, width: 2 },
        rect: { height: 10, width: 10, x: 5, y: 5 },
      },
      {
        className: "cow",
        mask: { counts: "04", encoding: "compressedRle", height: 2, width: 2 },
        rect: { height: 10, width: 10, x: 25, y: 5 },
      },
    ];
    const detectionFrame = { detections, mediaTime: 0.1 };
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
      BufferImageSource: FakeBufferImageSource as never,
      Container: FakeContainer as never,
      ImageSource: FakeImageSource as never,
      Mesh: FakeMesh as never,
      MeshGeometry: FakeMeshGeometry as never,
      Rectangle: class {
        constructor(
          readonly x: number,
          readonly y: number,
          readonly width: number,
          readonly height: number,
        ) {}
      },
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
      maskHaloStyle: {
        resolve: (detection: { className?: string }) => ({
          alpha: 0.6,
          color: detection.className === "horse" ? 0x123456 : 0x654321,
          spread: detection.className === "horse" ? 4 : 24,
        }),
      },
      maskStyle: new BaseMaskStyle({ alpha: 0 }),
    });

    const display = layer.createSprite({
      height: 80,
      width: 120,
    }) as unknown as { children: Array<{ alpha?: number }> };

    preparedWindow.frame = {
      detectionFrame: detectionFrame as never,
      key: "mask-frame",
      maskFrame: idMaskFrame(),
      maskStatus: "prepared",
    };
    layer.drawFrame(0.1);

    // Mixed spreads render as separate blur passes so each detection's
    // requested spread is honored exactly.
    expect(
      blurFilters.map((filter) => filter.strength).sort((a, b) => a - b),
    ).toEqual([4, 24]);

    const haloGroups = uniformGroups.filter(
      (group) => group.uniforms.uHaloPalette !== undefined,
    );

    expect(haloGroups).toHaveLength(2);

    const narrowPalette = haloGroups[0]!.uniforms.uHaloPalette as Float32Array;
    const widePalette = haloGroups[1]!.uniforms.uHaloPalette as Float32Array;

    // Mask id 1 (horse, 4px) only in the narrow pass; id 2 (cow, 24px) only
    // in the wide pass.
    expect(narrowPalette[7]).toBeCloseTo(0.6);
    expect(narrowPalette[11]).toBe(0);
    expect(widePalette[7]).toBe(0);
    expect(widePalette[11]).toBeCloseTo(0.6);
    // The mask renderer can be transparent while the independently selected
    // halo renderer remains visible at its instruction alpha.
    expect(display.children[0]?.alpha).toBe(1);
  });

  it("keeps the halo visible when mask preparation falls back to RGBA", () => {
    vi.stubGlobal("document", {
      createElement: vi.fn(() => ({
        getContext: () => ({
          createImageData: (width: number, height: number) => ({
            data: new Uint8ClampedArray(width * height * 4),
          }),
          putImageData: vi.fn(),
        }),
        height: 0,
        width: 0,
      })),
    });

    const uniformGroups: FakeUniformGroup[] = [];
    const layer = createPixiMaskLayer({
      BlurFilter: class {
        strength: number;

        constructor(options: { strength: number }) {
          this.strength = options.strength;
        }
      },
      BufferImageSource: FakeBufferImageSource as never,
      Container: FakeContainer as never,
      ImageSource: FakeImageSource as never,
      Mesh: FakeMesh as never,
      MeshGeometry: FakeMeshGeometry as never,
      Rectangle: class {
        constructor(
          readonly x: number,
          readonly y: number,
          readonly width: number,
          readonly height: number,
        ) {}
      },
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
        selectFrame: () => ({
          detections: [
            {
              mask: {
                counts: "04",
                encoding: "compressedRle",
                height: 2,
                width: 2,
              },
            },
          ],
          mediaTime: 0.1,
        }),
      } as never,
      maskHaloStyle: {
        resolve: () => ({ alpha: 0.6, color: 0x123456, spread: 8 }),
      },
      maskStyle: new BaseMaskStyle(),
    });

    layer.createSprite({ height: 2, width: 2 });
    preparedWindow.frame = {
      detectionFrame: { detections: [], mediaTime: 0.1 },
      key: "rgba-mask-frame",
      maskFrame: {
        close: vi.fn(),
        height: 2,
        idMaskData: Uint8Array.from([1, 1, 1, 1]),
        key: "rgba-mask-frame",
        kind: PreparedMaskFrameKind.RgbaImage,
        source: {},
        width: 2,
      },
      maskStatus: "prepared",
    };
    layer.drawFrame(0.1);

    expect(
      uniformGroups.some((group) => group.uniforms.uHaloPalette !== undefined),
    ).toBe(true);
  });

  it("reports the window's readiness for a media time", () => {
    const layer = createPixiMaskLayer({
      BufferImageSource: FakeBufferImageSource as never,
      ImageSource: FakeImageSource as never,
      Sprite: FakeSprite as never,
      Texture: FakeTexture as never,
      detectionTimeline: {} as never,
      maskStyle: new BaseMaskStyle(),
    });

    preparedWindow.frame = {
      detectionFrame: { detections: [], mediaTime: 0.1 },
      key: "mask-frame",
      maskStatus: "pending",
    };

    expect(layer.isArtifactPrepared(0.1)).toBe(false);

    preparedWindow.frame = { ...preparedWindow.frame, maskStatus: "prepared" };

    expect(layer.isArtifactPrepared(0.1)).toBe(true);
  });
});

function maskLayerWithDisplayBox(options: {
  readonly acceptsUnalignedTextureRows: boolean;
  readonly artifactKind?: RenderPreparationArtifactKind;
}) {
  const display: IdMaskDisplayBox = {
    boxHeight: 767,
    boxWidth: 574,
    devicePixelRatio: 2,
    maxDevicePixelRatio: 1,
  };
  const maskFrame: RenderPreparationMaskFrameOptions & {
    readonly display: IdMaskDisplayBox;
  } = { display };

  return createPixiMaskLayer({
    BufferImageSource: FakeBufferImageSource as never,
    ImageSource: FakeImageSource as never,
    Sprite: FakeSprite as never,
    Texture: FakeTexture as never,
    acceptsUnalignedTextureRows: () => options.acceptsUnalignedTextureRows,
    artifactKind: options.artifactKind,
    detectionTimeline: {} as never,
    maskStyle: new BaseMaskStyle(),
    renderPreparation: { maskFrame },
  });
}

function idMaskFrame(width = 120) {
  const raster = new Uint8Array(width * 80);

  raster[width] = 7;

  return {
    close: vi.fn(),
    fillPalette: new Float32Array(),
    hasStroke: false,
    height: 80,
    key: "mask-frame",
    kind: PreparedMaskFrameKind.IdMask,
    maxStrokeWidth: 0,
    raster,
    strokePalette: new Float32Array(),
    strokeWidths: new Float32Array(),
    width,
  };
}

function uploadIdMask(
  width: number,
  acceptsUnalignedTextureRows: (() => boolean) | undefined,
) {
  const layer = createPixiMaskLayer({
    BufferImageSource: FakeBufferImageSource as never,
    ImageSource: FakeImageSource as never,
    Sprite: FakeSprite as never,
    Texture: FakeTexture as never,
    acceptsUnalignedTextureRows,
    detectionTimeline: {} as never,
    maskStyle: new BaseMaskStyle(),
  });

  layer.createSprite({ height: 80, width });
  preparedWindow.frame = {
    detectionFrame: { detections: [], mediaTime: 0.1 },
    key: "mask-frame",
    maskFrame: idMaskFrame(width),
    maskStatus: "prepared",
  };
  layer.drawFrame(0.1);

  const texture = layer.getActiveIdMaskFrameTexture()?.texture as unknown as {
    source: FakeBufferImageSource;
  };

  return texture.source._options as {
    format: IdMaskTextureFormat;
    resource: Uint8Array;
    width: number;
  };
}

class FakeContainer {
  alpha = 1;
  readonly children: unknown[] = [];

  addChild(...children: unknown[]) {
    this.children.push(...children);
  }
}

class FakeMesh {
  alpha = 1;
  visible = true;
  readonly shader: unknown;

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
  readonly uniforms: Record<string, unknown>;

  constructor(readonly _options: unknown) {
    this.uniforms = { ...(_options as Record<string, unknown>) };
  }

  update() {}
}

class FakeImageSource {
  readonly style = {};

  constructor(readonly _options: unknown) {}
}

class FakeBufferImageSource {
  readonly style = {};

  constructor(readonly _options: unknown) {}
}

class FakeTexture {
  static readonly EMPTY = new FakeTexture({});
  readonly source: unknown;

  constructor(readonly _options: { source?: unknown }) {
    this.source = _options.source ?? {};
  }
}

class FakeSprite {
  alpha = 1;
  height = 0;
  texture: unknown;
  visible = true;
  width = 0;
}
