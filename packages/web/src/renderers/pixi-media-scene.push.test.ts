import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createArrayDetectionFrameSource,
  createBufferedDetectionTimeline,
  type DetectionFrame,
} from "supervision-js-core";

import type {
  MediaRendererScene,
  MediaRendererSceneOptions,
} from "./media-renderer-scene";
import type { MediaRendererPresentation } from "#types/media-renderer";
import type { PresentedVideoFrame } from "./presented-frame-channel";
import { MediaRendererFit } from "#types/media-renderer";

const pixiMock = vi.hoisted(() => ({
  copyExternalImageToTexture: vi.fn(),
  displayFilters: [] as unknown[],
  extractCanvas: vi.fn(() => ({ height: 240, width: 320 })),
  render: vi.fn(),
  sprites: [] as PaintedSprite[],
  tickerAdd: vi.fn(),
  tickerRemove: vi.fn(),
  updateGPUTexture: vi.fn(),
}));

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
    quad = { height: 0, width: 0 };
    scale = { x: 1, y: 1 };
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
    readonly orig: { height: number; width: number };
    update = vi.fn();
    private readonly _listeners: (() => void)[] = [];

    constructor(
      public readonly options: { dynamic?: boolean; source?: MockSource } = {},
    ) {
      const source = options.source;

      this.dynamic = options.dynamic ?? false;
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

  class ExternalSource {
    height: number;
    width: number;
    private readonly _listeners: (() => void)[] = [];

    constructor(
      public readonly options: {
        resource?: { height: number; width: number };
      } = {},
    ) {
      this.height = options.resource?.height ?? 0;
      this.width = options.resource?.width ?? 0;
    }

    onResize(listener: () => void) {
      this._listeners.push(listener);
    }

    updateGPUTexture(texture: { height: number; width: number }) {
      pixiMock.updateGPUTexture(texture);
      this.height = texture.height;
      this.width = texture.width;
      for (const listener of this._listeners) listener();
    }
  }

  return {
    Application,
    Assets: { load: vi.fn(), unload: vi.fn() },
    CanvasSource,
    ColorMatrixFilter,
    Container,
    ExternalSource,
    Graphics,
    ImageSource: Stub,
    Mesh: Stub,
    MeshGeometry: Stub,
    Rectangle: Stub,
    Shader: Stub,
    Sprite,
    Text: Stub,
    Texture,
    UniformGroup: Stub,
  };
});

vi.mock("pixi.js/gif", () => ({ GifSprite: class {} }));

const documentMock = {
  addEventListener: vi.fn(),
  createElement: (tagName: string) =>
    tagName === "div"
      ? { appendChild: vi.fn(), style: {} }
      : {
          getContext: () => ({ drawImage: vi.fn() }),
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
  pixiMock.displayFilters.length = 0;
  pixiMock.extractCanvas.mockClear();
  pixiMock.render.mockClear();
  pixiMock.sprites.length = 0;
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

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
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
    mediaTimeMs,
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
    boxStyle: undefined,
    canInteract: () => false,
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
