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
});

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
