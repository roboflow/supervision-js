import { describe, expect, it, vi } from "vitest";

import { createPixiRegionLayer } from "#renderers/pixi-region-layer";
import {
  KeypointVisibility,
  annotationRenderers,
  type BufferedDetectionTimeline,
  type DetectionFrame,
} from "supervision-js-core";

const frame: DetectionFrame = {
  detections: [
    {
      className: "player",
      id: "player-7",
      keypoints: {
        edges: [],
        points: [
          { x: 100, y: 40 },
          { x: 94, y: 37 },
          { x: 106, y: 37 },
          { x: 90, y: 40 },
          { x: 110, y: 40 },
        ],
        visibility: Array(5).fill(KeypointVisibility.Visible),
      },
      rect: { height: 100, width: 50, x: 100, y: 90 },
    },
    {
      className: "basketball",
      id: "ball",
      rect: { height: 10, width: 10, x: 200, y: 80 },
    },
  ],
  frameIndex: 1,
  mediaTime: 1,
};

describe("pixi region layer", () => {
  it("loads an asset asynchronously and redraws a matching head anchor", async () => {
    const texture = { height: 20, width: 40 };
    const load = vi.fn(async () => texture);
    const onInvalidate = vi.fn();
    const layer = createPixiRegionLayer({
      Assets: { load, unload: vi.fn(async () => undefined) } as never,
      Container: FakeContainer as never,
      GifSprite: FakeGifSprite as never,
      Sprite: FakeSprite as never,
      detectionTimeline: createTimeline(frame),
      onInvalidate,
      regionRenderers: [
        annotationRenderers.region({
          compose: { mode: "over", zIndex: 2 },
          id: "player-hat",
          region: { anchor: "head", kind: "keypoint-anchor" },
          source: { asset: { src: "/hat.png" }, kind: "asset" },
          target: { className: "player" },
          transform: {
            offset: { x: 0, y: -0.5 },
            opacity: 0.8,
            rotation: 0.25,
            scale: 1.5,
          },
        }),
      ],
    });
    const container = layer.createContainer() as unknown as FakeContainer;

    expect(layer.drawFrame(1).activeDetectionIndexes).toEqual([]);
    await Promise.resolve();
    expect(onInvalidate).toHaveBeenCalledOnce();

    expect(layer.drawFrame(1).activeDetectionIndexes).toEqual([0]);
    expect(load).toHaveBeenCalledWith("/hat.png");
    expect(container.children).toHaveLength(1);
    expect(container.children[0]).toMatchObject({
      alpha: 0.8,
      height: 30,
      rotation: 0.25,
      visible: true,
      width: 60,
      zIndex: 2_000_000,
    });
    const [x, y] = container.children[0]!.position.set.mock.lastCall!;
    expect(x).toBeCloseTo(100);
    expect(y).toBeCloseTo(18.8);
  });

  it("supports multiple identified region renderers and replaces released displays", async () => {
    const unload = vi.fn(async () => undefined);
    const layer = createPixiRegionLayer({
      Assets: {
        load: vi.fn(async (src: string) => ({
          height: src.includes("hat") ? 20 : 30,
          width: 40,
        })),
        unload,
      } as never,
      Container: FakeContainer as never,
      GifSprite: FakeGifSprite as never,
      Sprite: FakeSprite as never,
      detectionTimeline: createTimeline(frame),
      regionRenderers: [
        annotationRenderers.region({
          id: "hat",
          region: { anchor: "head", kind: "keypoint-anchor" },
          source: { asset: { src: "/hat.png" }, kind: "asset" },
          target: { id: "player-7" },
        }),
        annotationRenderers.region({
          id: "ball-badge",
          region: { kind: "bounds" },
          source: { asset: { src: "/badge.png" }, kind: "asset" },
          target: { className: ["basketball"] },
        }),
      ],
    });
    const container = layer.createContainer() as unknown as FakeContainer;
    await Promise.resolve();

    expect(layer.drawFrame(1).activeDetectionIndexes).toEqual([0, 1]);
    expect(container.children).toHaveLength(2);

    layer.setRenderers([]);
    expect(container.children.every((child) => !child.visible)).toBe(true);
    await Promise.resolve();
    expect(unload).toHaveBeenCalledTimes(2);

    layer.setRenderers([
      annotationRenderers.region({
        id: "hat-again",
        region: { anchor: "head", kind: "keypoint-anchor" },
        source: { asset: { src: "/hat.png" }, kind: "asset" },
        target: { className: "player" },
      }),
    ]);
    await Promise.resolve();
    layer.drawFrame(1);
    expect(container.children).toHaveLength(1);
  });

  it("renders every matching detection when stable ids are duplicated", async () => {
    const duplicateIdFrame: DetectionFrame = {
      ...frame,
      detections: frame.detections.map((detection) => ({
        ...detection,
        id: "duplicate",
      })),
    };
    const layer = createPixiRegionLayer({
      Assets: {
        load: vi.fn(async () => ({ height: 10, width: 10 })),
        unload: vi.fn(async () => undefined),
      } as never,
      Container: FakeContainer as never,
      GifSprite: FakeGifSprite as never,
      Sprite: FakeSprite as never,
      detectionTimeline: createTimeline(duplicateIdFrame),
      regionRenderers: [
        annotationRenderers.region({
          id: "badge",
          region: { kind: "bounds" },
          source: { asset: { src: "/badge.png" }, kind: "asset" },
          target: {},
        }),
      ],
    });
    const container = layer.createContainer() as unknown as FakeContainer;
    await Promise.resolve();

    expect(layer.drawFrame(1).activeDetectionIndexes).toEqual([0, 1]);
    expect(container.children).toHaveLength(2);
  });

  it("does not revive a released asset after renderer teardown", async () => {
    let resolveTexture!: (texture: { height: number; width: number }) => void;
    const texture = new Promise<{ height: number; width: number }>(
      (resolve) => {
        resolveTexture = resolve;
      },
    );
    const onInvalidate = vi.fn();
    const unload = vi.fn(async () => undefined);
    const layer = createPixiRegionLayer({
      Assets: { load: () => texture, unload } as never,
      Container: FakeContainer as never,
      GifSprite: FakeGifSprite as never,
      Sprite: FakeSprite as never,
      detectionTimeline: createTimeline(frame),
      onInvalidate,
      regionRenderers: [
        annotationRenderers.region({
          id: "hat",
          region: { kind: "bounds" },
          source: { asset: { src: "/slow.png" }, kind: "asset" },
          target: {},
        }),
      ],
    });

    layer.destroy();
    resolveTexture({ height: 10, width: 10 });
    await Promise.resolve();
    await Promise.resolve();

    expect(onInvalidate).not.toHaveBeenCalled();
    expect(unload).toHaveBeenCalledWith("/slow.png");
  });

  it("reports asset failures without throwing from the frame loop", async () => {
    const error = new Error("asset unavailable");
    const onAssetError = vi.fn();
    const layer = createPixiRegionLayer({
      Assets: {
        load: vi.fn(async () => Promise.reject(error)),
        unload: vi.fn(async () => undefined),
      } as never,
      Container: FakeContainer as never,
      GifSprite: FakeGifSprite as never,
      Sprite: FakeSprite as never,
      detectionTimeline: createTimeline(frame),
      onAssetError,
      regionRenderers: [
        annotationRenderers.region({
          id: "missing",
          region: { kind: "bounds" },
          source: { asset: { src: "/missing.png" }, kind: "asset" },
          target: {},
        }),
      ],
    });

    await vi.waitFor(() =>
      expect(onAssetError).toHaveBeenCalledWith({
        error,
        rendererId: "missing",
        src: "/missing.png",
      }),
    );
    expect(layer.drawFrame(1).activeDetectionIndexes).toEqual([]);
    layer.destroy();
  });

  it("creates a looping GifSprite and releases its shared source", async () => {
    const gifSource = {
      duration: 1_000,
      frames: [{ end: 1_000, start: 0, texture: {} }],
      height: 160,
      textures: [{}],
      totalFrames: 1,
      width: 160,
    };
    const unload = vi.fn(async () => undefined);
    const renderer = annotationRenderers.region({
      id: "player-fire",
      region: { anchor: "head", kind: "keypoint-anchor" },
      source: { asset: { src: "/fire.gif" }, kind: "asset" },
      target: { className: "player" },
    });
    const layer = createPixiRegionLayer({
      Assets: {
        load: vi.fn(async () => gifSource),
        unload,
      } as never,
      Container: FakeContainer as never,
      GifSprite: FakeGifSprite as never,
      Sprite: FakeSprite as never,
      detectionTimeline: createTimeline(frame),
      regionRenderers: [renderer],
    });
    const container = layer.createContainer() as unknown as FakeContainer;
    await Promise.resolve();

    layer.drawFrame(1);
    expect(container.children).toHaveLength(1);
    expect(container.children[0]).toBeInstanceOf(FakeGifSprite);
    expect((container.children[0] as FakeGifSprite).options).toMatchObject({
      autoPlay: true,
      loop: true,
      source: gifSource,
    });
    const display = container.children[0]!;

    layer.setRenderers([
      { ...renderer, target: { className: "missing-player" } },
    ]);
    expect((display as FakeGifSprite).stop).toHaveBeenCalledOnce();
    layer.setRenderers([renderer]);
    expect((display as FakeGifSprite).play).toHaveBeenCalledOnce();

    layer.setRenderers([]);
    await Promise.resolve();
    expect(display.destroy).toHaveBeenCalledOnce();
    expect(container.children).toHaveLength(0);
    expect(unload).toHaveBeenCalledWith("/fire.gif");
  });
});

class FakeContainer {
  readonly children: FakeSprite[] = [];
  sortableChildren = false;

  addChild(...children: FakeSprite[]) {
    this.children.push(...children);
    for (const child of children) child.parent = this;
  }

  removeChild(child: FakeSprite) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parent = undefined;
  }
}

class FakeSprite {
  readonly anchor = { set: vi.fn() };
  readonly destroy = vi.fn();
  readonly position = { set: vi.fn() };
  readonly removeFromParent = vi.fn(() => this.parent?.removeChild(this));
  alpha = 1;
  height = 0;
  rotation = 0;
  texture: { height: number; width: number };
  visible = true;
  width = 0;
  zIndex = 0;
  parent: FakeContainer | undefined;

  constructor(options: { texture: { height: number; width: number } }) {
    this.texture = options.texture;
  }
}

class FakeGifSprite extends FakeSprite {
  readonly options: {
    readonly autoPlay?: boolean;
    readonly loop?: boolean;
    readonly source: { height: number; width: number };
  };
  readonly play = vi.fn();
  readonly stop = vi.fn();

  constructor(options: {
    readonly autoPlay?: boolean;
    readonly loop?: boolean;
    readonly source: { height: number; width: number };
  }) {
    super({ texture: options.source });
    this.options = options;
  }
}

function createTimeline(
  activeFrame: DetectionFrame,
): BufferedDetectionTimeline {
  return {
    destroy() {},
    getBufferedFrames: () => [activeFrame],
    getState: () => ({
      bufferEndTime: activeFrame.mediaTime,
      bufferStartTime: activeFrame.mediaTime,
      detectionCount: activeFrame.detections.length,
      errorMessage: null,
      frameCount: 1,
      requestedEndTime: activeFrame.mediaTime,
      requestedStartTime: activeFrame.mediaTime,
      status: "ready",
    }),
    prepare: async () => undefined,
    prefetch() {},
    selectFrame: () => activeFrame,
  } as unknown as BufferedDetectionTimeline;
}
