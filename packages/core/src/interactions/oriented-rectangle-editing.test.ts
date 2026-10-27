import { describe, expect, it, vi } from "vitest";
import {
  AnnotationGeometryKind,
  AnnotationGestureStateKind,
  AnnotationHandleKind,
  applyAnnotationHandleDrag,
  createAnnotationEditingEngine,
  createOrientedBoxGeometry,
  getAnnotationHandles,
  getOrientedRectangleGeometry,
  pickAnnotationHandle,
  type AnnotationCreationTool,
  type Detection,
  type OrientedBoxGeometry,
  type Point,
} from "../index";

const rectangle = { x: 200, y: 150, width: 80, height: 40 };
const input = (point: Point, timestamp = 0, pointerId = 1) => ({
  point,
  timestamp,
  pointerId,
});
const detection = (rotation = 0): Detection => ({
  id: "r",
  orientedBox: createOrientedBoxGeometry(rectangle, rotation),
});
const handle = (d: Detection, id: string) =>
  getAnnotationHandles(d).find((h) => h.id === id)!;
const geometry = (d: Detection) =>
  getOrientedRectangleGeometry(d.orientedBox!)!;

// Hosts receive one immutable previous/next pair per completed edit for their undo history.
describe("native oriented rectangle editing", () => {
  it.each([
    0,
    Math.PI / 4,
    Math.PI / 2,
    Math.PI,
    Math.PI * 1.5,
    Math.PI * 2,
    -Math.PI * 2,
  ])("preserves ordered axes across round trips at %s", (rotation) => {
    const box = createOrientedBoxGeometry(
      { ...rectangle, width: 40 },
      rotation,
    );
    const tuple = getOrientedRectangleGeometry(box)!;
    expect(tuple.width).toBeCloseTo(40);
    expect(tuple.height).toBeCloseTo(40);
    const again = createOrientedBoxGeometry(tuple, tuple.rotation);
    again.points.forEach((p, i) => {
      expect(p.x).toBeCloseTo(box.points[i]!.x);
      expect(p.y).toBeCloseTo(box.points[i]!.y);
    });
  });

  it("rejects degenerate, reversed, skewed and nonfinite quads without fitting", () => {
    const quad: OrientedBoxGeometry = {
      points: [
        { x: 0, y: 0 },
        { x: 80, y: 0 },
        { x: 60, y: 40 },
        { x: 0, y: 40 },
      ],
    };
    expect(getOrientedRectangleGeometry(quad)).toBeNull();
    expect(getAnnotationHandles({ orientedBox: quad })).toEqual([]);
    expect(
      getOrientedRectangleGeometry({
        points: [
          { x: 0, y: 0 },
          { x: 0, y: 1 },
          { x: 1, y: 1 },
          { x: 1, y: 0 },
        ],
      }),
    ).toBeNull();
    expect(
      getOrientedRectangleGeometry({
        points: [
          { x: NaN, y: 0 },
          ...quad.points.slice(1),
        ] as unknown as OrientedBoxGeometry["points"],
      }),
    ).toBeNull();
    expect(() => createOrientedBoxGeometry({ ...rectangle, width: 0 })).toThrow(
      RangeError,
    );
    expect(getAnnotationHandles({ ...detection(), locked: true })).toEqual([]);
  });

  it.each([0.2, 1, 5])(
    "keeps the visible and circular rotation hit geometry separate at scale %s",
    (scale) => {
      for (const rotation of [0, Math.PI / 4, Math.PI / 2, Math.PI]) {
        const handles = getAnnotationHandles(detection(rotation), scale);
        const rotate = handles.find(
          (h) => h.kind === AnnotationHandleKind.Rotate,
        )!;
        expect(rotate.radius * scale).toBe(4);
        expect(rotate.hitSize * scale).toBe(20);
        expect(
          Math.hypot(
            rotate.point.x - rotate.stemFrom!.x,
            rotate.point.y - rotate.stemFrom!.y,
          ) * scale,
        ).toBeCloseTo(24);
        expect(pickAnnotationHandle(handles, rotate.point)).toBe(rotate);
        expect(
          pickAnnotationHandle([rotate], {
            x: rotate.point.x + 9 / scale,
            y: rotate.point.y + 9 / scale,
          }),
        ).toBeUndefined();
        handles
          .filter((h) => h !== rotate)
          .forEach((h) => {
            expect(
              Math.hypot(
                h.point.x - rotate.point.x,
                h.point.y - rotate.point.y,
              ) * scale,
            ).toBeGreaterThan(10 + 8 * Math.SQRT2);
            expect(pickAnnotationHandle(handles, h.point)).toBe(h);
          });
      }
    },
  );

  it.each([0, 0.4, Math.PI / 2, Math.PI, 5.5])(
    "resizes in local axes, fixes the opposite corner and clamps crossings at %s",
    (rotation) => {
      const original = detection(rotation);
      const corner = handle(original, "obb-se");
      const cos = Math.cos(rotation),
        sin = Math.sin(rotation);
      const next = applyAnnotationHandleDrag(original, corner, {
        x: rectangle.x + 80 * cos - 50 * sin,
        y: rectangle.y + 80 * sin + 50 * cos,
      });
      expect(geometry(next).width).toBeCloseTo(120);
      expect(geometry(next).height).toBeCloseTo(70);
      expect(next.orientedBox!.points[0]!.x).toBeCloseTo(
        original.orientedBox!.points[0]!.x,
      );
      expect(next.orientedBox!.points[0]!.y).toBeCloseTo(
        original.orientedBox!.points[0]!.y,
      );
      const crossed = applyAnnotationHandleDrag(original, corner, {
        x: rectangle.x - 1000 * cos + 1000 * sin,
        y: rectangle.y - 1000 * sin - 1000 * cos,
      });
      expect(geometry(crossed).width).toBeCloseTo(1);
      expect(geometry(crossed).height).toBeCloseTo(1);
      expect(Math.cos(geometry(crossed).rotation)).toBeCloseTo(cos);
      expect(Math.sin(geometry(crossed).rotation)).toBeCloseTo(sin);
      expect(next.rect).toBeUndefined();
    },
  );

  it("rotates without jumping from an off-center press and emits a single undo pair", () => {
    const onCommit = vi.fn();
    const original = detection();
    const rotate = handle(original, "obb-rotate");
    const engine = createAnnotationEditingEngine({ onCommit });
    const start = { x: rotate.point.x + 3, y: rotate.point.y + 2 };
    engine.beginHandleDrag(original, rotate, input(start));
    expect(engine.getState().kind).toBe(AnnotationGestureStateKind.Rotating);
    engine.pointerMove(input(start, 10));
    expect(engine.getState().preview).toBeNull();
    const end = {
      x: rectangle.x - (start.y - rectangle.y),
      y: rectangle.y + start.x - rectangle.x,
    };
    engine.pointerMove(input(end, 100));
    const preview = engine.getState().preview!;
    expect(geometry(preview).rotation).toBeCloseTo(Math.PI / 2);
    expect(geometry(preview).x).toBeCloseTo(rectangle.x);
    engine.pointerUp(input(end, 200));
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(preview, original);
    expect(engine.getState().kind).toBe(AnnotationGestureStateKind.Idle);
    expect(original.orientedBox).toEqual(createOrientedBoxGeometry(rectangle));
  });

  it("retains a square's ordered axes during a continuous full-turn rotation", () => {
    const original: Detection = {
      id: "square",
      orientedBox: createOrientedBoxGeometry({ ...rectangle, width: 40 }),
    };
    const rotate = handle(original, "obb-rotate");
    const onCommit = vi.fn();
    const engine = createAnnotationEditingEngine({ onCommit });
    engine.beginHandleDrag(original, rotate, input(rotate.point));
    const radius = rectangle.y - rotate.point.y;
    let end = rotate.point;
    for (let step = 1; step <= 32; step++) {
      const angle = (step * Math.PI) / 16;
      end = {
        x: rectangle.x + radius * Math.sin(angle),
        y: rectangle.y - radius * Math.cos(angle),
      };
      engine.pointerMove(input(end, step * 20));
      const preview = geometry(engine.getState().preview!);
      expect(preview.width).toBeCloseTo(40);
      expect(preview.height).toBeCloseTo(40);
      expect(Math.cos(preview.rotation)).toBeCloseTo(Math.cos(angle));
      expect(Math.sin(preview.rotation)).toBeCloseTo(Math.sin(angle));
    }
    engine.pointerUp(input(end, 700));
    expect(onCommit).toHaveBeenCalledTimes(1);
    const committed = onCommit.mock.calls[0]![0] as Detection;
    committed.orientedBox!.points.forEach((point, index) => {
      expect(point.x).toBeCloseTo(original.orientedBox!.points[index]!.x);
      expect(point.y).toBeCloseTo(original.orientedBox!.points[index]!.y);
    });
  });

  it.each(["Escape", "pointerCancel", "toolChange"])(
    "cancels rotation without a history entry on %s",
    (cancellation) => {
      const onCommit = vi.fn();
      const onCancel = vi.fn();
      const engine = createAnnotationEditingEngine({ onCommit, onCancel });
      const original = detection();
      const rotate = handle(original, "obb-rotate");
      engine.beginHandleDrag(original, rotate, input(rotate.point));
      engine.pointerMove(input({ x: 280, y: 150 }, 100));
      if (cancellation === "Escape") engine.keyDown("Escape");
      else if (cancellation === "pointerCancel") engine.pointerCancel(1);
      else
        engine.setCreationTool({
          geometry: AnnotationGeometryKind.Box,
          createDetection: () => ({}),
        });
      engine.pointerUp(input({ x: 280, y: 150 }, 300));
      expect(onCommit).not.toHaveBeenCalled();
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(engine.getState().preview).toBeNull();
    },
  );

  it("creates an OBB-only detection in ordered media-bounded corners and validates those same corners", () => {
    const onCommit = vi.fn();
    const shouldCommit = vi.fn(() => true);
    const tool: AnnotationCreationTool = {
      geometry: AnnotationGeometryKind.OrientedBox,
      shouldCommit,
      createDetection: (points) => ({
        id: "new",
        orientedBox: { points: points as OrientedBoxGeometry["points"] },
      }),
    };
    const engine = createAnnotationEditingEngine({ onCommit });
    engine.setCreationTool(tool);
    engine.pointerDown({
      ...input({ x: 80, y: 90 }),
      mediaDimensions: { width: 100, height: 100 },
    });
    engine.pointerMove(input({ x: -20, y: 10 }, 100));
    engine.pointerUp(input({ x: -20, y: 10 }, 500));
    const committed = onCommit.mock.calls[0]![0] as Detection;
    expect(committed.rect).toBeUndefined();
    expect(committed.orientedBox!.points).toEqual([
      { x: 0, y: 10 },
      { x: 80, y: 10 },
      { x: 80, y: 90 },
      { x: 0, y: 90 },
    ]);
    expect(shouldCommit).toHaveBeenCalledExactlyOnceWith(
      committed.orientedBox!.points,
    );
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});
