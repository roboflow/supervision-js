import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createArrayDetectionFrameSource,
  createBufferedDetectionTimeline,
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
  tickerAdd: vi.fn(),
  tickerRemove: vi.fn(),
  updateGPUTexture: vi.fn(),
}));

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

  class Sprite {
    height = 0;
    texture: unknown;
    width = 0;
    constructor(options: { texture?: unknown } = {}) {
      this.texture = options.texture;
    }
  }

  class Texture {
    constructor(public readonly options: { source?: unknown } = {}) {}
    update = vi.fn();
  }

  class CanvasSource {
    constructor(public readonly options: unknown) {}
    update = vi.fn();
  }

  class ColorMatrixFilter {
    brightness = vi.fn();
    contrast = vi.fn();
    constructor() {
      pixiMock.displayFilters.push(this);
    }
  }

  class ExternalSource {
    constructor(public readonly options: unknown) {}
    updateGPUTexture = pixiMock.updateGPUTexture;
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
  createElement: () => ({
    getContext: () => ({ drawImage: vi.fn() }),
    height: 0,
    toBlob: (receive: (blob: Blob) => void, type: string) =>
      receive(new Blob([], { type })),
    width: 0,
  }),
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

function presentedFrame(mediaTimeMs: number) {
  return {
    frame: {
      close: vi.fn(),
      displayHeight: 240,
      displayWidth: 320,
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
