import { describe, expect, it, vi } from "vitest";
import {
  AnnotationGestureStateKind,
  AnnotationHandleKind,
  AnnotationGeometryKind,
  applyAnnotationHandleDrag,
  createAnnotationEditingEngine,
  createEditableAnnotationFrameSession,
  deleteAnnotationVertex,
  DetectionMaskEncoding,
  DetectionPickTarget,
  getAnnotationHandles,
  KeypointVisibility,
  pickAnnotationHandle,
  pickDetectionAtPoint,
  type Detection,
  type DetectionFrame,
  type AnnotationCreationTool,
  type Rect,
} from "../index";

describe("annotation editing engine", () => {
  it("keeps a move alive when the unchanged creation tool is synchronized", () => {
    const onCommit = vi.fn();
    const engine = createAnnotationEditingEngine({ onCommit });
    const frame: DetectionFrame = {
      mediaTime: 12.5,
      detections: [
        { id: "box", rect: { x: 20, y: 30, width: 10, height: 10 } },
      ],
    };
    const pick = pickDetectionAtPoint(frame, { x: 20, y: 30 });
    engine.pointerDown(
      { point: { x: 20, y: 30 }, timestamp: 0, pointerId: 7 },
      pick,
    );
    engine.setCreationTool(null);
    engine.pointerMove({
      point: { x: 30, y: 40 },
      timestamp: 16,
      pointerId: 7,
    });
    engine.pointerUp({ point: { x: 30, y: 40 }, timestamp: 32, pointerId: 7 });
    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit.mock.calls[0]?.[0].rect).toEqual({
      x: 30,
      y: 40,
      width: 10,
      height: 10,
    });
  });

  it("reports rejected creation separately from explicit cancellation", () => {
    const onRejected = vi.fn();
    const onCommit = vi.fn();
    const engine = createAnnotationEditingEngine({ onCommit });
    const tool: AnnotationCreationTool = {
      geometry: AnnotationGeometryKind.Box,
      mode: "drag",
      createDetection: (geometry) => ({ rect: geometry as Rect }),
      onRejected,
    };
    engine.setCreationTool(tool);
    engine.pointerDown({ point: { x: 10, y: 10 }, timestamp: 0 });
    engine.pointerUp({ point: { x: 10, y: 10 }, timestamp: 1 });
    expect(onRejected).toHaveBeenCalledOnce();
    expect(engine.getState().kind).toBe(AnnotationGestureStateKind.Idle);

    engine.pointerDown({ point: { x: 10, y: 10 }, timestamp: 2 });
    engine.keyDown("Escape");
    engine.pointerDown({ point: { x: 10, y: 10 }, timestamp: 3 });
    engine.setCreationTool(null);
    expect(onRejected).toHaveBeenCalledOnce();

    engine.setCreationTool(tool);
    engine.pointerDown({ point: { x: 10, y: 10 }, timestamp: 10 });
    engine.setCreationTool(tool);
    engine.pointerMove({ point: { x: 50, y: 50 }, timestamp: 310 });
    engine.pointerUp({ point: { x: 50, y: 50 }, timestamp: 400 });
    expect(onCommit).toHaveBeenCalledOnce();
    expect(onRejected).toHaveBeenCalledOnce();
  });

  it("moves a heatmap with its pickable rectangle", () => {
    const frame: DetectionFrame = {
      mediaTime: 0,
      detections: [
        {
          id: "anomaly",
          rect: { x: 20, y: 30, width: 10, height: 10 },
          heatmap: {
            bounds: { x: 22, y: 31, width: 6, height: 4 },
            width: 1,
            height: 1,
            values: [0.8],
          },
        },
      ],
    };
    const onCommit = vi.fn();
    const engine = createAnnotationEditingEngine({ onCommit });
    const pick = pickDetectionAtPoint(frame, { x: 20, y: 30 });

    engine.pointerDown({ point: { x: 20, y: 30 }, timestamp: 0 }, pick);
    engine.pointerMove({ point: { x: 30, y: 25 }, timestamp: 16 });
    expect(engine.getState().preview?.heatmap?.bounds).toEqual({
      x: 32,
      y: 26,
      width: 6,
      height: 4,
    });
    engine.pointerUp({ point: { x: 30, y: 25 }, timestamp: 32 });

    expect(onCommit.mock.calls[0]?.[0].heatmap.bounds).toEqual({
      x: 32,
      y: 26,
      width: 6,
      height: 4,
    });
    expect(frame.detections[0]?.heatmap?.bounds.x).toBe(22);
  });

  it.each([false, true])(
    "drags oriented boxes through picking, preview, and commit (other geometry: %s)",
    (withOtherGeometry) => {
      const frame: DetectionFrame = {
        mediaTime: 0,
        detections: [
          {
            id: "obb",
            orientedBox: {
              points: [
                { x: 10, y: 30 },
                { x: 20, y: 20 },
                { x: 30, y: 30 },
                { x: 20, y: 40 },
              ],
            },
            ...(withOtherGeometry
              ? {
                  rect: { x: 20, y: 30, width: 40, height: 40 },
                  polygon: {
                    points: [
                      { x: 0, y: 0 },
                      { x: 50, y: 0 },
                      { x: 25, y: 60 },
                    ],
                  },
                }
              : {}),
          },
        ],
      };
      const session = createEditableAnnotationFrameSession(frame);
      const previous = session.getSnapshot();
      const onCommit = vi.fn((detection: Detection) =>
        session.update("obb", detection),
      );
      const engine = createAnnotationEditingEngine({ onCommit });
      const pick = pickDetectionAtPoint(previous, { x: 20, y: 30 });
      expect(pick?.target).toBe(DetectionPickTarget.OrientedBox);

      engine.pointerDown({ point: { x: 20, y: 30 }, timestamp: 0 }, pick);
      engine.pointerMove({ point: { x: 30, y: 25 }, timestamp: 16 });
      const movedPoints = [
        { x: 20, y: 25 },
        { x: 30, y: 15 },
        { x: 40, y: 25 },
        { x: 30, y: 35 },
      ];
      expect(engine.getState().preview?.orientedBox?.points).toEqual(
        movedPoints,
      );
      expect(session.getSnapshot()).toBe(previous);
      engine.pointerUp({ point: { x: 30, y: 25 }, timestamp: 32 });

      const committed = session.getSnapshot().detections[0]!;
      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(committed.orientedBox?.points).toEqual(movedPoints);
      expect(previous).toEqual(frame);
      expect(
        pickDetectionAtPoint(session.getSnapshot(), { x: 30, y: 25 })?.target,
      ).toBe(DetectionPickTarget.OrientedBox);
      if (withOtherGeometry) {
        expect(committed.rect).toEqual({ x: 30, y: 25, width: 40, height: 40 });
        expect(committed.polygon?.points).toEqual([
          { x: 10, y: -5 },
          { x: 60, y: -5 },
          { x: 35, y: 55 },
        ]);
      }
    },
  );

  it.each([
    ["nw", { x: -200, y: -200 }, { x: 35, y: 25, width: 70, height: 50 }],
    ["n", { x: 50, y: -200 }, { x: 50, y: 25, width: 40, height: 50 }],
    ["ne", { x: 200, y: -200 }, { x: 65, y: 25, width: 70, height: 50 }],
    ["e", { x: 200, y: 40 }, { x: 65, y: 40, width: 70, height: 20 }],
    ["se", { x: 200, y: 200 }, { x: 65, y: 55, width: 70, height: 50 }],
    ["s", { x: 50, y: 200 }, { x: 50, y: 55, width: 40, height: 50 }],
    ["sw", { x: -200, y: 200 }, { x: 35, y: 55, width: 70, height: 50 }],
    ["w", { x: -200, y: 40 }, { x: 35, y: 40, width: 70, height: 20 }],
    ["nw", { x: 200, y: 200 }, { x: 85, y: 65, width: 30, height: 30 }],
    ["se", { x: -200, y: -200 }, { x: 15, y: 15, width: 30, height: 30 }],
  ])(
    "bounds the %s handle in both preview and commit at %j",
    (id, point, rect) => {
      const onCommit = vi.fn();
      const engine = createAnnotationEditingEngine({ onCommit });
      const detection = {
        id: "box",
        rect: { x: 50, y: 40, width: 40, height: 20 },
      };
      const handle = getAnnotationHandles(detection).find(
        (entry) => entry.id === id,
      )!;
      engine.beginHandleDrag(detection, handle, {
        point: handle.point,
        timestamp: 0,
        mediaDimensions: { width: 100, height: 80 },
      });
      engine.pointerMove({ point, timestamp: 16 });
      expect(engine.getState().preview?.rect).toEqual(rect);
      engine.pointerUp({ point, timestamp: 32 });
      expect(onCommit).toHaveBeenCalledExactlyOnceWith(
        { ...detection, rect },
        detection,
      );
      expect(detection.rect).toEqual({ x: 50, y: 40, width: 40, height: 20 });
    },
  );

  it.each([
    {
      rect: { x: 98, y: 78, width: 4, height: 4 },
      media: { width: 100, height: 80 },
      expected: { x: 97.5, y: 77.5, width: 5, height: 5 },
    },
    {
      rect: { x: 1.5, y: 1, width: 3, height: 2 },
      media: { width: 3, height: 2 },
      expected: { x: 1.5, y: 1, width: 3, height: 2 },
    },
  ])(
    "keeps the minimum-size resize inside media $media",
    ({ rect, media, expected }) => {
      const detection = { rect };
      const handle = getAnnotationHandles(detection).find(
        (entry) => entry.id === "nw",
      )!;
      expect(
        applyAnnotationHandleDrag(detection, handle, { x: 200, y: 200 }, media)
          .rect,
      ).toEqual(expected);
    },
  );

  it("bounds a move without resizing the box and keeps fast translation consistent", () => {
    const onCommit = vi.fn();
    const onFastTranslate = vi.fn();
    const engine = createAnnotationEditingEngine({
      onCommit,
      onFastTranslate,
      viewportScale: () => 0.25,
    });
    const detection = {
      id: "box",
      rect: { x: 50, y: 40, width: 40, height: 20 },
    };
    const start = { x: 45, y: 38 };
    const pick = pickDetectionAtPoint(
      { mediaTime: 0, detections: [detection] },
      start,
    );
    engine.pointerDown(
      {
        point: start,
        timestamp: 0,
        mediaDimensions: { width: 100, height: 80 },
      },
      pick,
    );
    engine.pointerMove({ point: { x: 200, y: 200 }, timestamp: 16 });
    expect(engine.getState().preview?.rect).toEqual({
      x: 80,
      y: 70,
      width: 40,
      height: 20,
    });
    expect(onFastTranslate).toHaveBeenLastCalledWith("box", 30, 30);
    engine.pointerMove({ point: start, timestamp: 32 });
    expect(engine.getState().preview?.rect).toEqual(detection.rect);
    engine.pointerMove({ point: { x: -200, y: -200 }, timestamp: 48 });
    const rect = { x: 20, y: 10, width: 40, height: 20 };
    expect(engine.getState().preview?.rect).toEqual(rect);
    expect(onFastTranslate).toHaveBeenLastCalledWith("box", -30, -30);
    engine.pointerUp({ point: { x: -400, y: -400 }, timestamp: 64 });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(
      { ...detection, rect },
      detection,
    );
  });

  it("fits a previously oversized box inside the media when moving it", () => {
    const engine = createAnnotationEditingEngine();
    const detection = {
      id: "box",
      rect: { x: 50, y: 40, width: 140, height: 100 },
    };
    const point = { x: 50, y: 40 };
    engine.pointerDown(
      { point, timestamp: 0, mediaDimensions: { width: 100, height: 80 } },
      pickDetectionAtPoint({ mediaTime: 0, detections: [detection] }, point),
    );
    engine.pointerMove({ point: { x: 200, y: 200 }, timestamp: 16 });
    expect(engine.getState().preview?.rect).toEqual({
      x: 50,
      y: 40,
      width: 100,
      height: 80,
    });
  });

  it.each([
    [
      { x: -200, y: -200 },
      { x: 25, y: 20, width: 50, height: 40 },
    ],
    [
      { x: 200, y: -200 },
      { x: 75, y: 20, width: 50, height: 40 },
    ],
    [
      { x: -200, y: 200 },
      { x: 25, y: 60, width: 50, height: 40 },
    ],
    [
      { x: 200, y: 200 },
      { x: 75, y: 60, width: 50, height: 40 },
    ],
  ])("bounds a created box at %j", (point, rect) => {
    const onCommit = vi.fn();
    const engine = createAnnotationEditingEngine({ onCommit });
    engine.setCreationTool({
      geometry: AnnotationGeometryKind.Box,
      createDetection: (geometry) => ({ rect: geometry as Rect }),
    });
    engine.pointerDown({
      point: { x: 50, y: 40 },
      timestamp: 0,
      mediaDimensions: { width: 100, height: 80 },
    });
    engine.pointerMove({ point, timestamp: 300 });
    expect(engine.getState().preview?.rect).toEqual(rect);
    engine.pointerUp({ point, timestamp: 400 });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith({ rect }, null);
  });

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

  it.each([
    ["nw", { x: 35, y: 50 }, { x: 30, y: 45, width: 10, height: 10 }],
    ["n", { x: 20, y: 50 }, { x: 20, y: 45, width: 10, height: 10 }],
    ["ne", { x: 5, y: 50 }, { x: 10, y: 45, width: 10, height: 10 }],
    ["e", { x: 5, y: 30 }, { x: 10, y: 30, width: 10, height: 20 }],
    ["se", { x: 5, y: 10 }, { x: 10, y: 15, width: 10, height: 10 }],
    ["s", { x: 20, y: 10 }, { x: 20, y: 15, width: 10, height: 10 }],
    ["sw", { x: 35, y: 10 }, { x: 30, y: 15, width: 10, height: 10 }],
    ["w", { x: 35, y: 30 }, { x: 30, y: 30, width: 10, height: 20 }],
    ["nw", { x: 35, y: 10 }, { x: 30, y: 25, width: 10, height: 30 }],
    ["nw", { x: 5, y: 50 }, { x: 15, y: 45, width: 20, height: 10 }],
    ["nw", { x: 24, y: 39 }, { x: 22.5, y: 37.5, width: 5, height: 5 }],
    ["nw", { x: 25, y: 40 }, { x: 22.5, y: 37.5, width: 5, height: 5 }],
    ["nw", { x: 26, y: 41 }, { x: 27.5, y: 42.5, width: 5, height: 5 }],
  ])("resizes %s through the opposite edges at %j", (id, point, rect) => {
    const detection = {
      id: "box",
      rect: { x: 20, y: 30, width: 10, height: 20 },
    };
    const handle = getAnnotationHandles(detection).find(
      (entry) => entry.id === id,
    )!;

    expect(applyAnnotationHandleDrag(detection, handle, point)).toEqual({
      ...detection,
      rect,
    });
    expect(detection.rect).toEqual({ x: 20, y: 30, width: 10, height: 20 });
  });

  it.each([false, true])(
    "keeps the opposite corner anchored through crossing and return (cancel: %s)",
    (cancel) => {
      const onCommit = vi.fn();
      const releasePointer = vi.fn();
      const engine = createAnnotationEditingEngine({
        onCommit,
        releasePointer,
      });
      const detection = {
        id: "box",
        rect: { x: 20, y: 30, width: 10, height: 20 },
      };
      const handle = getAnnotationHandles(detection).find(
        (entry) => entry.id === "nw",
      )!;
      engine.beginHandleDrag(detection, handle, {
        point: handle.point,
        timestamp: 0,
        pointerId: 7,
      });
      engine.pointerMove({
        point: { x: 25, y: 40 },
        timestamp: 16,
        pointerId: 7,
      });
      expect(engine.getState().preview?.rect).toEqual({
        x: 22.5,
        y: 37.5,
        width: 5,
        height: 5,
      });
      engine.pointerMove({
        point: { x: 35, y: 50 },
        timestamp: 32,
        pointerId: 7,
      });
      expect(engine.getState().preview?.rect).toEqual({
        x: 30,
        y: 45,
        width: 10,
        height: 10,
      });
      engine.pointerMove({
        point: { x: 5, y: 10 },
        timestamp: 48,
        pointerId: 7,
      });
      const returned = { x: 15, y: 25, width: 20, height: 30 };
      expect(engine.getState().preview?.rect).toEqual(returned);
      expect(onCommit).not.toHaveBeenCalled();

      if (cancel) {
        engine.keyDown("Escape");
        engine.pointerUp({
          point: { x: 5, y: 10 },
          timestamp: 64,
          pointerId: 7,
        });
        expect(onCommit).not.toHaveBeenCalled();
      } else {
        engine.pointerUp({
          point: { x: 35, y: 50 },
          timestamp: 64,
          pointerId: 7,
        });
        expect(onCommit).toHaveBeenCalledExactlyOnceWith(
          { ...detection, rect: { x: 30, y: 45, width: 10, height: 10 } },
          detection,
        );
      }
      expect(engine.getState().kind).toBe(AnnotationGestureStateKind.Idle);
      expect(releasePointer).toHaveBeenCalledExactlyOnceWith(7);
      expect(detection.rect).toEqual({ x: 20, y: 30, width: 10, height: 20 });
    },
  );

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
