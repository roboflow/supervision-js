import { describe, expect, it, vi } from "vitest";

import { createPixiRegionLayer } from "#renderers/pixi-region-layer";
import {
  DetectionMaskEncoding,
  KeypointVisibility,
  RegionRendererCoverageKind,
  RegionRendererSizeSpace,
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
      ...createTestBackend(),
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
      ...createTestBackend(),
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

  it("fast-translates every active region display for a detection", async () => {
    const layer = createPixiRegionLayer({
      ...createTestBackend(),
      Assets: {
        load: vi.fn(async () => ({ height: 10, width: 10 })),
        unload: vi.fn(async () => undefined),
      } as never,
      Container: FakeContainer as never,
      GifSprite: FakeGifSprite as never,
      Sprite: FakeSprite as never,
      detectionTimeline: createTimeline(frame),
      regionRenderers: [
        annotationRenderers.region({
          id: "player-badge",
          region: { kind: "bounds" },
          source: { asset: { src: "/badge.png" }, kind: "asset" },
          target: { id: "player-7" },
        }),
        annotationRenderers.region({
          id: "player-badge-2",
          region: { kind: "bounds" },
          source: { asset: { src: "/badge.png" }, kind: "asset" },
          target: { id: "player-7" },
        }),
      ],
    });
    const container = layer.createContainer() as unknown as FakeContainer;
    await Promise.resolve();
    layer.drawFrame(1);

    expect(layer.translateDetection("player-7", 7, -3)).toBe(true);
    for (const display of container.children) {
      expect(display.position.set).toHaveBeenLastCalledWith(107, 87);
    }
    expect(layer.translateDetection("missing", 1, 1)).toBe(false);
    expect(layer.translateDetection("player-7", 0, 0)).toBe(true);
    for (const display of container.children) {
      expect(display.position.set).toHaveBeenLastCalledWith(100, 90);
    }
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
      ...createTestBackend(),
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
      ...createTestBackend(),
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
      ...createTestBackend(),
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

  it("reuses the presented media texture for cropped regions across seek and transform updates", () => {
    const mediaTexture = new FakeTexture({
      source: { height: 200, width: 300 },
    });
    const loopedFrame: DetectionFrame = {
      ...frame,
      detections: [
        {
          ...frame.detections[0]!,
          keypoints: {
            ...frame.detections[0]!.keypoints!,
            points: frame.detections[0]!.keypoints!.points.map(({ x, y }) => ({
              x: x + 20,
              y: y + 10,
            })),
          },
        },
      ],
      frameIndex: 0,
      mediaTime: 0,
    };
    const timeline = createTimeline(frame, (mediaTime) =>
      mediaTime < 0.5 ? loopedFrame : frame,
    );
    const renderer = annotationRenderers.region({
      id: "big-heads",
      region: { anchor: "head", kind: "keypoint-anchor" },
      source: {
        kind: "media",
        region: { anchor: "head", kind: "keypoint-anchor" },
      },
      target: { className: "player" },
      transform: {
        flip: { horizontal: true },
        scale: 2,
      },
    });
    const load = vi.fn();
    const layer = createPixiRegionLayer({
      ...createTestBackend(mediaTexture),
      Assets: { load, unload: vi.fn(async () => undefined) } as never,
      Container: FakeContainer as never,
      GifSprite: FakeGifSprite as never,
      Sprite: FakeSprite as never,
      detectionTimeline: timeline,
      regionRenderers: [renderer],
    });
    const container = layer.createContainer() as unknown as FakeContainer;

    expect(layer.drawFrame(1).activeDetectionIndexes).toEqual([0]);
    expect(load).not.toHaveBeenCalled();
    expect(container.children).toHaveLength(1);
    const display = container.children[0]!;
    const cropTexture = display.texture as FakeTexture;
    expect(cropTexture.source).toBe(mediaTexture.source);
    expect(cropTexture.frame.x).toBeCloseTo(80);
    expect(cropTexture.frame.y).toBeCloseTo(18.8);
    expect(cropTexture.frame.width).toBeCloseTo(40);
    expect(cropTexture.frame.height).toBeCloseTo(40);
    expect(display).toMatchObject({ height: 80, width: 80 });
    expect(display.scale.x).toBe(-1);

    layer.drawFrame(0);
    expect(container.children).toHaveLength(1);
    expect(cropTexture.frame.x).toBeCloseTo(100);
    expect(cropTexture.frame.y).toBeCloseTo(28.8);
    expect(cropTexture.frame.width).toBeCloseTo(40);
    expect(cropTexture.frame.height).toBeCloseTo(40);
    expect(cropTexture.update).toHaveBeenCalled();

    layer.setRenderers([
      {
        ...renderer,
        transform: {
          flip: { vertical: true },
          offset: { x: 0.1, y: -0.2 },
          scale: 3,
        },
      },
    ]);
    expect(container.children).toHaveLength(1);
    expect(display).toMatchObject({ height: 120, width: 120 });
    expect(display.scale).toMatchObject({ x: 1, y: -1 });
    const [x, y] = display.position.set.mock.lastCall!;
    expect(x).toBeCloseTo(124);
    expect(y).toBeCloseTo(40.8);

    layer.destroy();
    expect(cropTexture.destroy).toHaveBeenCalledWith(false);
    expect(mediaTexture.destroy).not.toHaveBeenCalled();
  });

  it("keeps one prepared media effect on a pooled region display", () => {
    FakeBlurFilter.instances = [];
    const mediaTexture = new FakeTexture({
      source: { height: 200, width: 300 },
    });
    const layer = createPixiRegionLayer({
      ...createTestBackend(mediaTexture),
      Assets: { load: vi.fn(), unload: vi.fn() } as never,
      BlurFilter: FakeBlurFilter as never,
      Container: FakeContainer as never,
      GifSprite: FakeGifSprite as never,
      Sprite: FakeSprite as never,
      detectionTimeline: createTimeline(frame),
      regionRenderers: [
        annotationRenderers.region({
          id: "player-blur",
          region: { kind: "bounds" },
          source: {
            effect: { kind: "blur", strength: 10 },
            kind: "media",
            region: { kind: "bounds" },
          },
          target: { className: "player" },
        }),
      ],
    });
    const container = layer.createContainer() as unknown as FakeContainer;

    layer.drawFrame(1);
    const display = container.children[0] as FakeSprite;
    const filter = display.filters?.[0] as FakeBlurFilter;
    layer.drawFrame(1);

    expect(filter.options).toMatchObject({ strength: 10 });
    expect(FakeBlurFilter.instances).toHaveLength(1);
    expect(display.filters).toEqual([filter]);

    layer.destroy();
    expect(filter.destroy).toHaveBeenCalledOnce();
  });

  it("clips a media crop to the detection polygon", () => {
    const mediaTexture = new FakeTexture({
      source: { height: 200, width: 300 },
    });
    const headFrame: DetectionFrame = {
      detections: [
        {
          className: "head",
          id: "head-7",
          polygon: {
            points: [
              { x: 90, y: 30 },
              { x: 110, y: 30 },
              { x: 108, y: 50 },
              { x: 92, y: 50 },
            ],
          },
          rect: { height: 20, width: 20, x: 100, y: 40 },
        },
      ],
      frameIndex: 1,
      mediaTime: 1,
    };
    const layer = createPixiRegionLayer({
      ...createTestBackend(mediaTexture),
      Assets: { load: vi.fn(), unload: vi.fn() } as never,
      Container: FakeContainer as never,
      GifSprite: FakeGifSprite as never,
      Sprite: FakeSprite as never,
      detectionTimeline: createTimeline(headFrame),
      regionRenderers: [
        annotationRenderers.region({
          id: "big-heads",
          region: { kind: "bounds" },
          source: {
            coverage: { kind: RegionRendererCoverageKind.Polygon },
            kind: "media",
            region: { kind: "bounds" },
          },
          target: { className: "head" },
          transform: { scale: 2.5 },
        }),
      ],
    });
    const container = layer.createContainer() as unknown as FakeContainer;

    expect(layer.drawFrame(1).activeDetectionIndexes).toEqual([0]);
    expect(container.children).toHaveLength(2);
    const display = container.children[0]!;
    const mask = container.children[1] as FakeGraphics;
    expect(display).toMatchObject({ height: 50, mask, width: 50 });
    expect(mask.poly).toHaveBeenCalledWith(
      [-10, -10, 10, -10, 8, 10, -8, 10],
      true,
    );
    expect(mask.scale.set).toHaveBeenCalledWith(2.5, 2.5);

    layer.destroy();
    expect(mask.destroy).toHaveBeenCalledOnce();
  });

  it("clips a media crop with the prepared exact detection mask", () => {
    const mediaTexture = new FakeTexture({
      source: { height: 200, width: 300 },
    });
    const idMaskTexture = new FakeTexture({
      source: { height: 200, style: {}, width: 300 },
    });
    const headFrame: DetectionFrame = {
      detections: [
        {
          className: "head",
          id: "head-7",
          mask: {
            counts: "fixture",
            encoding: DetectionMaskEncoding.CompressedRle,
            height: 200,
            width: 300,
          },
          rect: { height: 24, width: 28, x: 100, y: 40 },
        },
      ],
      frameIndex: 1,
      mediaTime: 1,
    };
    const layer = createPixiRegionLayer({
      ...createTestBackend(mediaTexture),
      Assets: { load: vi.fn(), unload: vi.fn() } as never,
      Container: FakeContainer as never,
      GifSprite: FakeGifSprite as never,
      Sprite: FakeSprite as never,
      detectionTimeline: createTimeline(headFrame),
      getActiveRegionMaskCoverage: () =>
        ({
          frame: {
            entries: [
              {
                data: new Uint8Array(400),
                detectionIndex: 0,
                height: 20,
                width: 20,
                x: 90,
                y: 30,
              },
            ],
          },
          getTexture: () => idMaskTexture,
        }) as never,
      regionRenderers: [
        annotationRenderers.region({
          id: "big-heads",
          region: { kind: "bounds" },
          source: {
            coverage: { kind: RegionRendererCoverageKind.Mask },
            kind: "media",
            region: { kind: "bounds" },
          },
          target: { className: "head" },
          transform: { scale: 2.5 },
        }),
      ],
    });
    const container = layer.createContainer() as unknown as FakeContainer;

    expect(layer.drawFrame(1).activeDetectionIndexes).toEqual([0]);
    expect(container.children).toHaveLength(2);
    const display = container.children[0]!;
    const mask = container.children[1] as FakeMesh;
    const maskEffect = (display as FakeSprite).effects[0] as FakeAlphaMask;
    const uniforms = mask.shader.resources
      .regionMaskUniforms as FakeUniformGroup;

    expect(display).toMatchObject({ height: 60, width: 70 });
    expect(maskEffect.mask).toBe(mask);
    const crop = Array.from(uniforms.uniforms.uCrop as Float32Array);
    const expectedCrop = [86, 28, 28, 24];
    crop.forEach((value, index) =>
      expect(value).toBeCloseTo(expectedCrop[index]!),
    );
    expect(Array.from(uniforms.uniforms.uMaskRegion as Float32Array)).toEqual([
      90, 30, 20, 20,
    ]);
    expect(mask.position.set).toHaveBeenCalledWith(100, 40);
    expect(mask.scale.set).toHaveBeenCalledWith(70, 60);
  });

  it("keeps one display across frames for a stable tracker identity", async () => {
    const nextFrame: DetectionFrame = {
      ...frame,
      detections: [
        {
          ...frame.detections[0]!,
          id: "frame-scoped-id",
          trackerId: 42,
        },
      ],
      frameIndex: 2,
      mediaTime: 2,
    };
    const firstFrame: DetectionFrame = {
      ...nextFrame,
      detections: [{ ...nextFrame.detections[0]!, id: "old-id" }],
      frameIndex: 1,
      mediaTime: 1,
    };
    const layer = createPixiRegionLayer({
      ...createTestBackend(),
      Assets: {
        load: vi.fn(async () => ({ height: 10, width: 10 })),
        unload: vi.fn(async () => undefined),
      } as never,
      Container: FakeContainer as never,
      GifSprite: FakeGifSprite as never,
      Sprite: FakeSprite as never,
      detectionTimeline: createTimeline(firstFrame, (mediaTime) =>
        mediaTime < 2 ? firstFrame : nextFrame,
      ),
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

    layer.drawFrame(1);
    const display = container.children[0];
    layer.drawFrame(2);

    expect(container.children).toHaveLength(1);
    expect(container.children[0]).toBe(display);
  });

  it("keeps explicit screen-space assets the same size across detections and zoom", async () => {
    const layer = createPixiRegionLayer({
      ...createTestBackend(),
      Assets: {
        load: vi.fn(async () => ({ height: 20, width: 40 })),
        unload: vi.fn(async () => undefined),
      } as never,
      Container: FakeContainer as never,
      GifSprite: FakeGifSprite as never,
      Sprite: FakeSprite as never,
      detectionTimeline: createTimeline(frame),
      regionRenderers: [
        annotationRenderers.region({
          id: "fixed-badges",
          region: { kind: "bounds" },
          source: { asset: { src: "/badge.svg" }, kind: "asset" },
          target: {},
          transform: {
            size: { space: RegionRendererSizeSpace.Screen, width: 32 },
          },
        }),
      ],
    });
    const container = layer.createContainer() as unknown as FakeContainer;
    await Promise.resolve();

    layer.drawFrame(1, 0.5);
    expect(container.children).toHaveLength(2);
    expect(container.children[0]).toMatchObject({ height: 32, width: 64 });
    expect(container.children[1]).toMatchObject({ height: 32, width: 64 });

    layer.drawFrame(1, 2);
    expect(container.children[0]).toMatchObject({ height: 8, width: 16 });
    expect(container.children[1]).toMatchObject({ height: 8, width: 16 });
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
      ...createTestBackend(),
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
  readonly effects: unknown[] = [];
  filters: readonly unknown[] | null = null;
  readonly anchor = { set: vi.fn() };
  readonly destroy = vi.fn();
  readonly position = {
    set: vi.fn((x: number, y: number) => {
      this.position.x = x;
      this.position.y = y;
    }),
    x: 0,
    y: 0,
  };
  readonly removeFromParent = vi.fn(() => this.parent?.removeChild(this));
  readonly scale = {
    set: vi.fn((x: number, y: number) => {
      this.scale.x = x;
      this.scale.y = y;
    }),
    x: 1,
    y: 1,
  };
  alpha = 1;
  height = 0;
  rotation = 0;
  texture: { height: number; width: number };
  visible = true;
  width = 0;
  zIndex = 0;
  mask: FakeGraphics | null = null;
  parent: FakeContainer | undefined;

  constructor(options: { texture: { height: number; width: number } }) {
    this.texture = options.texture;
  }

  addEffect(effect: unknown) {
    if (!this.effects.includes(effect)) this.effects.push(effect);
  }

  removeEffect(effect: unknown) {
    const index = this.effects.indexOf(effect);
    if (index >= 0) this.effects.splice(index, 1);
  }
}

class FakeAlphaMask {
  readonly destroy = vi.fn();

  constructor(readonly options: { readonly mask: FakeMesh }) {}

  get mask() {
    return this.options.mask;
  }
}

class FakeBlurFilter {
  static instances: FakeBlurFilter[] = [];

  readonly destroy = vi.fn();
  padding = 0;

  constructor(
    readonly options: {
      readonly kernelSize?: number;
      readonly quality?: number;
      readonly repeatEdgePixels?: boolean;
      readonly strength?: number;
    },
  ) {
    FakeBlurFilter.instances.push(this);
  }
}

class FakeGraphics extends FakeSprite {
  readonly clear = vi.fn(() => this);
  readonly fill = vi.fn(() => this);
  readonly poly = vi.fn(() => this);

  constructor() {
    super({ texture: { height: 0, width: 0 } });
  }
}

class FakeRectangle {
  constructor(
    public x = 0,
    public y = 0,
    public width = 0,
    public height = 0,
  ) {}
}

class FakeTexture {
  readonly destroy = vi.fn();
  readonly dynamic: boolean;
  readonly frame: FakeRectangle;
  readonly update = vi.fn();
  source: { height: number; style?: object; width: number };

  constructor(options: {
    readonly dynamic?: boolean;
    readonly frame?: FakeRectangle;
    readonly source: { height: number; style?: object; width: number };
  }) {
    this.dynamic = options.dynamic ?? false;
    this.frame = options.frame ?? new FakeRectangle();
    this.source = options.source;
  }

  get height() {
    return this.frame.height || this.source.height;
  }

  get width() {
    return this.frame.width || this.source.width;
  }
}

class FakeImageSource {
  readonly destroy = vi.fn();
  readonly style = {};

  constructor(
    readonly options: {
      readonly height: number;
      readonly width: number;
    },
  ) {}
}

class FakeUniformGroup {
  readonly update = vi.fn();
  readonly uniforms: Record<string, number | Float32Array>;

  constructor(
    uniforms: Record<string, { readonly value: number | Float32Array }>,
  ) {
    this.uniforms = Object.fromEntries(
      Object.entries(uniforms).map(([key, value]) => [key, value.value]),
    );
  }
}

class FakeShader {
  readonly destroy = vi.fn();

  constructor(readonly resources: Record<string, unknown>) {}
}

class FakeMeshGeometry {
  readonly destroy = vi.fn();
}

class FakeMesh extends FakeSprite {
  shader: FakeShader;

  constructor(options: { shader: FakeShader }) {
    super({ texture: { height: 0, width: 0 } });
    this.shader = options.shader;
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
  selectFrame: (mediaTime: number) => DetectionFrame = () => activeFrame,
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
    selectFrame,
  } as unknown as BufferedDetectionTimeline;
}

function createTestBackend(mediaTexture?: FakeTexture) {
  return {
    AlphaMask: FakeAlphaMask as never,
    Graphics: FakeGraphics as never,
    ImageSource: FakeImageSource as never,
    Mesh: FakeMesh as never,
    MeshGeometry: FakeMeshGeometry as never,
    Rectangle: FakeRectangle as never,
    Shader: {
      from: ({ resources }: { resources: Record<string, unknown> }) =>
        new FakeShader(resources),
    } as never,
    Texture: FakeTexture as never,
    UniformGroup: FakeUniformGroup as never,
    getActiveRegionMaskCoverage: () => null,
    getMediaTexture: () => mediaTexture as never,
  };
}
