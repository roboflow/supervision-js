import { describe, expect, it, vi } from "vitest";
import {
  AnnotationGestureStateKind,
  AnnotationHandleKind,
  AnnotationGeometryKind,
  applyAnnotationHandleDrag,
  createAnnotationEditingEngine,
  deleteAnnotationVertex,
  DetectionMaskEncoding,
  DetectionPickTarget,
  getAnnotationHandles,
  KeypointVisibility,
  pickAnnotationHandle,
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
    const keypointDetection = {
      keypoints: { edges: [[0, 1]] as const, points: points.slice(0, 2) },
      rect,
    };
    const keypointHandles = getAnnotationHandles(keypointDetection);
    expect(keypointHandles).toHaveLength(10);
    // The skeleton's box carries the same inset handles as any box.
    expect(keypointHandles[0]).toMatchObject({
      id: "nw",
      kind: AnnotationHandleKind.Resize,
      point: { x: 15, y: 20 },
    });
    expect(keypointHandles.at(-1)).toMatchObject({
      id: "kp-1",
      kind: AnnotationHandleKind.Keypoint,
    });
    expect(pickAnnotationHandle(keypointHandles, points[0]!)).toMatchObject({
      kind: AnnotationHandleKind.Keypoint,
    });

    const hiddenKeypointHandles = getAnnotationHandles({
      ...keypointDetection,
      keypoints: {
        ...keypointDetection.keypoints,
        visibility: [KeypointVisibility.Visible, KeypointVisibility.NotLabeled],
      },
    });
    expect(hiddenKeypointHandles).toHaveLength(9);
    expect(hiddenKeypointHandles.some((handle) => handle.id === "kp-1")).toBe(
      false,
    );
  });

  it("resizes a skeleton's box from its handles without moving its keypoints", () => {
    const detection = {
      keypoints: {
        edges: [[0, 1]] as const,
        points: [
          { x: 15, y: 20 },
          { x: 25, y: 40 },
        ],
      },
      rect: { x: 20, y: 30, width: 10, height: 20 },
    };
    const southeast = getAnnotationHandles(detection).find(
      (handle) => handle.id === "se",
    )!;

    expect(
      applyAnnotationHandleDrag(detection, southeast, { x: 35, y: 50 }),
    ).toMatchObject({
      keypoints: {
        points: [
          { x: 15, y: 20 },
          { x: 25, y: 40 },
        ],
      },
      rect: { x: 25, y: 35, width: 20, height: 30 },
    });
  });

  it("scales only box-relative keypoints with the box and unflags dragged points", () => {
    const detection = {
      keypoints: {
        boxRelative: [true, false],
        edges: [[0, 1]] as const,
        points: [
          { x: 20, y: 30 },
          { x: 23, y: 36 },
        ],
      },
      rect: { x: 20, y: 30, width: 10, height: 20 },
    };
    const handles = getAnnotationHandles(detection);
    const southeast = handles.find((handle) => handle.id === "se")!;

    // Growing the box from its south-east corner: the template point at the
    // old center lands on the new center, the placed point stays put.
    expect(
      applyAnnotationHandleDrag(detection, southeast, { x: 35, y: 50 }),
    ).toMatchObject({
      keypoints: {
        boxRelative: [true, false],
        points: [
          { x: 25, y: 35 },
          { x: 23, y: 36 },
        ],
      },
      rect: { x: 25, y: 35, width: 20, height: 30 },
    });

    const keypointHandle = handles.find((handle) => handle.id === "kp-0")!;
    const dragged = applyAnnotationHandleDrag(detection, keypointHandle, {
      x: 18,
      y: 22,
    });
    expect(dragged.keypoints).toMatchObject({
      boxRelative: [false, false],
      points: [
        { x: 18, y: 22 },
        { x: 23, y: 36 },
      ],
    });
  });

  it("picks the nearest handle when clustered handles share a hit area", () => {
    const handles = getAnnotationHandles({
      keypoints: {
        edges: [[0, 1]] as const,
        points: [
          { x: 100, y: 100 },
          { x: 104, y: 100 },
          { x: 104, y: 100 },
        ],
      },
    });

    expect(pickAnnotationHandle(handles, { x: 101, y: 100 })?.id).toBe("kp-0");
    expect(pickAnnotationHandle(handles, { x: 103, y: 101 })?.id).toBe("kp-2");
    expect(pickAnnotationHandle(handles, { x: 120, y: 100 })).toBeUndefined();
  });

  it("treats a handle click without movement as a no-op instead of snapping to the pointer", () => {
    const onCommit = vi.fn();
    const onPreview = vi.fn();
    const engine = createAnnotationEditingEngine({ onCommit, onPreview });
    const detection = {
      id: "skeleton-1",
      keypoints: {
        edges: [[0, 1]] as const,
        points: [
          { x: 15, y: 20 },
          { x: 25, y: 40 },
        ],
      },
      rect: { x: 20, y: 30, width: 10, height: 20 },
    };
    const keypointHandle = getAnnotationHandles(detection).find(
      (handle) => handle.id === "kp-0",
    )!;

    // A click lands inside the handle's hit area, not on its exact center.
    engine.beginHandleDrag(detection, keypointHandle, {
      point: { x: 17, y: 21 },
      timestamp: 0,
      pointerId: 1,
    });
    expect(engine.getState().preview).toBeNull();
    engine.pointerMove({
      point: { x: 18, y: 22 },
      timestamp: 16,
      pointerId: 1,
    });
    engine.pointerUp({ point: { x: 18, y: 22 }, timestamp: 32, pointerId: 1 });

    expect(onPreview).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    expect(engine.getState().kind).toBe(AnnotationGestureStateKind.Idle);

    // Past the threshold it is a drag and the keypoint follows the pointer.
    engine.beginHandleDrag(detection, keypointHandle, {
      point: { x: 17, y: 21 },
      timestamp: 100,
      pointerId: 1,
    });
    engine.pointerMove({
      point: { x: 30, y: 40 },
      timestamp: 116,
      pointerId: 1,
    });
    engine.pointerUp({ point: { x: 30, y: 40 }, timestamp: 132, pointerId: 1 });

    expect(onCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        keypoints: expect.objectContaining({
          points: [
            { x: 30, y: 40 },
            { x: 25, y: 40 },
          ],
        }),
      }),
      detection,
    );
  });

  it("moves a whole skeleton without changing its shape", () => {
    const onCommit = vi.fn();
    const engine = createAnnotationEditingEngine({ onCommit });
    const detection = {
      id: "skeleton-1",
      keypoints: {
        edges: [[0, 1]] as const,
        points: [
          { x: 15, y: 20 },
          { x: 25, y: 40 },
        ],
      },
      rect: { x: 20, y: 30, width: 10, height: 20 },
    };
    const pick = {
      detection,
      detectionIndex: 0,
      frame: { detections: [detection], mediaTime: 0 },
      mediaTime: 0,
      point: { x: 20, y: 30 },
      target: DetectionPickTarget.Box,
    };

    engine.pointerDown({ point: pick.point, timestamp: 0 }, pick);
    engine.pointerMove({ point: { x: 30, y: 35 }, timestamp: 16 });
    engine.pointerUp({ point: { x: 30, y: 35 }, timestamp: 32 });

    expect(onCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        keypoints: {
          edges: [[0, 1]],
          points: [
            { x: 25, y: 25 },
            { x: 35, y: 45 },
          ],
        },
        rect: { x: 30, y: 35, width: 10, height: 20 },
      }),
      detection,
    );
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
