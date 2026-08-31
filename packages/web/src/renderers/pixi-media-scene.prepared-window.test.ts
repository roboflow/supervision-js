import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AnnotationGestureStateKind,
  BaseFocusStyle,
  createArrayDetectionFrameSource,
  createBufferedDetectionTimeline,
  DetectionMaskEncoding,
  FocusTargetMode,
} from "supervision-js-core";
import type {
  AnnotationEditingEngine,
  AnnotationEditingState,
  BufferedDetectionTimeline,
  DetectionFrame,
  DetectionMask,
  FocusStyle,
  MaskHaloStyle,
  MaskStyle,
  PolygonStyle,
} from "supervision-js-core";
import { PreparedMaskFrameKind } from "#render-preparation/mask-frame-artifact";
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
  meshes: [] as {
    shader: { resources: Record<string, unknown> };
    visible: boolean;
  }[],
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
    on = vi.fn();
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
    readonly source: unknown;
    constructor(public readonly options: { source?: unknown } = {}) {
      this.source = options.source;
    }
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
    static from = vi.fn(
      (options: { resources?: Record<string, unknown> } = {}) =>
        new Shader(options),
    );
    readonly resources: Record<string, unknown>;
    destroy = vi.fn();
    constructor(options: { resources?: Record<string, unknown> } = {}) {
      this.resources = options.resources ?? {};
    }
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
      pixiMock.meshes.push(this as never);
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
    AlphaMask: Stub,
    Application,
    Assets: { load: vi.fn(), unload: vi.fn() },
    BlurFilter: Stub,
    BufferImageSource: ImageSource,
    CanvasSource,
    ColorMatrixFilter: Stub,
    Container,
    defaultFilterVert: "default-filter-vertex",
    ExternalSource,
    Filter: Stub,
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

const singlePixelMask: DetectionMask = {
  counts: "01",
  encoding: DetectionMaskEncoding.CompressedRle,
  height: 1,
  width: 1,
};

const haloDetectionFrames: readonly DetectionFrame[] = [
  {
    detections: [
      {
        className: "glowing",
        confidence: 0.9,
        mask: singlePixelMask,
        rect: makeRect(),
      },
      {
        className: "dim",
        confidence: 0.1,
        mask: singlePixelMask,
        rect: makeRect(),
      },
    ],
    frameIndex: 0,
    mediaTime: 1,
  },
];

/** A fresh object and a fresh closure per call, the way a live control feeds one. */
function createGlowingOnlyHaloStyle(spread: number): MaskHaloStyle {
  return {
    resolve: (detection) =>
      detection.className === "glowing"
        ? { alpha: 1, color: 0xffffff, spread }
        : undefined,
  };
}

const transparentOnDimHaloStyle: MaskHaloStyle = {
  resolve: (detection) => ({
    alpha: detection.className === "glowing" ? 1 : 0,
    color: 0xffffff,
    spread: 8,
  }),
};

/** Answers empty so the preparation queue drains. */
function createRecordingWorkerFactory(cooks: number[][]) {
  return {
    createWorker() {
      const listeners = new Set<(event: { data: unknown }) => void>();

      return {
        addEventListener(type: string, listener: (event: unknown) => void) {
          if (type === "message") {
            listeners.add(listener as (event: { data: unknown }) => void);
          }
        },
        postMessage(message: {
          job: {
            instructions: readonly { detectionIndex: number }[];
            key: string;
          };
          requestId: number;
        }) {
          cooks.push(
            message.job.instructions.map(
              ({ detectionIndex }) => detectionIndex,
            ),
          );

          for (const listener of listeners) {
            listener({
              data: {
                key: message.job.key,
                requestId: message.requestId,
                type: "empty",
              },
            });
          }
        },
        removeEventListener(_type: string, listener: (event: unknown) => void) {
          listeners.delete(listener as (event: { data: unknown }) => void);
        },
        terminate: vi.fn(),
      } as unknown as Worker;
    },
  };
}

/**
 * Cooks a raster for the frames named and leaves every other job in flight, so
 * a frame can be on screen with its neighbour's cook still owed.
 */
function createSelectiveWorkerFactory(cookedKeys: readonly string[]) {
  return {
    createWorker() {
      const listeners = new Set<(event: { data: unknown }) => void>();

      return {
        addEventListener(type: string, listener: (event: unknown) => void) {
          if (type === "message") {
            listeners.add(listener as (event: { data: unknown }) => void);
          }
        },
        postMessage(message: { job: { key: string }; requestId: number }) {
          if (!cookedKeys.includes(message.job.key)) {
            return;
          }

          for (const listener of listeners) {
            listener({
              data: {
                artifactKind: PreparedMaskFrameKind.IdMask,
                fillPalette: new Float32Array([1, 1, 1, 1]),
                height: 1,
                key: message.job.key,
                raster: new Uint8Array([1]),
                requestId: message.requestId,
                sourceWidth: 1,
                strokePalette: new Float32Array([0, 0, 0, 0]),
                strokeWidths: new Float32Array([0]),
                type: "complete",
                width: 1,
              },
            });
          }
        },
        removeEventListener(_type: string, listener: (event: unknown) => void) {
          listeners.delete(listener as (event: { data: unknown }) => void);
        },
        terminate: vi.fn(),
      } as unknown as Worker;
    },
  };
}

/** Cooks to nothing, so a frame is prepared exactly when its cook has run. */
const emptyMaskStyle: MaskStyle = { resolve: () => undefined };
/** Cooks to a raster, so a prepared frame has something to put on screen. */
const paintedMaskStyle: MaskStyle = {
  resolve: (detection) =>
    detection.mask
      ? { alpha: 1, color: 0xffffff, mask: detection.mask }
      : undefined,
};
/** Three 30 fps steps: the smallest moves a viewer can make. */
const maskedFrames: readonly DetectionFrame[] = [1, 1.0333, 1.0667].map(
  (mediaTime, frameIndex) => ({
    detections: [
      {
        className: "player",
        confidence: 0.9,
        mask: singlePixelMask,
        rect: makeRect(),
      },
    ],
    frameIndex,
    mediaTime,
  }),
);
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
  pixiMock.meshes.length = 0;
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

  it("keeps the neighbouring frame's raster on a frame whose cook is owed, and says whose it is", async () => {
    const scene = await createScene({
      detectionFrames: maskedFrames,
      maskStyle: paintedMaskStyle,
      renderPreparation: {
        workerFactory: createSelectiveWorkerFactory(["0:1"]),
      },
    });

    scene.present(1000);
    await scene.settleCooks();

    expect(scene.lastPresentation()).toMatchObject({
      activeDetectionFrameTime: 1,
      drawnMaskFrameTime: 1,
      maskHeldStale: false,
    });

    scene.present(1033);

    expect(scene.lastPresentation()).toMatchObject({
      activeDetectionFrameTime: 1.0333,
      drawnMaskFrameTime: 1,
      maskHeldStale: true,
    });
  });

  it("takes the raster off two frames from the one it belongs to", async () => {
    const scene = await createScene({
      detectionFrames: maskedFrames,
      maskStyle: paintedMaskStyle,
      renderPreparation: {
        workerFactory: createSelectiveWorkerFactory(["0:1"]),
      },
    });

    scene.present(1000);
    await scene.settleCooks();
    scene.present(1033);
    scene.present(1067);

    expect(scene.lastPresentation()).toMatchObject({
      activeDetectionFrameTime: 1.0667,
      drawnMaskFrameTime: null,
      maskHeldStale: false,
    });
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

  it("prepares mask coverage for only the detections the halo paints", async () => {
    const cooks: number[][] = [];
    const scene = await createScene({
      detectionFrames: haloDetectionFrames,
      maskHaloStyle: createGlowingOnlyHaloStyle(8),
      maskStyle: null,
      renderPreparation: {
        workerFactory: createRecordingWorkerFactory(cooks),
      },
    });

    scene.present(1000);
    await scene.settleCooks();

    // One id per pixel: a detection the halo skips would bury the one it draws.
    expect(cooks.length).toBeGreaterThan(0);
    expect(cooks.at(-1)).toEqual([0]);
  });

  it("leaves a halo that paints nothing out of the prepared coverage", async () => {
    const cooks: number[][] = [];
    const scene = await createScene({
      detectionFrames: haloDetectionFrames,
      maskHaloStyle: transparentOnDimHaloStyle,
      maskStyle: null,
      renderPreparation: {
        workerFactory: createRecordingWorkerFactory(cooks),
      },
    });

    scene.present(1000);
    await scene.settleCooks();

    expect(cooks.length).toBeGreaterThan(0);
    expect(cooks.at(-1)).toEqual([0]);
  });

  it("keeps prepared mask coverage across a halo restyle that admits the same detections", async () => {
    const cooks: number[][] = [];
    const scene = await createScene({
      detectionFrames: haloDetectionFrames,
      maskHaloStyle: createGlowingOnlyHaloStyle(8),
      maskStyle: null,
      renderPreparation: {
        workerFactory: createRecordingWorkerFactory(cooks),
      },
    });

    scene.present(1000);
    await scene.settleCooks();

    const cookCountBeforeRestyle = cooks.length;

    scene.setPresentation({ maskHaloStyle: createGlowingOnlyHaloStyle(24) });
    scene.present(1000);
    await scene.settleCooks();

    expect(cookCountBeforeRestyle).toBeGreaterThan(0);
    expect(cooks.length).toBe(cookCountBeforeRestyle);
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

  it("goes quiet on a frame whose focus cutout is owed instead of dimming the picture", async () => {
    const scene = await createOwedFocusScene();

    scene.present(1000);
    await scene.settleCooks();
    const cutout = focusMesh().shader.resources.uTexture;

    scene.present(1033);
    scene.present(1067);

    expect(focusMesh().visible).toBe(false);
    expect(focusMesh().shader.resources.uTexture).toBe(cutout);
  });

  it.each([
    AnnotationGestureStateKind.Creating,
    AnnotationGestureStateKind.DragSelecting,
  ])(
    "keeps dimming an owed frame a %s gesture is drawing over",
    async (kind) => {
      const gesture = createGestureEngineStub();
      const scene = await createOwedFocusScene(gesture.engine);

      scene.present(1000);
      await scene.settleCooks();
      const cutout = focusMesh().shader.resources.uTexture;

      gesture.begin(kind);
      scene.present(1033);
      scene.present(1067);

      expect(focusMesh().visible).toBe(true);
      expect(focusMesh().shader.resources.uTexture).not.toBe(cutout);
    },
  );

  it("tells the playback gate to wait for a presented frame whose cooks are owed", async () => {
    const scene = await createScene();

    scene.present(1000);

    expect(
      scene.scene.needsRenderPreparationWait?.(1, {
        enabled: true,
        resumeAtSeconds: 0,
        stopBelowSeconds: 0,
      }),
    ).toBe(true);
    expect(scene.scene.getRenderPreparationProgress?.()).toBe(0);

    await scene.settleCooks();

    expect(
      scene.scene.needsRenderPreparationWait?.(1, {
        enabled: true,
        resumeAtSeconds: 0,
        stopBelowSeconds: 0,
      }),
    ).toBe(false);
    expect(scene.scene.getRenderPreparationProgress?.()).toBeGreaterThan(0);
  });

  it("holds the gate open until the cooks for the presented frame land", async () => {
    const scene = await createScene();

    scene.present(1000);
    let released = false;
    const wait = scene.scene
      .waitForRenderPreparation?.(1, {
        enabled: true,
        resumeAtSeconds: 0,
        stopBelowSeconds: 0,
      })
      .then(() => {
        released = true;
      });

    await Promise.resolve();

    expect(released).toBe(false);

    await scene.settleCooks();
    await wait;

    expect(released).toBe(true);
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
    readonly editingEngine?: AnnotationEditingEngine;
    readonly focusStyle?: FocusStyle | null;
    readonly detectionFrames?: readonly DetectionFrame[];
    readonly maskHaloStyle?: MaskHaloStyle | null;
    readonly maskStyle?: MaskStyle | null;
    readonly polygonStyle?: PolygonStyle;
    readonly prepareDetections?: boolean;
    readonly renderPreparation?: RenderPreparationOptions;
  } = {},
) {
  const detectionTimeline = createTimeline(options.detectionFrames);

  if (options.prepareDetections !== false) {
    await detectionTimeline.prepare(1);
  }

  let handler: ((presented: PresentedVideoFrame) => void) | null = null;
  const presentations: PresentedMediaSample[] = [];
  const { createPixiMediaScene } = await import("./pixi-media-scene");
  const scene = await createPixiMediaScene(
    createSceneOptions({
      detectionTimeline,
      editingEngine: options.editingEngine,
      focusStyle: options.focusStyle ?? null,
      maskHaloStyle: options.maskHaloStyle ?? undefined,
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

    setPresentation(presentation: MediaRendererPresentation) {
      scene.setPresentation(presentation, 1);
    },

    snapshot() {
      return scene.getPreparedAnnotationWindow?.();
    },
  };
}

function createTimeline(
  frames: readonly DetectionFrame[] = detectionFrames,
): BufferedDetectionTimeline {
  return createBufferedDetectionTimeline({
    source: createArrayDetectionFrameSource(frames),
  });
}

function presentedFrame(mediaTimeMs: number) {
  return {
    frame: { close: vi.fn(), displayHeight: 240, displayWidth: 320 },
    frameId: { index: mediaTimeMs / 1000, ticks: mediaTimeMs },
    mediaTimeMs,
    mediaTimeS: mediaTimeMs / 1000,
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

/**
 * A scene whose focus has a cutout on the first frame and none to cut on the
 * two after it: the second holds the first frame's raster, the third has let
 * go of it.
 */
function createOwedFocusScene(editingEngine?: AnnotationEditingEngine) {
  return createScene({
    detectionFrames: maskedFrames,
    editingEngine,
    focusStyle: new BaseFocusStyle({
      fill: { alpha: 0.5, color: 0x000000 },
      targetMode: FocusTargetMode.Ambient,
    }),
    maskStyle: paintedMaskStyle,
    renderPreparation: {
      workerFactory: createSelectiveWorkerFactory(["0:1"]),
    },
  });
}

function focusMesh() {
  const mesh = pixiMock.meshes.find(
    (candidate) => "focusUniforms" in candidate.shader.resources,
  );

  if (!mesh) {
    throw new Error("The scene drew no focus mesh.");
  }

  return mesh;
}

function createGestureEngineStub() {
  let kind = AnnotationGestureStateKind.Idle;

  return {
    begin(next: AnnotationGestureStateKind) {
      kind = next;
    },
    engine: {
      beginHandleDrag: vi.fn(),
      cancel: vi.fn(),
      deleteVertex: vi.fn(() => null),
      getState: (): AnnotationEditingState => ({
        activeDetectionId: null,
        activeHandleId: null,
        kind,
        pointerId: null,
        preview: null,
      }),
      hasCreationTool: vi.fn(() => false),
      keyDown: vi.fn(),
      pointerDown: vi.fn(),
      pointerMove: vi.fn(),
      pointerUp: vi.fn(),
      setCreationTool: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
      subscribeFastTranslate: vi.fn(() => () => undefined),
    } satisfies AnnotationEditingEngine,
  };
}
