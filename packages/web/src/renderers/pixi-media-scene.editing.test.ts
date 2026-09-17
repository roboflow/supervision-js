import { describe, expect, it, vi } from "vitest";

import {
  AnnotationGestureStateKind,
  BaseBoxStyle,
  BoxShape,
  DetectionMaskEncoding,
  type AnnotationEditingEngine,
  type AnnotationEditingState,
  type Detection,
} from "supervision-js-core";

import {
  createRenderer,
  pixiMock,
  resetMocks,
} from "../../../../test/media-renderer-harness";

const SUBJECT: Detection = {
  className: "player",
  id: "player-7",
  rect: { height: 100, width: 50, x: 100, y: 90 },
};

const OBB_SUBJECT: Detection = {
  className: "basketball",
  id: "basketball-1",
  orientedBox: {
    points: [
      { x: 100, y: 70 },
      { x: 120, y: 90 },
      { x: 100, y: 110 },
      { x: 80, y: 90 },
    ],
  },
  rect: { height: 40, width: 40, x: 100, y: 90 },
};

describe("editing gestures in the Pixi media scene", () => {
  it("hides the edited detection from the base layers while it is edited", async () => {
    resetMocks();
    const editing = createEditingEngineHarness();
    const renderer = await createRenderer(false, false, {
      boxStyle: new BaseBoxStyle({
        shape: BoxShape.Rect,
        stroke: { alpha: 1, color: 0x00ff66, width: 2 },
      }),
      detectionFrames: [{ detections: [SUBJECT], frameIndex: 0, mediaTime: 0 }],
      editingEngine: editing.engine,
    });

    await vi.waitFor(() => {
      expect(renderer.getState().activeDetectionCount).toBe(1);
    });
    const box = pixiMock.graphicsInstances.find(
      (graphics) => graphics.rect.mock.calls.length > 0,
    );
    expect(box).toBeDefined();
    expect(box!.visible).toBe(true);

    editing.emitState(movingState());
    expect(box!.visible).toBe(false);

    editing.emitState(idleState());
    expect(box!.visible).toBe(true);

    renderer.destroy();
  });

  it("keeps a mask drawn while the brush edits it", async () => {
    resetMocks();
    const editing = createEditingEngineHarness();
    const renderer = await createRenderer(false, false, {
      boxStyle: new BaseBoxStyle({
        shape: BoxShape.Rect,
        stroke: { alpha: 1, color: 0x00ff66, width: 2 },
      }),
      detectionFrames: [{ detections: [SUBJECT], frameIndex: 0, mediaTime: 0 }],
      editingEngine: editing.engine,
    });

    await vi.waitFor(() => {
      expect(renderer.getState().activeDetectionCount).toBe(1);
    });
    const box = pixiMock.graphicsInstances.find(
      (graphics) => graphics.rect.mock.calls.length > 0,
    );
    expect(box!.visible).toBe(true);

    editing.emitState({
      ...movingState(),
      preview: {
        ...SUBJECT,
        mask: {
          counts: "0",
          encoding: DetectionMaskEncoding.CompressedRle,
          height: 1,
          width: 1,
        },
      },
    });
    expect(box!.visible).toBe(true);

    renderer.destroy();
  });

  it("keeps an oriented box visible as a rotated quadrilateral while dragging, then restores normal rendering when the gesture ends", async () => {
    resetMocks();
    const editing = createEditingEngineHarness();
    const renderer = await createRenderer(false, false, {
      boxStyle: new BaseBoxStyle({
        shape: BoxShape.Rect,
        stroke: { alpha: 1, color: 0x00ff66, width: 2 },
      }),
      detectionFrames: [
        { detections: [OBB_SUBJECT], frameIndex: 0, mediaTime: 0 },
      ],
      editingEngine: editing.engine,
    });

    await vi.waitFor(() => {
      expect(renderer.getState().activeDetectionCount).toBe(1);
    });
    const box = pixiMock.graphicsInstances.find(
      (graphics) => graphics.rect.mock.calls.length > 0,
    );
    expect(box).toBeDefined();
    expect(box!.visible).toBe(true);

    // The annotation overlay is only redrawn from the Pixi ticker
    // (`app.ticker.add(drawAnnotationOverlayNow)`), not synchronously inside
    // `editingEngine.subscribe(...)` -- box visibility toggles immediately
    // on a state change (a direct side effect of the subscription), but the
    // overlay's own draw (and therefore this fix) only runs once this
    // harness's mocked ticker is actually advanced. Retrieved by name, not
    // registration index, so this does not depend on how many other ticker
    // callbacks the scene happens to register or in what order.
    const drawAnnotationOverlayNow = pixiMock.tickerAdd.mock.calls
      .map(([callback]) => callback as () => void)
      .find((callback) => callback.name === "drawAnnotationOverlayNow");
    expect(drawAnnotationOverlayNow).toBeDefined();

    const translatedPoints = [
      { x: 140, y: 50 },
      { x: 160, y: 70 },
      { x: 140, y: 90 },
      { x: 120, y: 70 },
    ] as const;
    editing.emitState({
      activeDetectionId: "basketball-1",
      activeHandleId: null,
      kind: AnnotationGestureStateKind.Moving,
      pointerId: 1,
      preview: {
        ...OBB_SUBJECT,
        orientedBox: { points: translatedPoints },
        rect: { ...OBB_SUBJECT.rect!, x: 140, y: 70 },
      },
    });

    // The source is hidden while it drags, the same as any other geometry
    // kind (existing behavior, reconfirmed here for an OBB detection). This
    // part does not need a ticker tick -- it is the direct subscription
    // side effect described above.
    expect(box!.visible).toBe(false);

    drawAnnotationOverlayNow!();

    const overlay = pixiMock.graphicsInstances.find(
      (graphics) => graphics.poly.mock.calls.length > 0,
    );
    expect(overlay).toBeDefined();
    expect(overlay).not.toBe(box);
    // toHaveBeenLastCalledWith, not toHaveBeenCalledWith: this graphics
    // instance is reused for the whole scene's lifetime (unlike the
    // isolated overlay-layer unit tests' fresh mock per test), so this must
    // assert the MOST RECENT draw actually used the translated OBB points,
    // not just that it did at some point in the mock's accumulated call
    // history.
    expect(overlay!.poly).toHaveBeenLastCalledWith(
      translatedPoints.flatMap(({ x, y }) => [x, y]),
      true,
    );
    expect(overlay!.moveTo).toHaveBeenLastCalledWith(140, 50);
    expect(overlay!.lineTo.mock.calls.slice(-3)).toEqual([
      [160, 70],
      [140, 90],
      [120, 70],
    ]);
    const polyCallsWhileDragging = overlay!.poly.mock.calls.length;
    const closePathCallsWhileDragging = overlay!.closePath.mock.calls.length;
    expect(closePathCallsWhileDragging).toBeGreaterThan(0);

    editing.emitState({
      activeDetectionId: null,
      activeHandleId: null,
      kind: AnnotationGestureStateKind.Idle,
      pointerId: null,
      preview: null,
    });
    drawAnnotationOverlayNow!();

    // Preview cleanup and normal rendering resume once the gesture ends
    // (release or cancel -- both transition through this same idle state in
    // this harness, since it does not model a separate commit pipeline):
    // the base box becomes visible again, and the overlay's editing-preview
    // path draws nothing further for the old shape (no new poly/closePath
    // calls beyond what dragging already produced).
    expect(box!.visible).toBe(true);
    expect(overlay!.poly.mock.calls.length).toBe(polyCallsWhileDragging);
    expect(overlay!.closePath.mock.calls.length).toBe(
      closePathCallsWhileDragging,
    );

    renderer.destroy();
  });
});

function idleState(): AnnotationEditingState {
  return {
    activeDetectionId: null,
    activeHandleId: null,
    kind: AnnotationGestureStateKind.Idle,
    pointerId: null,
    preview: null,
  };
}

function movingState(): AnnotationEditingState {
  return {
    activeDetectionId: "player-7",
    activeHandleId: null,
    kind: AnnotationGestureStateKind.Moving,
    pointerId: 1,
    preview: { ...SUBJECT, rect: { ...SUBJECT.rect!, x: 140, y: 60 } },
  };
}

function createEditingEngineHarness() {
  // `getState()` must reflect whatever was last emitted, the same as a real
  // engine implementation: a bare `idleState` function reference here would
  // make `getState()` permanently report Idle/no-preview regardless of what
  // `emitState()` sends to subscribers, which is silently fine for a test
  // that only reads the emitted event payload directly, but breaks any
  // renderer code path (drawEditingPreview included) that calls
  // `engine.getState()` itself to read the current preview.
  let currentState: AnnotationEditingState = idleState();
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
