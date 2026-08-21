import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  IdMaskTextureFormat,
  PreparedMaskFrameKind,
} from "#render-preparation/mask-frame-artifact";
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
