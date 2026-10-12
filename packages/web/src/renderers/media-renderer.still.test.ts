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
