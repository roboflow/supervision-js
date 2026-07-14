import { describe, expect, it, vi } from "vitest";
import type {
  AnnotationEditingEngine,
  DetectionFrame,
} from "supervision-js-core";
import {
  AnnotationGeometryKind,
  createAnnotationEditingEngine,
  DetectionPickTarget,
  encodeBinaryMask,
} from "supervision-js-core";

import { createReactNativeAnnotationGestureAdapter } from "./annotation-gesture-adapter";
import { resolveReactNativeFrameLayout } from "./index";

describe("React Native annotation gesture adapter", () => {
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
});
