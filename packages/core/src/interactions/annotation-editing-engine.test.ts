import { describe, expect, it, vi } from "vitest";
import {
  AnnotationHandleKind,
  AnnotationGeometryKind,
  createAnnotationEditingEngine,
  deleteAnnotationVertex,
  DetectionMaskEncoding,
  DetectionPickTarget,
  getAnnotationHandles,
} from "../index";

describe("annotation editing engine", () => {
  it("creates center-based boxes and applies the click-cancel threshold", () => {
    const onCommit = vi.fn();
    const engine = createAnnotationEditingEngine({ onCommit });
    engine.setCreationTool({
      geometry: AnnotationGeometryKind.Box,
      createDetection: (geometry) => ({ id: "new", rect: geometry as never }),
    });
    engine.pointerDown({ point: { x: 10, y: 20 }, timestamp: 0, pointerId: 1 });
    engine.pointerMove({
      point: { x: 50, y: 60 },
      timestamp: 300,
      pointerId: 1,
    });
    engine.pointerUp({ point: { x: 50, y: 60 }, timestamp: 300, pointerId: 1 });
    expect(onCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        rect: { x: 30, y: 40, width: 40, height: 40 },
      }),
      null,
    );

    engine.pointerDown({ point: { x: 0, y: 0 }, timestamp: 0 });
    engine.pointerUp({ point: { x: 10, y: 10 }, timestamp: 100 });
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("provides resize, midpoint, and safe vertex deletion handles", () => {
    const boxHandles = getAnnotationHandles(
      { rect: { x: 20, y: 30, width: 10, height: 20 } },
      2,
    );
    expect(boxHandles).toHaveLength(8);
    expect(boxHandles[0]).toMatchObject({ point: { x: 15, y: 20 }, radius: 3 });

    const polygon = {
      polygon: {
        points: [
          { x: 0, y: 0 },
          { x: 4, y: 0 },
          { x: 0, y: 4 },
          { x: 1, y: 1 },
        ],
      },
    };
    expect(getAnnotationHandles(polygon)).toHaveLength(8);
    expect(deleteAnnotationVertex(polygon, 3)?.polygon?.points).toHaveLength(3);
    expect(
      deleteAnnotationVertex(deleteAnnotationVertex(polygon, 3)!, 2),
    ).toBeNull();
  });

  it("treats rects as ancillary bounds for masks and native geometries", () => {
    const rect = { height: 20, width: 10, x: 20, y: 30 };
    const points = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 0, y: 4 },
    ];

    expect(
      getAnnotationHandles({
        mask: {
          counts: "04",
          encoding: DetectionMaskEncoding.CompressedRle,
          height: 80,
          width: 120,
        },
        rect,
      }),
    ).toEqual([]);
    expect(
      getAnnotationHandles({ polygon: { points }, rect })[0],
    ).toMatchObject({
      id: "vertex-0",
      kind: AnnotationHandleKind.Vertex,
    });
    expect(
      getAnnotationHandles({
        keypoints: { edges: [[0, 1]], points: points.slice(0, 2) },
        rect,
      }),
    ).toHaveLength(2);
  });

  it("does not move a mask by changing only its ancillary bounds", () => {
    const onCommit = vi.fn();
    const engine = createAnnotationEditingEngine({ onCommit });
    const detection = {
      id: "mask-1",
      mask: {
        counts: "04",
        encoding: DetectionMaskEncoding.CompressedRle,
        height: 80,
        width: 120,
      },
      rect: { height: 20, width: 10, x: 20, y: 30 },
    };
    const pick = {
      detection,
      detectionIndex: 0,
      frame: { detections: [detection], mediaTime: 0 },
      mediaTime: 0,
      point: { x: 20, y: 30 },
      target: DetectionPickTarget.Mask,
    };

    engine.pointerDown({ point: pick.point, timestamp: 0 }, pick);
    engine.pointerMove({ point: { x: 40, y: 50 }, timestamp: 16 });
    engine.pointerUp({ point: { x: 40, y: 50 }, timestamp: 32 });

    expect(engine.getState().kind).toBe("idle");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("publishes renderer subscriptions without taking ownership of persistence", () => {
    const engine = createAnnotationEditingEngine();
    const states = vi.fn();
    const translations = vi.fn();
    const unsubscribeState = engine.subscribe(states);
    const unsubscribeTranslation = engine.subscribeFastTranslate(translations);
    const detection = {
      id: "box-1",
      rect: { x: 10, y: 10, width: 4, height: 4 },
    };
    const pick = {
      detection,
      detectionIndex: 0,
      frame: { detections: [detection], mediaTime: 0 },
      mediaTime: 0,
      point: { x: 10, y: 10 },
      target: DetectionPickTarget.Box,
    };

    engine.pointerDown({ point: { x: 10, y: 10 }, timestamp: 0 }, pick);
    engine.pointerMove({ point: { x: 20, y: 10 }, timestamp: 16 });

    expect(translations).toHaveBeenCalledWith("box-1", 10, 0);
    expect(states).toHaveBeenCalledWith(
      expect.objectContaining({
        preview: expect.objectContaining({ id: "box-1" }),
      }),
    );

    unsubscribeState();
    unsubscribeTranslation();
    engine.pointerMove({ point: { x: 30, y: 10 }, timestamp: 32 });
    expect(translations).toHaveBeenCalledTimes(1);
  });

  it("supports freehand creation as one previewed, pointer-captured gesture", () => {
    const onCommit = vi.fn();
    const capturePointer = vi.fn();
    const releasePointer = vi.fn();
    const engine = createAnnotationEditingEngine({
      capturePointer,
      onCommit,
      releasePointer,
    });
    engine.setCreationTool({
      geometry: AnnotationGeometryKind.Mask,
      createDetection: (points) => ({
        id: "stroke-1",
        polyline: { points: points as never },
      }),
      mode: "freehand",
    });

    engine.pointerDown({ point: { x: 1, y: 2 }, timestamp: 0, pointerId: 4 });
    engine.pointerMove({ point: { x: 3, y: 4 }, timestamp: 10, pointerId: 4 });
    engine.pointerUp({ point: { x: 5, y: 6 }, timestamp: 20, pointerId: 4 });

    expect(capturePointer).toHaveBeenCalledWith(4);
    expect(releasePointer).toHaveBeenCalledWith(4);
    expect(onCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        polyline: {
          points: [
            { x: 1, y: 2 },
            { x: 3, y: 4 },
            { x: 5, y: 6 },
          ],
        },
      }),
      null,
    );
  });
});
