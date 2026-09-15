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
  let stateListener: ((state: AnnotationEditingState) => void) | undefined;
  const engine: AnnotationEditingEngine = {
    beginHandleDrag: vi.fn(),
    cancel: vi.fn(),
    deleteVertex: vi.fn(() => null),
    getState: idleState,
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
      stateListener?.(state);
    },
    engine,
  };
}
