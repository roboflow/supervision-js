import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AnnotationGestureStateKind,
  type AnnotationEditingEngine,
  type AnnotationEditingState,
  type PreviewOverlayData,
} from "supervision-js-core";

import {
  createRenderer,
  pixiMock,
  resetMocks,
} from "../../../../test/media-renderer-harness";

beforeEach(() => {
  resetMocks();
});

describe("media renderer on a still image", () => {
  it("renders the image once and leaves Pixi's ticker stopped", async () => {
    const renderer = await createStillRenderer();

    expect(pixiMock.appInit).toHaveBeenCalledWith(
      expect.objectContaining({ autoStart: false }),
    );
    expect(pixiMock.tickerAdd).not.toHaveBeenCalled();
    expect(pixiMock.tickerStart).not.toHaveBeenCalled();
    expect(renderer.getRenderCount()).toBeGreaterThan(0);
    expect(pixiMock.render).toHaveBeenCalledTimes(
      renderer.getRenderCount() ?? -1,
    );

    renderer.destroy();
  });

  it("renders nothing for a refresh that changes nothing on screen", async () => {
    const renderer = await createStillRenderer();
    const settled = renderer.getRenderCount();
    expect(settled).not.toBeNull();

    await renderer.refresh();
    await renderer.refresh();

    expect(renderer.getRenderCount()).toBe(settled);

    renderer.destroy();
  });

  it("runs the ticker only while a loading spinner is on the image", async () => {
    const renderer = await createStillRenderer();

    renderer.setPresentation({ visibility: { loadingDetectionIds: ["a"] } });

    expect(pixiMock.tickerStart).toHaveBeenCalledTimes(1);
    expect(pixiMock.tickerAdd).toHaveBeenCalledTimes(1);
    expect(pixiMock.tickerStop).not.toHaveBeenCalled();

    renderer.setPresentation({ visibility: { loadingDetectionIds: [] } });

    expect(pixiMock.tickerStop).toHaveBeenCalledTimes(1);
    expect(pixiMock.tickerRemove).toHaveBeenCalledWith(
      pixiMock.tickerAdd.mock.calls[0]?.[0],
    );
    expect(pixiMock.tickerStart).toHaveBeenCalledTimes(1);

    renderer.destroy();
  });

  it("repaints an edit the host drives without a pointer", async () => {
    const editing = createEditingEngineStub();
    const renderer = await createStillRenderer({
      editingEngine: editing.engine,
    });
    const settled = renderer.getRenderCount() ?? 0;

    editing.emitState({
      activeDetectionId: null,
      activeHandleId: null,
      kind: AnnotationGestureStateKind.Creating,
      pointerId: null,
      preview: { id: "draft", rect: { height: 20, width: 20, x: 10, y: 10 } },
    });
    await Promise.resolve();

    expect(renderer.getRenderCount()).toBe(settled + 1);

    editing.emitState({
      activeDetectionId: null,
      activeHandleId: null,
      kind: AnnotationGestureStateKind.Idle,
      pointerId: null,
      preview: null,
    });
    await Promise.resolve();

    expect(renderer.getRenderCount()).toBe(settled + 2);

    renderer.destroy();
  });

  it("leaves nothing drawn after the last render when a move is canceled", async () => {
    const editing = createEditingEngineStub();
    const subject = {
      id: "player-7",
      rect: { height: 100, width: 50, x: 100, y: 90 },
    };
    const renderer = await createStillRenderer({
      detectionFrames: [{ detections: [subject], frameIndex: 0, mediaTime: 0 }],
      editingEngine: editing.engine,
    });
    const log = recordDrawsAndRenders();

    editing.emitState({
      activeDetectionId: subject.id,
      activeHandleId: null,
      kind: AnnotationGestureStateKind.Moving,
      pointerId: 1,
      preview: { ...subject, rect: { ...subject.rect, x: 140, y: 60 } },
    });
    await Promise.resolve();
    expect(log.at(-1)).toBe("render");

    log.length = 0;
    editing.emitState({
      activeDetectionId: null,
      activeHandleId: null,
      kind: AnnotationGestureStateKind.Idle,
      pointerId: null,
      preview: null,
    });
    await Promise.resolve();

    expect(log).toContain("draw");
    expect(log.at(-1)).toBe("render");

    renderer.destroy();
  });

  it("repaints a preview the host edited in place once it refreshes", async () => {
    const hover = [
      { x: 1, y: 1 },
      { x: 9, y: 1 },
      { x: 9, y: 9 },
    ];
    const overlay: PreviewOverlayData = { hoverPolygons: [hover] };
    const renderer = await createStillRenderer({
      previewOverlay: () => overlay,
    });
    const settled = renderer.getRenderCount() ?? 0;

    hover[1] = { x: 12, y: 1 };
    await renderer.refresh();

    expect(renderer.getRenderCount()).toBe(settled + 1);

    hover.push({ x: 1, y: 9 });
    await renderer.refresh();

    expect(renderer.getRenderCount()).toBe(settled + 2);

    renderer.destroy();
  });

  it("repaints a preview overlay the host changed once it refreshes", async () => {
    let overlay: PreviewOverlayData | null = null;
    const renderer = await createStillRenderer({
      previewOverlay: () => overlay,
    });
    const settled = renderer.getRenderCount() ?? 0;

    overlay = { hoverPolygons: [[{ x: 1, y: 1 }]] };
    await renderer.refresh();

    expect(renderer.getRenderCount()).toBe(settled + 1);

    await renderer.refresh();

    expect(renderer.getRenderCount()).toBe(settled + 1);

    renderer.destroy();
  });
});

/**
 * Logs every Graphics redraw and every render in order. A redraw logged after
 * the last render is a change the screen never received.
 */
function recordDrawsAndRenders() {
  const log: Array<"draw" | "render"> = [];
  for (const graphics of pixiMock.graphicsInstances) {
    graphics.clear.mockImplementation(() => {
      log.push("draw");
      return graphics;
    });
  }
  pixiMock.render.mockImplementation(() => {
    log.push("render");
  });
  return log;
}

function createEditingEngineStub() {
  let currentState: AnnotationEditingState = {
    activeDetectionId: null,
    activeHandleId: null,
    kind: AnnotationGestureStateKind.Idle,
    pointerId: null,
    preview: null,
  };
  let stateListener: ((state: AnnotationEditingState) => void) | undefined;
  const engine: AnnotationEditingEngine = {
    beginHandleDrag: vi.fn(),
    cancel: vi.fn(),
    deleteVertex: vi.fn(() => null),
    getState: () => currentState,
    hasCreationTool: vi.fn(() => false),
    keyDown: vi.fn(),
    pointerDown: vi.fn(),
    pointerMove: vi.fn(),
    pointerUp: vi.fn(),
    setCreationTool: vi.fn(),
    subscribe: vi.fn((listener) => {
      stateListener = listener;
      return () => undefined;
    }),
    subscribeFastTranslate: vi.fn(() => () => undefined),
  };

  return {
    emitState(state: AnnotationEditingState) {
      currentState = state;
      stateListener?.(state);
    },
    engine,
  };
}

async function createStillRenderer(overrides: Record<string, unknown> = {}) {
  const { createStaticImageMediaSource } =
    await import("#media/static-image-media-source");

  return createRenderer(false, false, {
    source: createStaticImageMediaSource({
      draw: vi.fn(),
      height: 720,
      width: 1280,
    }),
    src: undefined,
    ...overrides,
  });
}
