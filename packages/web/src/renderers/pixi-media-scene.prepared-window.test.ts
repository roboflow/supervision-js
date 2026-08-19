import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BaseFocusStyle,
  createArrayDetectionFrameSource,
  createBufferedDetectionTimeline,
} from "supervision-js-core";
import type {
  BufferedDetectionTimeline,
  DetectionFrame,
  FocusStyle,
  MaskStyle,
  PolygonStyle,
} from "supervision-js-core";
import {
  RenderPreparationArtifactFrameStatus,
  RenderPreparationArtifactKind,
  type RenderPreparationDiagnostics,
  type RenderPreparationOptions,
} from "#types/render-preparation";

import type {
  MediaRendererSceneOptions,
  PresentedMediaSample,
} from "./media-renderer-scene";
import type { MediaRendererPresentation } from "#types/media-renderer";
import type { PresentedVideoFrame } from "./presented-frame-channel";
import { MediaRendererFit } from "#types/media-renderer";

const pixiMock = vi.hoisted(() => ({
  graphics: [] as { clear: () => void; rect: () => void }[],
  render: vi.fn(),
}));

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
      extract: { canvas: vi.fn() },
      gpu: {
        device: {
          createTexture: (descriptor: {
            size: { height: number; width: number };
          }) => ({
            destroy: vi.fn(),
            height: descriptor.size.height,
            width: descriptor.size.width,
          }),
          queue: { copyExternalImageToTexture: vi.fn() },
        },
      },
      name: "webgpu",
      resize: vi.fn(),
      resolution: 1,
    };
    screen = { height: 360, width: 640 };
    stage = { addChild: vi.fn() };
    ticker = { add: vi.fn(), remove: vi.fn() };
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
    cut = vi.fn(() => this);
    fill = vi.fn(() => this);
    poly = vi.fn(() => this);
    rect = vi.fn(() => this);
    roundRect = vi.fn(() => this);
    stroke = vi.fn(() => this);
    visible = true;
    constructor() {
      super();
      pixiMock.graphics.push(this as never);
    }
  }

  class Sprite {
    alpha = 1;
    height = 0;
    texture: unknown;
    visible = false;
    width = 0;
    constructor(options: { texture?: unknown } = {}) {
      this.texture = options.texture;
    }
  }

  class Texture {
    static readonly EMPTY = new Texture();
    constructor(public readonly options: { source?: unknown } = {}) {}
    update = vi.fn();
  }

  class CanvasSource {
    constructor(public readonly options: unknown) {}
    update = vi.fn();
  }

  class ImageSource {
    readonly style = {};
    constructor(public readonly options: unknown) {}
    destroy = vi.fn();
  }

  class Shader {
    static from = vi.fn(() => new Shader());
    readonly resources: Record<string, unknown> = {};
    destroy = vi.fn();
  }

  class UniformGroup {
    readonly uniforms: Record<string, unknown> = {};
    constructor(uniforms: Record<string, { value: unknown }>) {
      for (const [name, uniform] of Object.entries(uniforms)) {
        this.uniforms[name] = uniform.value;
      }
    }
    update = vi.fn();
  }

  class Mesh {
    visible = false;
    shader: unknown;
    constructor(options: { shader: unknown }) {
      this.shader = options.shader;
    }
    destroy = vi.fn();
  }

  class MeshGeometry {
    constructor(public readonly options: unknown) {}
    destroy = vi.fn();
  }

  class ExternalSource {
    constructor(public readonly options: unknown) {}
    updateGPUTexture = vi.fn();
  }

  return {
    Application,
    Assets: { load: vi.fn(), unload: vi.fn() },
    CanvasSource,
    ColorMatrixFilter: Stub,
    Container,
    ExternalSource,
    Graphics,
    ImageSource,
    Mesh,
    MeshGeometry,
    Rectangle: Stub,
    Shader,
    Sprite,
    Text: Stub,
    Texture,
    UniformGroup,
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
          width: 0,
        },
  hidden: false,
  removeEventListener: vi.fn(),
};

const detectionFrames: readonly DetectionFrame[] = [
  {
    detections: [{ className: "player", confidence: 0.9, rect: makeRect() }],
    frameIndex: 0,
    mediaTime: 1,
  },
  {
    detections: [{ className: "player", confidence: 0.9, rect: makeRect() }],
    frameIndex: 1,
    mediaTime: 2,
  },
];

/** Cooks to nothing, so a frame is prepared exactly when its cook has run. */
const emptyMaskStyle: MaskStyle = { resolve: () => undefined };
const emptyPolygonStyle: PolygonStyle = { resolve: () => undefined };

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("document", documentMock);
  vi.stubGlobal("window", { devicePixelRatio: 1 });
  vi.stubGlobal("ResizeObserver", undefined);
  vi.stubGlobal("GPUTextureUsage", {
    COPY_DST: 1,
    RENDER_ATTACHMENT: 2,
    TEXTURE_BINDING: 4,
  });
  pixiMock.graphics.length = 0;
  pixiMock.render.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the prepared annotation window under push presentation", () => {
  it("draws the vector layers of a frame whose cooks are still owed", async () => {
    const scene = await createScene();

    scene.present(1000);

    expect(scene.lastPresentation()).toMatchObject({
      activeDetectionCount: 1,
      activeDetectionFrameTime: 1,
    });
    expect(boxGraphics().rect).toHaveBeenCalled();
    expect(scene.snapshot()?.playheadPrepared).toBe(false);
  });

  it("draws every layer once the window reaches the presented frame", async () => {
    const scene = await createScene();

    scene.present(1000);
    await scene.settleCooks();

    expect(scene.lastPresentation()).toMatchObject({
      activeDetectionCount: 1,
      activeDetectionFrameTime: 1,
    });
    expect(scene.snapshot()).toMatchObject({
      playheadPrepared: true,
      preparedFrameCount: 2,
      spanFrameCount: 12,
    });
  });

  it("never leaves the previous frame's annotations on the next one", async () => {
    const scene = await createScene();

    scene.present(1000);
    await scene.settleCooks();
    const drawnBefore = boxGraphics().rect.mock.calls.length;

    scene.evictCooks();
    scene.present(2000);

    expect(scene.lastPresentation()).toMatchObject({
      activeDetectionCount: 1,
      activeDetectionFrameTime: 2,
    });
    expect(scene.snapshot()?.playheadPrepared).toBe(false);
    expect(boxGraphics().rect.mock.calls.length).toBeGreaterThan(drawnBefore);
    expect(boxGraphics().clear.mock.calls.length).toBeGreaterThan(0);
  });

  it("renders exactly once when the window reaches the frame on screen", async () => {
    const scene = await createScene();

    scene.present(1000);
    const presented = scene.renderCount();

    await scene.settleCooks();

    expect(scene.renderCount()).toBe(presented + 1);

    await scene.settleCooks();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(scene.renderCount()).toBe(presented + 1);
  });

  it("redraws for each cook that lands, whichever layer owns it", async () => {
    // A cook reaches the screen only through the redraw its own landing makes.
    const scene = await createScene({ polygonStyle: emptyPolygonStyle });

    scene.present(1000);
    const presented = scene.renderCount();

    await scene.settleCooks();

    expect(scene.snapshot()?.playheadPrepared).toBe(true);
    expect(scene.renderCount()).toBe(presented + 2);
    expect(scene.lastPresentation()).toMatchObject({
      activeDetectionCount: 1,
      activeDetectionFrameTime: 1,
    });
  });

  it("renders detections that arrive while paused", async () => {
    const scene = await createScene({
      maskStyle: null,
      prepareDetections: false,
    });
    const presentation: MediaRendererPresentation = {};

    scene.present(1000);
    scene.scene.setPresentation(presentation, 1);
    const invisible = scene.renderCount();

    await scene.detectionTimeline.prepare(1);
    const arrived = scene.scene.setPresentation(presentation, 1);

    expect(scene.renderCount()).toBe(invisible + 1);
    expect(arrived).toMatchObject({
      activeDetectionCount: 1,
      activeDetectionFrameTime: 1,
    });
  });

  it("holds at zero renders once the window has settled", async () => {
    const scene = await createScene();

    scene.present(1000);
    await scene.settleCooks();
    const settled = scene.renderCount();

    await vi.advanceTimersByTimeAsync(10_000);

    expect(scene.renderCount()).toBe(settled);
    expect(pixiMock.render).toHaveBeenCalledTimes(settled);
  });

  it("keeps preparing id-mask artifacts for focus while the mask fill is off", async () => {
    const diagnostics: RenderPreparationDiagnostics[] = [];
    const scene = await createScene({
      focusStyle: new BaseFocusStyle(),
      maskStyle: null,
      renderPreparation: {
        onDiagnostics: (next) => diagnostics.push(next),
      },
    });

    scene.present(1000);
    await scene.settleCooks();

    expect(maskArtifactStatuses(diagnostics)).not.toContain(
      RenderPreparationArtifactFrameStatus.Disabled,
    );
    expect(maskArtifactStatuses(diagnostics).length).toBeGreaterThan(0);
  });

  it("prepares no id-mask artifacts when neither the fill nor focus is on", async () => {
    const diagnostics: RenderPreparationDiagnostics[] = [];
    const scene = await createScene({
      focusStyle: null,
      maskStyle: null,
      renderPreparation: {
        onDiagnostics: (next) => diagnostics.push(next),
      },
    });

    scene.present(1000);
    await scene.settleCooks();

    expect(maskArtifactStatuses(diagnostics)).toHaveLength(0);
  });

  it("reports no window to a scene that free-runs on the ticker", async () => {
    const { createPixiMediaScene } = await import("./pixi-media-scene");
    const scene = await createPixiMediaScene(
      createSceneOptions({ detectionTimeline: createTimeline() }),
    );

    expect(scene.getPreparedAnnotationWindow?.()).toBeNull();
  });
});

function maskArtifactStatuses(
  diagnostics: readonly RenderPreparationDiagnostics[],
) {
  return diagnostics
    .flatMap((entry) => entry.artifacts)
    .filter(
      (artifact) =>
        artifact.kind === RenderPreparationArtifactKind.MaskFrame &&
        artifact.activeFrame,
    )
    .map((artifact) => artifact.activeFrame?.status);
}

function boxGraphics() {
  const graphics = pixiMock.graphics[0];

  if (!graphics) {
    throw new Error("The scene drew no box graphics.");
  }

  return graphics as unknown as {
    clear: ReturnType<typeof vi.fn>;
    rect: ReturnType<typeof vi.fn>;
  };
}

async function createScene(
  options: {
    readonly focusStyle?: FocusStyle | null;
    readonly maskStyle?: MaskStyle | null;
    readonly polygonStyle?: PolygonStyle;
    readonly prepareDetections?: boolean;
    readonly renderPreparation?: RenderPreparationOptions;
  } = {},
) {
  const detectionTimeline = createTimeline();

  if (options.prepareDetections !== false) {
    await detectionTimeline.prepare(1);
  }

  let handler: ((presented: PresentedVideoFrame) => void) | null = null;
  const presentations: PresentedMediaSample[] = [];
  const { createPixiMediaScene } = await import("./pixi-media-scene");
  const scene = await createPixiMediaScene(
    createSceneOptions({
      detectionTimeline,
      focusStyle: options.focusStyle ?? null,
      maskStyle:
        options.maskStyle === undefined ? emptyMaskStyle : options.maskStyle,
      onPresentationUpdate: (sample) => presentations.push(sample),
      polygonStyle: options.polygonStyle,
      renderPreparation: options.renderPreparation,
      presentedFrames: {
        onPresentedFrame(next) {
          handler = next;
        },
      },
    }),
  );

  scene.initializeMedia({ height: 240, width: 320 });

  return {
    detectionTimeline,

    /** Runs the cook queues the presented frame put in front of the window. */
    async settleCooks() {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
    },

    /** Drops what the cooks produced, leaving the next frame uncovered. */
    evictCooks() {
      scene.setPresentation({ maskStyle: { ...emptyMaskStyle } }, 1);
      presentations.length = 0;
      pixiMock.render.mockClear();
    },

    lastPresentation() {
      return presentations[presentations.length - 1];
    },

    present(mediaTimeMs: number) {
      handler?.(presentedFrame(mediaTimeMs));
    },

    renderCount() {
      return scene.getRenderCount?.() ?? 0;
    },

    scene,

    snapshot() {
      return scene.getPreparedAnnotationWindow?.();
    },
  };
}

function createTimeline(): BufferedDetectionTimeline {
  return createBufferedDetectionTimeline({
    source: createArrayDetectionFrameSource(detectionFrames),
  });
}

function presentedFrame(mediaTimeMs: number) {
  return {
    frame: { close: vi.fn(), displayHeight: 240, displayWidth: 320 },
    mediaTimeMs,
  } as unknown as PresentedVideoFrame;
}

function makeRect() {
  return { height: 30, width: 20, x: 10, y: 15 };
}

function createSceneOptions(
  overrides: Partial<MediaRendererSceneOptions> & {
    readonly detectionTimeline: BufferedDetectionTimeline;
  },
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
    previewOverlay: undefined,
    regionRenderers: [],
    renderPreparation: undefined,
    shapeStyle: null,
    visibility: undefined,
    ...overrides,
  };
}
