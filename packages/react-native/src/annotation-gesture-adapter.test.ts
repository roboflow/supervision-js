import { describe, expect, it, vi } from "vitest";
import type {
  AnnotationEditingEngine,
  DetectionFrame,
  Detection,
} from "supervision-js-core";
import {
  AnnotationGeometryKind,
  AnnotationGestureStateKind,
  createAnnotationEditingEngine,
  createOrientedBoxGeometry,
  getOrientedRectangleGeometry,
  DetectionPickTarget,
  encodeBinaryMask,
} from "supervision-js-core";

import {
  createReactNativeAnnotationGestureAdapter,
  type ReactNativeAnnotationGestureAdapter,
} from "./annotation-gesture-adapter";
import { resolveReactNativeFrameLayout } from "./index";

const legacyAdapter: ReactNativeAnnotationGestureAdapter = {
  pointerDown: () => null,
  pointerMove() {},
  pointerUp() {},
  keyDown() {},
  cancel() {},
};

describe("React Native annotation gesture adapter", () => {
  it("keeps native adapters written before contact cancellation assignable", () => {
    expect(legacyAdapter.pointerCancel).toBeUndefined();
  });
  it("retains accepted draft vertices when a native contact is interrupted", () => {
    const engine = createAnnotationEditingEngine();
    engine.setCreationTool({
      geometry: AnnotationGeometryKind.Polygon,
      createDetection: (points) => ({
        polygon: { points: points as { x: number; y: number }[] },
      }),
    });
    const adapter = createReactNativeAnnotationGestureAdapter({
      editingEngine: engine,
      getFrame: () => ({ mediaTime: 0, detections: [] }),
      getLayout: () =>
        resolveReactNativeFrameLayout({
          canvasHeight: 100,
          canvasWidth: 100,
          mediaHeight: 100,
          mediaWidth: 100,
        }),
    });
    adapter.pointerDown({ x: 10, y: 10, timestamp: 0, pointerId: 7 });
    adapter.pointerCancel?.(8);
    expect(engine.getState().pointerId).toBe(7);
    adapter.pointerCancel?.(7);
    expect(engine.getState().pointerId).toBeNull();
    expect(engine.undoCreation()).toBe(true);
    adapter.cancel();
    expect(engine.undoCreation()).toBe(false);
  });

  it("maps native touches into shared handle and drag gestures", () => {
    const detection = {
      id: "box",
      rect: { height: 20, width: 20, x: 50, y: 50 },
    };
    const frame = {
      detections: [detection],
      mediaTime: 0,
    } satisfies DetectionFrame;
    const layout = resolveReactNativeFrameLayout({
      canvasHeight: 100,
      canvasWidth: 100,
      mediaHeight: 100,
      mediaWidth: 100,
    });
    const engine = {
      beginHandleDrag: vi.fn(),
      cancel: vi.fn(),
      deleteVertex: vi.fn(),
      keyDown: vi.fn(),
      pointerDown: vi.fn(),
      pointerMove: vi.fn(),
      pointerUp: vi.fn(),
    } as unknown as AnnotationEditingEngine;
    const adapter = createReactNativeAnnotationGestureAdapter({
      editingEngine: engine,
      getFrame: () => frame,
      getLayout: () => layout,
      getSelectedDetection: () => detection,
    });

    adapter.pointerDown({ pointerId: 7, timestamp: 1, x: 40, y: 40 });
    adapter.pointerMove({ pointerId: 7, timestamp: 2, x: -10, y: -5 });
    adapter.pointerUp({ pointerId: 7, timestamp: 3, x: -10, y: -5 });

    expect(engine.beginHandleDrag).toHaveBeenCalledWith(
      detection,
      expect.objectContaining({ id: "nw" }),
      expect.objectContaining({ point: { x: 40, y: 40 }, pointerId: 7 }),
    );
    expect(engine.pointerMove).toHaveBeenCalledWith(
      expect.objectContaining({ point: { x: -10, y: -5 } }),
    );
    expect(engine.pointerUp).toHaveBeenCalledWith(
      expect.objectContaining({ point: { x: -10, y: -5 } }),
    );
  });

  it("shares creation, movement, vertex deletion, and scaled-mask picking semantics", () => {
    const commits = vi.fn();
    const engine = createAnnotationEditingEngine({ onCommit: commits });
    const frame = {
      detections: [
        {
          id: "box",
          rect: { height: 20, width: 20, x: 50, y: 50 },
        },
        {
          id: "polygon",
          polygon: {
            points: [
              { x: 100, y: 100 },
              { x: 120, y: 100 },
              { x: 120, y: 120 },
              { x: 100, y: 120 },
            ],
          },
        },
        {
          id: "mask",
          mask: encodeBinaryMask(Uint8Array.from([1, 1, 1, 1]), 2, 2),
        },
      ],
      mediaTime: 0,
    } satisfies DetectionFrame;
    const layout = resolveReactNativeFrameLayout({
      canvasHeight: 200,
      canvasWidth: 200,
      mediaHeight: 200,
      mediaWidth: 200,
    });
    let selected: DetectionFrame["detections"][number] | undefined =
      frame.detections[1];
    const adapter = createReactNativeAnnotationGestureAdapter({
      editingEngine: engine,
      getFrame: () => frame,
      getLayout: () => layout,
      getSelectedDetection: () => selected,
    });

    selected = undefined;
    adapter.pointerDown({ timestamp: 1, x: 50, y: 50 });
    adapter.pointerMove({ timestamp: 2, x: 60, y: 55 });
    adapter.pointerUp({ timestamp: 3, x: 60, y: 55 });
    expect(commits).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: "box",
        rect: expect.objectContaining({ x: 60, y: 55 }),
      }),
      expect.objectContaining({ id: "box" }),
    );

    engine.setCreationTool({
      createDetection: (geometry) => ({
        id: "created",
        rect: geometry as never,
      }),
      geometry: AnnotationGeometryKind.Box,
    });
    adapter.pointerDown({ timestamp: 4, x: 10, y: 20 });
    adapter.pointerMove({ timestamp: 5, x: 30, y: 60 });
    adapter.pointerUp({ timestamp: 6, x: 30, y: 60 });
    expect(commits).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: "created",
        rect: { height: 40, width: 20, x: 20, y: 40 },
      }),
      null,
    );

    engine.setCreationTool(null);
    selected = frame.detections[1];
    adapter.pointerDown({ button: 2, timestamp: 7, x: 100, y: 100 });
    expect(commits).toHaveBeenLastCalledWith(
      expect.objectContaining({
        polygon: expect.objectContaining({
          points: expect.arrayContaining([
            { x: 120, y: 100 },
            { x: 120, y: 120 },
            { x: 100, y: 120 },
          ]),
        }),
      }),
      expect.objectContaining({ id: "polygon" }),
    );

    selected = undefined;
    expect(adapter.pointerDown({ timestamp: 8, x: 180, y: 180 })).toMatchObject(
      {
        detection: expect.objectContaining({ id: "mask" }),
        target: DetectionPickTarget.Mask,
      },
    );
  });

  it.each([
    {
      canvasWidth: 200,
      canvasHeight: 200,
      mediaWidth: 200,
      mediaHeight: 100,
      fit: "contain" as const,
    },
    {
      canvasWidth: 100,
      canvasHeight: 100,
      mediaWidth: 200,
      mediaHeight: 100,
      fit: "contain" as const,
    },
    {
      canvasWidth: 200,
      canvasHeight: 200,
      mediaWidth: 200,
      mediaHeight: 100,
      fit: "cover" as const,
    },
  ])(
    "rotates a selected handle beyond media using layout $fit at $canvasWidth px",
    (dimensions) => {
      const original = {
        id: "obb",
        orientedBox: createOrientedBoxGeometry(
          { x: 100, y: 10, width: 40, height: 20 },
          0,
        ),
      };
      const layout = resolveReactNativeFrameLayout(dimensions);
      const onCommit = vi.fn();
      const capturePointer = vi.fn();
      const releasePointer = vi.fn();
      const onPick = vi.fn();
      const resolveRotation = vi.fn((angle: number) => angle);
      const engine = createAnnotationEditingEngine({
        onCommit,
        capturePointer,
        releasePointer,
        resolveRotation,
      });
      const adapter = createReactNativeAnnotationGestureAdapter({
        editingEngine: engine,
        getFrame: () => ({ mediaTime: 0, detections: [original] }),
        getLayout: () => layout,
        getSelectedDetection: () => original,
        onPick,
      });
      const handle = engine
        .getHandles(original, layout.scale)
        .find(({ id }) => id === "obb-rotate")!;
      const start = layout.mapPoint(handle.point);
      expect(layout.mapCanvasPoint(start)).toBeNull();
      if (dimensions.canvasWidth === 200 && dimensions.fit === "contain") {
        expect(start).toEqual({ x: 100, y: 26 });
      }
      expect(
        adapter.pointerDown({ ...start, timestamp: 1, pointerId: 7 }),
      ).toBeNull();
      expect(engine.getState()).toMatchObject({
        kind: AnnotationGestureStateKind.Rotating,
        activeHandleId: "obb-rotate",
        pointerId: 7,
      });
      expect(onPick).toHaveBeenCalledWith(null);
      expect(capturePointer).toHaveBeenCalledWith(7);
      const end = layout.mapPoint({ x: 100 - (handle.point.y - 10), y: 10 });
      adapter.pointerMove({ ...end, timestamp: 2, pointerId: 8 });
      expect(engine.getState().preview).toBeNull();
      adapter.pointerMove({
        ...end,
        timestamp: 3,
        pointerId: 7,
        shiftKey: true,
      });
      expect(resolveRotation).toHaveBeenLastCalledWith(
        expect.any(Number),
        expect.objectContaining({
          input: expect.objectContaining({ shiftKey: true }),
        }),
      );
      adapter.pointerUp({
        ...end,
        timestamp: 300,
        pointerId: 7,
        shiftKey: true,
      });
      expect(onCommit).toHaveBeenCalledOnce();
      expect(
        getOrientedRectangleGeometry(onCommit.mock.calls[0]![0].orientedBox)
          ?.rotation,
      ).toBeCloseTo(Math.PI / 2);
      expect(releasePointer).toHaveBeenCalledWith(7);
      expect(engine.getState().kind).toBe(AnnotationGestureStateKind.Idle);
    },
  );

  it("uses configured front-side rotation placement after a panned layout", () => {
    const original = {
      id: "obb",
      orientedBox: createOrientedBoxGeometry(
        { x: 100, y: 90, width: 40, height: 20 },
        0,
      ),
    };
    const base = resolveReactNativeFrameLayout({
      canvasWidth: 200,
      canvasHeight: 200,
      mediaWidth: 200,
      mediaHeight: 100,
    });
    const offset = { x: 10, y: -15 };
    const layout = {
      ...base,
      mediaRect: {
        ...base.mediaRect,
        x: base.mediaRect.x + offset.x,
        y: base.mediaRect.y + offset.y,
      },
      mapPoint: (point: { x: number; y: number }) => {
        const mapped = base.mapPoint(point);
        return { x: mapped.x + offset.x, y: mapped.y + offset.y };
      },
      mapCanvasPoint: (point: { x: number; y: number }) =>
        base.mapCanvasPoint({ x: point.x - offset.x, y: point.y - offset.y }),
    };
    const onCommit = vi.fn();
    const engine = createAnnotationEditingEngine({
      onCommit,
      rotationHandle: { edgeIndex: 2, offset: 37, stemOffset: 12 },
    });
    const adapter = createReactNativeAnnotationGestureAdapter({
      editingEngine: engine,
      getFrame: () => ({ mediaTime: 0, detections: [original] }),
      getLayout: () => layout,
      getSelectedDetection: () => original,
    });
    const handle = engine
      .getHandles(original, layout.scale)
      .find(({ id }) => id === "obb-rotate")!;
    const start = layout.mapPoint(handle.point);
    expect(start).toEqual({ x: 110, y: 172 });
    expect(layout.mapCanvasPoint(start)).toBeNull();
    adapter.pointerDown({ ...start, timestamp: 1, pointerId: 7 });
    expect(engine.getState().kind).toBe(AnnotationGestureStateKind.Rotating);
    adapter.pointerMove({ x: 80, y: 160, timestamp: 2, pointerId: 7 });
    adapter.pointerCancel?.(8);
    expect(engine.getState().kind).toBe(AnnotationGestureStateKind.Rotating);
    adapter.pointerCancel?.(7);
    expect(engine.getState().kind).toBe(AnnotationGestureStateKind.Idle);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it.each<Detection>([
    { id: "box", rect: { x: 100, y: 10, width: 40, height: 20 } },
    {
      id: "polygon",
      polygon: {
        points: [
          { x: 80, y: 0 },
          { x: 120, y: 0 },
          { x: 100, y: 20 },
        ],
      },
    },
  ])(
    "accepts the outside half of a selected $id handle hit area",
    (original) => {
      const layout = resolveReactNativeFrameLayout({
        canvasWidth: 200,
        canvasHeight: 200,
        mediaWidth: 200,
        mediaHeight: 100,
      });
      const engine = createAnnotationEditingEngine();
      const adapter = createReactNativeAnnotationGestureAdapter({
        editingEngine: engine,
        getFrame: () => ({ mediaTime: 0, detections: [original] }),
        getLayout: () => layout,
        getSelectedDetection: () => original,
      });
      adapter.pointerDown({ x: 80, y: 46, timestamp: 1, pointerId: 7 });
      expect(engine.getState().kind).toBe(AnnotationGestureStateKind.Resizing);
      expect(engine.getState().activeDetectionId).toBe(original.id);
    },
  );

  it.each([false, true])(
    "rejects letterbox background without a reachable handle (locked: %s)",
    (locked) => {
      const original = {
        id: "obb",
        locked,
        orientedBox: createOrientedBoxGeometry(
          { x: 100, y: 10, width: 40, height: 20 },
          0,
        ),
      };
      const layout = resolveReactNativeFrameLayout({
        canvasWidth: 200,
        canvasHeight: 200,
        mediaWidth: 200,
        mediaHeight: 100,
      });
      const onPick = vi.fn();
      const onCommit = vi.fn();
      const capturePointer = vi.fn();
      const engine = createAnnotationEditingEngine({
        onCommit,
        capturePointer,
      });
      engine.setCreationTool({
        geometry: AnnotationGeometryKind.Box,
        createDetection: (rect) => ({ rect: rect as never }),
      });
      const adapter = createReactNativeAnnotationGestureAdapter({
        editingEngine: engine,
        getFrame: () => ({ mediaTime: 0, detections: [original] }),
        getLayout: () => layout,
        getSelectedDetection: () => original,
        onPick,
      });
      adapter.pointerDown({
        x: locked ? 100 : 160,
        y: 26,
        timestamp: 1,
        pointerId: 7,
      });
      adapter.pointerMove({ x: 150, y: 80, timestamp: 2, pointerId: 7 });
      adapter.pointerUp({ x: 150, y: 80, timestamp: 300, pointerId: 7 });
      expect(engine.getState().kind).toBe(AnnotationGestureStateKind.Idle);
      expect(onPick).not.toHaveBeenCalled();
      expect(onCommit).not.toHaveBeenCalled();
      expect(capturePointer).not.toHaveBeenCalled();
    },
  );
});
