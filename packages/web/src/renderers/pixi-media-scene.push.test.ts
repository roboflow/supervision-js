import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  annotationRenderers,
  createArrayDetectionFrameSource,
  createBufferedDetectionTimeline,
  createIdleDetectionBufferState,
  RegionRendererRegionKind,
  RegionRendererSourceKind,
  type DetectionFrame,
} from "supervision-js-core";

import type {
  MediaRendererScene,
  MediaRendererSceneOptions,
  PresentedMediaSample,
} from "./media-renderer-scene";
import type { MediaRendererPresentation } from "#types/media-renderer";
import type { PresentedVideoFrame } from "./presented-frame-channel";
import { MediaRendererFit } from "#types/media-renderer";

const pixiMock = vi.hoisted(() => ({
  copyExternalImageToTexture: vi.fn(),
  externalSources: [] as MockExternalSource[],
  displayFilters: [] as unknown[],
  extractCanvas: vi.fn(() => ({ height: 240, width: 320 })),
  render: vi.fn(),
  sprites: [] as PaintedSprite[],
  textures: [] as MockTextureInstance[],
  tickerAdd: vi.fn(),
  tickerRemove: vi.fn(),
  updateGPUTexture: vi.fn(),
}));

/** The dimensions a source advertises, and the ones its texture really has. */
interface MockExternalSource {
  height: number;
  pixelHeight: number;
  pixelWidth: number;
  width: number;
}

interface MockTextureInstance {
  readonly frame?: { height: number; width: number; x: number; y: number };
  readonly source: unknown;
}

/**
 * What the batcher would put on screen: the quad Pixi last built from the
 * texture's dimensions, scaled by the sprite's transform.
 */
interface PaintedSprite {
  readonly quad: { height: number; width: number };
  readonly scale: { x: number; y: number };
}

// Push mode asks Pixi for WebGPU, so the mock renderer carries a device: the
// scene then composites through the GPU path production runs, not the staging
// canvas fallback.
vi.mock("pixi.js", () => {
  class Stub {}

  class Application {
    canvas = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      style: {},
    };
    renderer = {
      background: { color: 0 },
      extract: { canvas: pixiMock.extractCanvas },
      gpu: {
        device: {
          createTexture: (descriptor: {
            size: { height: number; width: number };
          }) => ({
            destroy: vi.fn(),
            height: descriptor.size.height,
            width: descriptor.size.width,
          }),
          queue: {
            copyExternalImageToTexture: pixiMock.copyExternalImageToTexture,
          },
        },
      },
      name: "webgpu",
      resize: vi.fn(),
      resolution: 1,
    };
    screen = { height: 360, width: 640 };
    stage = { addChild: vi.fn() };
    ticker = { add: pixiMock.tickerAdd, remove: pixiMock.tickerRemove };
    cancelResize = vi.fn();
    destroy = vi.fn();
    init = vi.fn(async () => undefined);
    render = pixiMock.render;
    resize = vi.fn();
  }

  class Container {
    children: unknown[] = [];
    position = { set: vi.fn() };
    scale = { set: vi.fn() };
    addChild(...children: unknown[]) {
      this.children.push(...children);
      return children[0];
    }
    removeChild() {
      return undefined;
    }
  }

  class Graphics extends Container {
    clear = vi.fn(() => this);
    fill = vi.fn(() => this);
    rect = vi.fn(() => this);
    roundRect = vi.fn(() => this);
    stroke = vi.fn(() => this);
    visible = true;
  }

  interface MockSource {
    readonly height: number;
    readonly width: number;
    onResize?: (listener: () => void) => void;
  }

  interface MockTexture {
    readonly dynamic: boolean;
    readonly orig: { height: number; width: number };
    onUpdate: (listener: () => void) => void;
  }

  /**
   * Models the sprite behaviour the media scene leans on: `width` only writes
   * the scale Pixi derives from the texture's current dimensions, and the quad
   * the batcher paints is rebuilt only when the sprite is told its view
   * changed, which a texture reports only while it is dynamic.
   */
  class Sprite {
    alpha = 1;
    anchor = { set: vi.fn() };
    position = { set: vi.fn() };
    quad = { height: 0, width: 0 };
    rotation = 0;
    scale = { x: 1, y: 1 };
    visible = false;
    zIndex = 0;
    destroy = vi.fn();
    private _height: number | undefined;
    private _texture: MockTexture | undefined;
    private _width: number | undefined;

    constructor(options: { texture?: MockTexture } = {}) {
      pixiMock.sprites.push(this);
      if (options.texture) this.texture = options.texture;
    }

    get texture(): MockTexture | undefined {
      return this._texture;
    }

    set texture(value: MockTexture | undefined) {
      this._texture = value;
      if (value?.dynamic) value.onUpdate(() => this.onViewUpdate());
      if (this._width !== undefined) this.width = this._width;
      if (this._height !== undefined) this.height = this._height;
      this.onViewUpdate();
    }

    get width() {
      return Math.abs(this.scale.x) * (this._texture?.orig.width ?? 0);
    }

    set width(value: number) {
      const local = this._texture?.orig.width ?? 0;
      this.scale.x = local === 0 ? 1 : value / local;
      this._width = value;
    }

    get height() {
      return Math.abs(this.scale.y) * (this._texture?.orig.height ?? 0);
    }

    set height(value: number) {
      const local = this._texture?.orig.height ?? 0;
      this.scale.y = local === 0 ? 1 : value / local;
      this._height = value;
    }

    onViewUpdate() {
      this.quad.height = this._texture?.orig.height ?? 0;
      this.quad.width = this._texture?.orig.width ?? 0;
    }
  }

  class Texture {
    readonly dynamic: boolean;
    readonly frame?: { height: number; width: number; x: number; y: number };
    readonly orig: { height: number; width: number };
    source: MockSource | undefined;
    update = vi.fn();
    private readonly _listeners: (() => void)[] = [];

    constructor(
      public readonly options: {
        dynamic?: boolean;
        frame?: { height: number; width: number; x: number; y: number };
        source?: MockSource;
      } = {},
    ) {
      const source = options.source;

      pixiMock.textures.push(this);
      this.dynamic = options.dynamic ?? false;
      this.frame = options.frame;
      this.source = source;
      this.orig = { height: source?.height ?? 0, width: source?.width ?? 0 };
      source?.onResize?.(() => {
        this.orig.height = source.height;
        this.orig.width = source.width;
        for (const listener of this._listeners) listener();
      });
    }

    onUpdate(listener: () => void) {
      this._listeners.push(listener);
    }
  }

  class CanvasSource {
    readonly height: number;
    readonly width: number;
    update = vi.fn();

    constructor(
      public readonly options: { height?: number; width?: number } = {},
    ) {
      this.height = options.height ?? 0;
      this.width = options.width ?? 0;
    }
  }

  class ColorMatrixFilter {
    brightness = vi.fn();
    contrast = vi.fn();
    constructor() {
      pixiMock.displayFilters.push(this);
    }
  }

  class Rectangle {
    constructor(
      public x: number,
      public y: number,
      public width: number,
      public height: number,
    ) {}
  }

  class ExternalSource {
    height: number;
    pixelHeight: number;
    pixelWidth: number;
    width: number;
    private readonly _listeners: (() => void)[] = [];

    constructor(
      public readonly options: {
        resource?: { height: number; width: number };
      } = {},
    ) {
      this.height = options.resource?.height ?? 0;
      this.width = options.resource?.width ?? 0;
      this.pixelHeight = this.height;
      this.pixelWidth = this.width;
      pixiMock.externalSources.push(this);
    }

    onResize(listener: () => void) {
      this._listeners.push(listener);
    }

    resize(width: number, height: number, resolution: number) {
      this.height = height;
      this.width = width;
      this.pixelHeight = Math.round(height * resolution);
      this.pixelWidth = Math.round(width * resolution);
      for (const listener of this._listeners) listener();
    }

    updateGPUTexture(texture: { height: number; width: number }) {
      pixiMock.updateGPUTexture(texture);
      this.height = texture.height;
      this.width = texture.width;
      this.pixelHeight = texture.height;
      this.pixelWidth = texture.width;
      for (const listener of this._listeners) listener();
    }
  }

  return {
    AlphaMask: Stub,
    Application,
    Assets: { load: vi.fn(), unload: vi.fn() },
    BlurFilter: Stub,
    BufferImageSource: Stub,
    CanvasSource,
    ColorMatrixFilter,
    Container,
    defaultFilterVert: "default-filter-vertex",
    ExternalSource,
    Filter: Stub,
    Graphics,
    ImageSource: Stub,
    Mesh: Stub,
    MeshGeometry: Stub,
    Rectangle,
    Shader: Stub,
    Sprite,
    Text: Stub,
    Texture,
    UniformGroup: Stub,
  };
});

vi.mock("pixi.js/gif", () => ({ GifSprite: class {} }));

/** Shared so a test can see what the staging fallback drew into it. */
const stagingContext = { drawImage: vi.fn() };

const documentMock = {
  addEventListener: vi.fn(),
  createElement: (tagName: string) =>
    tagName === "div"
      ? { appendChild: vi.fn(), style: {} }
      : {
          getContext: () => stagingContext,
          height: 0,
          style: {},
          toBlob: (receive: (blob: Blob) => void, type: string) =>
            receive(new Blob([], { type })),
          width: 0,
        },
  hidden: false,
  removeEventListener: vi.fn(),
};

beforeEach(() => {
  vi.stubGlobal("document", documentMock);
  vi.stubGlobal("window", { devicePixelRatio: 1 });
  vi.stubGlobal("ResizeObserver", undefined);
  vi.stubGlobal("GPUTextureUsage", {
    COPY_DST: 1,
    RENDER_ATTACHMENT: 2,
    TEXTURE_BINDING: 4,
  });
  // Before the scene takes the GPU path it asks the device whether it converts
  // a decoded frame at all, and it asks by building one, so a browser that has
  // WebCodecs is part of what this mock stands for.
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      getContext() {
        return { fillRect: vi.fn() };
      }
    },
  );
  vi.stubGlobal(
    "VideoFrame",
    class {
      close() {}
    },
  );
  pixiMock.copyExternalImageToTexture.mockReset();
  pixiMock.displayFilters.length = 0;
  pixiMock.extractCanvas.mockClear();
  stagingContext.drawImage.mockClear();
  pixiMock.render.mockClear();
  pixiMock.externalSources.length = 0;
  pixiMock.sprites.length = 0;
  pixiMock.textures.length = 0;
  pixiMock.tickerAdd.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("push-presented Pixi scene", () => {
  it("renders once per presented frame and nothing else", async () => {
    const channel = createChannel();
    const { createPixiMediaScene } = await import("./pixi-media-scene");
    const scene = await createPixiMediaScene(
      createSceneOptions(channel.channel),
    );
    scene.initializeMedia({ height: 240, width: 320 });

    const first = presentedFrame(1000);
    const second = presentedFrame(2000);
    channel.present(first);
    channel.present(second);

    expect(scene.getRenderCount?.()).toBe(2);
    expect(first.frame.close).toHaveBeenCalledTimes(1);
    expect(second.frame.close).toHaveBeenCalledTimes(1);
  });

  it("gives every frame it presents a serial of its own", async () => {
    const channel = createChannel();
    const presented: PresentedMediaSample[] = [];
    const { createPixiMediaScene } = await import("./pixi-media-scene");
    const scene = await createPixiMediaScene({
      ...createSceneOptions(channel.channel),
      onPresentationUpdate: (sample) => presented.push(sample),
    });
    scene.initializeMedia({ height: 240, width: 320 });

    channel.present(presentedFrame(1000));
    channel.present(presentedFrame(1000));
    channel.present(presentedFrame(2000));

    expect(presented.map((sample) => sample.mediaTime)).toEqual([1, 1, 2]);
    expect(
      new Set(presented.map((sample) => sample.presentedFrameSerial)).size,
    ).toBe(3);
  });

  it("reports the detection frame the layers drew, not the one selected at completion", async () => {
    const drawnFrame: DetectionFrame = {
      detections: [],
      frameIndex: 7,
      mediaTime: 1,
    };
    const revisedFrame: DetectionFrame = {
      detections: [],
      frameIndex: 8,
      mediaTime: 1,
    };
    let answer = drawnFrame;
    const channel = createChannel();
    const presented: PresentedMediaSample[] = [];
    const { createPixiMediaScene } = await import("./pixi-media-scene");
    const scene = await createPixiMediaScene({
      ...createSceneOptions(channel.channel),
      detectionTimeline: stubDetectionTimeline(() => answer),
      onPresentationUpdate: (sample) => presented.push(sample),
    });
    scene.initializeMedia({ height: 240, width: 320 });
    // A detection load landing between the draw and the completion: the same
    // media time now answers a different frame from the one on screen.
    pixiMock.render.mockImplementationOnce(() => {
      answer = revisedFrame;
    });

    channel.present(presentedFrame(1000));

    expect(pixiMock.render).toHaveBeenCalled();
    expect(presented).toHaveLength(1);
    expect(presented[0].activeDetectionFrameIndex).toBe(drawnFrame.frameIndex);
    expect(presented[0].activeDetectionFrameTime).toBe(drawnFrame.mediaTime);
  });

  it("measures the present it makes when frame timings are asked for", async () => {
    const channel = createChannel();
    const presented: PresentedMediaSample[] = [];
    const { createPixiMediaScene } = await import("./pixi-media-scene");
    const scene = await createPixiMediaScene({
      ...createSceneOptions(channel.channel),
      diagnostics: { frameTimings: true },
      onPresentationUpdate: (sample) => presented.push(sample),
    });
    scene.initializeMedia({ height: 240, width: 320 });

    channel.present(presentedFrame(1000));

    // A push-presented scene never pulls a sample, so timings only the pull
    // path fills leave every per-layer cost unmeasured for the whole session.
    expect(presented[0].renderTimings).toEqual({
      boxMs: expect.any(Number),
      fitMs: expect.any(Number),
      focusMs: expect.any(Number),
      interactionMs: expect.any(Number),
      labelMs: expect.any(Number),
      maskMs: expect.any(Number),
      mediaUploadMs: expect.any(Number),
      totalMs: expect.any(Number),
    });
  });

  it("renders a burst of presents once per display refresh", async () => {
    const frames = stubAnimationFrames();
    const channel = createChannel();
    const { createPixiMediaScene } = await import("./pixi-media-scene");
    const scene = await createPixiMediaScene(
      createSceneOptions(channel.channel),
    );
    scene.initializeMedia({ height: 240, width: 320 });

    channel.present(presentedFrame(1000));
    channel.present(presentedFrame(2000));
    channel.present(presentedFrame(3000));

    expect(scene.getRenderCount?.()).toBe(1);

    frames.run();

    expect(scene.getRenderCount?.()).toBe(2);

    frames.run();

    // Nothing was deferred by the second render, so the scene stops asking for
    // frames instead of holding one open forever.
    expect(scene.getRenderCount?.()).toBe(2);
    expect(frames.pending()).toBe(0);
  });

  it("renders the next present straight away once the burst has drained", async () => {
    const frames = stubAnimationFrames();
    const channel = createChannel();
    const { createPixiMediaScene } = await import("./pixi-media-scene");
    const scene = await createPixiMediaScene(
      createSceneOptions(channel.channel),
    );
    scene.initializeMedia({ height: 240, width: 320 });

    channel.present(presentedFrame(1000));
    frames.run();
    channel.present(presentedFrame(2000));

    expect(scene.getRenderCount?.()).toBe(2);
  });

  it("closes every frame of a burst even though most of them never render", async () => {
    const frames = stubAnimationFrames();
    const channel = createChannel();
    const { createPixiMediaScene } = await import("./pixi-media-scene");
    const scene = await createPixiMediaScene(
      createSceneOptions(channel.channel),
    );
    scene.initializeMedia({ height: 240, width: 320 });

    const burst = [1000, 2000, 3000, 4000].map((time) => presentedFrame(time));

    for (const presented of burst) {
      channel.present(presented);
    }

    expect(scene.getRenderCount?.()).toBe(1);
    for (const presented of burst.slice(0, -1)) {
      expect(presented.frame.close).toHaveBeenCalledTimes(1);
    }
    expect(burst.at(-1)?.frame.close).not.toHaveBeenCalled();

    frames.run();

    expect(scene.getRenderCount?.()).toBe(2);
    expect(burst.at(-1)?.frame.close).toHaveBeenCalledTimes(1);
  });

  it("leaves Pixi's ticker unused so nothing free-runs", async () => {
    const channel = createChannel();
    const { createPixiMediaScene } = await import("./pixi-media-scene");
    const scene = await createPixiMediaScene(
      createSceneOptions(channel.channel),
    );
    scene.initializeMedia({ height: 240, width: 320 });

    expect(pixiMock.tickerAdd).not.toHaveBeenCalled();
  });

  it("holds at zero renders while paused, untouched, for ten seconds", async () => {
    vi.useFakeTimers();
    const channel = createChannel();
    const { createPixiMediaScene } = await import("./pixi-media-scene");
    const scene = await createPixiMediaScene(
      createSceneOptions(channel.channel),
    );
    scene.initializeMedia({ height: 240, width: 320 });

    vi.advanceTimersByTime(10_000);

    expect(scene.getRenderCount?.()).toBe(0);
    expect(pixiMock.render).not.toHaveBeenCalled();
    // Fake timers stand in for animation frames too, so an empty queue means
    // the scene left nothing behind that could wake it up.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores notifications that describe what is already drawn", async () => {
    const channel = createChannel();
    const { createPixiMediaScene } = await import("./pixi-media-scene");
    const scene = await createPixiMediaScene(
      createSceneOptions(channel.channel),
    );
    scene.initializeMedia({ height: 240, width: 320 });
    channel.present(presentedFrame(2000));

    const presentation: MediaRendererPresentation = {};
    scene.setPresentation(presentation, 2);
    const settled = scene.getRenderCount?.();

    scene.setPresentation(presentation, 2);
    scene.setPresentation(presentation, 2);
    scene.setPresentation(presentation, 2);

    expect(scene.getRenderCount?.()).toBe(settled);
  });

  it("renders a style swap on a memoized renderer list", async () => {
    const channel = createChannel();
    const { createPixiMediaScene } = await import("./pixi-media-scene");
    const scene = await createPixiMediaScene(
      createSceneOptions(channel.channel),
    );
    scene.initializeMedia({ height: 240, width: 320 });
    channel.present(presentedFrame(2000));

    const renderers = [annotationRenderers.marker()];
    scene.setPresentation(
      { markerStyle: { resolve: () => undefined }, renderers },
      2,
    );
    const settled = scene.getRenderCount?.();

    scene.setPresentation(
      { markerStyle: { resolve: () => undefined }, renderers },
      2,
    );

    expect(scene.getRenderCount?.()).toBe((settled ?? 0) + 1);
  });

  it.each(
    Object.keys(
      createPopulatedPresentation(),
    ) as (keyof MediaRendererPresentation)[],
  )("repaints when %s alone changes", async (field) => {
    const channel = createChannel();
    const { createPixiMediaScene } = await import("./pixi-media-scene");
    const scene = await createPixiMediaScene(
      createSceneOptions(channel.channel),
    );
    scene.initializeMedia({ height: 240, width: 320 });
    channel.present(presentedFrame(2000));

    const applied = createPopulatedPresentation();
    scene.setPresentation(applied, 2);
    const settled = scene.getRenderCount?.();

    scene.setPresentation(changePresentationField(applied, field), 2);

    expect(scene.getRenderCount?.()).toBe((settled ?? 0) + 1);
  });

  it("renders a display adjustment once, and a repeat of it never", async () => {
    const channel = createChannel();
    const { createPixiMediaScene } = await import("./pixi-media-scene");
    const scene = await createPixiMediaScene(
      createSceneOptions(channel.channel),
    );
    scene.initializeMedia({ height: 240, width: 320 });
    channel.present(presentedFrame(2000));
    const presented = scene.getRenderCount?.();

    await applyDisplayAdjustment(scene);
    const adjusted = scene.getRenderCount?.();

    await applyDisplayAdjustment(scene);
    await applyDisplayAdjustment(scene);
    await applyDisplayAdjustment(scene);

    expect([adjusted, scene.getRenderCount?.()]).toStrictEqual([
      (presented ?? 0) + 1,
      adjusted,
    ]);
  });

  it("keeps the media on the staging canvas when the device refuses a decoded frame", async () => {
    // The refusal lands on the capability probe, which is the first copy the
    // scene asks for. Firefox refuses every one after it too, and the point of
    // asking first is that none of them is a presented frame.
    pixiMock.copyExternalImageToTexture.mockImplementationOnce(() => {
      throw new TypeError("source could not be converted");
    });
    const channel = createChannel();
    const { createPixiMediaScene } = await import("./pixi-media-scene");
    const scene = await createPixiMediaScene(
      createSceneOptions(channel.channel),
    );
    scene.initializeMedia({ height: 240, width: 320 });

    const presented = presentedFrame(2000);
    channel.present(presented);

    expect(pixiMock.externalSources).toStrictEqual([]);
    expect(stagingContext.drawImage).toHaveBeenCalledTimes(1);
    expect(presented.frame.close).toHaveBeenCalledTimes(1);
    expect(pixiMock.render).toHaveBeenCalled();
  });

  it("captures at the media's size off the staging canvas, whatever was decoded", async () => {
    // Decode size follows the viewport. The exported still must not.
    pixiMock.copyExternalImageToTexture.mockImplementationOnce(() => {
      throw new TypeError("source could not be converted");
    });
    const channel = createChannel();
    const { createPixiMediaScene } = await import("./pixi-media-scene");
    const scene = await createPixiMediaScene(
      createSceneOptions(channel.channel),
    );
    scene.initializeMedia({ height: 240, width: 320 });

    channel.present(presentedFrame(2000, { height: 120, width: 160 }));
    const capture = await scene.captureFrame?.(undefined);

    expect(capture).toMatchObject({ height: 240, mediaTime: 2, width: 320 });
    expect(pixiMock.extractCanvas).not.toHaveBeenCalled();
  });

  it("captures the pixels the compositor put on screen", async () => {
    const channel = createChannel();
    const { createPixiMediaScene } = await import("./pixi-media-scene");
    const scene = await createPixiMediaScene(
      createSceneOptions(channel.channel),
    );
    scene.initializeMedia({ height: 240, width: 320 });

    channel.present(presentedFrame(2000));
    const capture = await scene.captureFrame?.(undefined);

    expect(capture).toMatchObject({ height: 240, mediaTime: 2, width: 320 });
    expect(pixiMock.extractCanvas).toHaveBeenCalledTimes(1);
  });

  it("paints the media at its own size when decode sizes alternate", async () => {
    const channel = createChannel();
    const { createPixiMediaScene } = await import("./pixi-media-scene");
    const scene = await createPixiMediaScene(
      createSceneOptions(channel.channel),
    );
    scene.initializeMedia({ height: 240, width: 320 });

    const media = pixiMock.sprites[0];
    const sizes = [
      { height: 240, width: 320 },
      { height: 120, width: 160 },
      { height: 240, width: 320 },
      { height: 90, width: 120 },
      { height: 240, width: 320 },
    ];
    const painted = sizes.map((size, index) => {
      channel.present(presentedFrame((index + 1) * 1000, size));

      return {
        height: media.scale.y * media.quad.height,
        width: media.scale.x * media.quad.width,
      };
    });

    expect(painted).toStrictEqual(
      sizes.map(() => ({ height: 240, width: 320 })),
    );
  });

  it("crops a media region out of the frame the compositor presented", async () => {
    const load = createDeferred<readonly DetectionFrame[]>();
    const detectionTimeline = createBufferedDetectionTimeline({
      source: { loadFrames: () => load.promise },
    });
    const channel = createChannel();
    const { createPixiMediaScene } = await import("./pixi-media-scene");
    const scene = await createPixiMediaScene({
      ...createSceneOptions(channel.channel),
      detectionTimeline,
    });
    scene.initializeMedia({ height: 240, width: 320 });
    scene.setPresentation(
      {
        renderers: [
          annotationRenderers.region({
            id: "head-crop",
            region: { kind: RegionRendererRegionKind.Bounds },
            source: {
              kind: RegionRendererSourceKind.Media,
              region: { kind: RegionRendererRegionKind.Bounds },
            },
            target: { className: "head" },
          }),
        ],
      },
      1,
    );

    const prepared = detectionTimeline.prepare(1);

    load.resolve([
      {
        detections: [
          {
            className: "head",
            rect: { height: 30, width: 40, x: 160, y: 120 },
          },
        ],
        mediaTime: 1,
      },
    ]);
    await prepared;
    // A proxy decode: the same picture at half the media's resolution.
    channel.present(presentedFrame(1000, { height: 120, width: 160 }));

    const presentedSource = pixiMock.externalSources.at(-1);
    const crop = pixiMock.textures.find((texture) => texture.frame);

    expect(crop?.source).toBe(presentedSource);
    expect({ ...crop?.frame }).toStrictEqual({
      height: 30,
      width: 40,
      x: 140,
      y: 105,
    });
  });

  it("publishes the detections a load lands after the picture already went up", async () => {
    const load = createDeferred<readonly DetectionFrame[]>();
    const detectionTimeline = createBufferedDetectionTimeline({
      source: { loadFrames: () => load.promise },
    });
    const onPresentationUpdate = vi.fn();
    const channel = createChannel();
    const { createPixiMediaScene } = await import("./pixi-media-scene");
    const scene = await createPixiMediaScene({
      ...createSceneOptions(channel.channel),
      detectionTimeline,
      onPresentationUpdate,
    });
    scene.initializeMedia({ height: 240, width: 320 });

    const prepared = detectionTimeline.prepare(1);
    channel.present(presentedFrame(1000));

    expect(onPresentationUpdate.mock.lastCall?.[0]).toMatchObject({
      activeDetectionCount: 0,
      activeDetectionFrameTime: null,
    });

    load.resolve([
      {
        detections: [{ rect: { height: 10, width: 10, x: 0, y: 0 } }],
        mediaTime: 1,
      },
    ]);
    await prepared;

    expect(onPresentationUpdate.mock.lastCall?.[0]).toMatchObject({
      activeDetectionCount: 1,
      activeDetectionFrameTime: 1,
    });
  });

  it("keeps driving the ticker when the source has no frame channel", async () => {
    const { createPixiMediaScene } = await import("./pixi-media-scene");
    const scene = await createPixiMediaScene(createSceneOptions(undefined));
    scene.initializeMedia({ height: 240, width: 320 });

    expect(pixiMock.tickerAdd).toHaveBeenCalled();
    expect(pixiMock.render).not.toHaveBeenCalled();
    expect(scene.getRenderCount?.()).toBeNull();
  });
});

/**
 * Writes the same display adjustment and waits out the dynamic `pixi.js` import
 * it goes through. Overlapping those imports leaves all but the first resolving
 * against the real Pixi rather than the mock, so they go one at a time, and the
 * filter each one builds is what says the write landed.
 */
async function applyDisplayAdjustment(scene: MediaRendererScene) {
  const built = pixiMock.displayFilters.length + 1;

  scene.setDisplayAdjustments?.({ brightness: 1.4, contrast: 0.8 });
  await vi.waitFor(() => expect(pixiMock.displayFilters).toHaveLength(built));
}

/**
 * `Required` is what keeps the cases exhaustive: a presentation field added to
 * the contract lands here as a missing property.
 */
function createPopulatedPresentation(): Required<MediaRendererPresentation> {
  return {
    annotationOverlayStyle: {},
    backgroundColor: 0x101010,
    boxCornerStyle: createStyle(),
    boxStyle: createStyle(),
    ellipseStyle: createStyle(),
    focusStyle: createStyle(),
    interactionStyle: createStyle(),
    keypointStyle: createStyle(),
    labelStyle: createStyle(),
    markerStyle: createStyle(),
    maskHaloStyle: createStyle(),
    maskStyle: createStyle(),
    polygonStyle: createStyle(),
    polylineStyle: createStyle(),
    renderers: [annotationRenderers.marker()],
    visibility: {},
  };
}

/** Styles compare by identity, so a fresh one is a changed one. */
function createStyle() {
  return { resolve: () => undefined };
}

function changePresentationField(
  applied: Required<MediaRendererPresentation>,
  field: keyof MediaRendererPresentation,
): MediaRendererPresentation {
  if (field === "backgroundColor") {
    return { ...applied, backgroundColor: applied.backgroundColor + 1 };
  }

  return { ...applied, [field]: createPopulatedPresentation()[field] };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
}

/**
 * Animation frames the test drives by hand. A scene that coalesces on the
 * display refresh cannot be measured against a refresh that never arrives.
 */
function stubAnimationFrames() {
  let nextHandle = 0;
  const callbacks = new Map<number, () => void>();

  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    nextHandle += 1;
    callbacks.set(nextHandle, callback);
    return nextHandle;
  });
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
    callbacks.delete(handle);
  });

  return {
    pending: () => callbacks.size,
    run() {
      const due = [...callbacks.values()];
      callbacks.clear();
      for (const callback of due) {
        callback();
      }
    },
  };
}

/** A timeline whose answer for a media time is whatever the test says it is
 *  at the moment it is asked. */
function stubDetectionTimeline(
  answer: () => DetectionFrame | undefined,
): MediaRendererSceneOptions["detectionTimeline"] {
  return {
    async prepare() {},
    prefetch() {},
    selectFrame: () => answer(),
    getBufferedFrames: () => [],
    getState: () => createIdleDetectionBufferState(),
    destroy() {},
  };
}

function createChannel() {
  let handler: ((presented: PresentedVideoFrame) => void) | null = null;

  return {
    channel: {
      onPresentedFrame(next: (presented: PresentedVideoFrame) => void) {
        handler = next;
      },
    },
    present(presented: PresentedVideoFrame) {
      handler?.(presented);
    },
  };
}

function presentedFrame(
  mediaTimeMs: number,
  size: { readonly height: number; readonly width: number } = {
    height: 240,
    width: 320,
  },
) {
  return {
    frame: {
      close: vi.fn(),
      displayHeight: size.height,
      displayWidth: size.width,
    },
    frameId: { index: mediaTimeMs / 1000, ticks: mediaTimeMs },
    mediaTimeMs,
    mediaTimeS: mediaTimeMs / 1000,
  } as unknown as PresentedVideoFrame & {
    readonly frame: { readonly close: ReturnType<typeof vi.fn> };
  };
}

function createSceneOptions(
  presentedFrames: MediaRendererSceneOptions["presentedFrames"],
): MediaRendererSceneOptions {
  return {
    annotationOverlayStyle: null,
    backgroundColor: undefined,
    boxCornerStyle: undefined,
    boxStyle: undefined,
    canInteract: () => false,
    ellipseStyle: undefined,
    markerStyle: undefined,
    maskHaloStyle: undefined,
    container: {
      appendChild: vi.fn(),
      clientHeight: 360,
      clientWidth: 640,
    } as unknown as HTMLElement,
    detectionTimeline: createBufferedDetectionTimeline({
      source: createArrayDetectionFrameSource([]),
    }),
    diagnostics: undefined,
    editingEngine: undefined,
    fit: MediaRendererFit.Contain,
    focusStyle: null,
    interaction: undefined,
    interactionStyle: null,
    keypointStyle: null,
    labelStyle: null,
    maskBrush: undefined,
    maskStyle: null,
    maxDevicePixelRatio: 1,
    polygonStyle: undefined,
    polylineStyle: null,
    presentedFrames,
    previewOverlay: undefined,
    regionRenderers: [],
    renderPreparation: undefined,
    shapeStyle: null,
    visibility: undefined,
  };
}
