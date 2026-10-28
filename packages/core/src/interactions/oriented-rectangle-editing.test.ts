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
  type AnnotationRotationContext,
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
  it.each([0.25, 1, 4])(
    "places configured handles on ordered edges at scale %s",
    (scale) => {
      const original = detection(Math.PI / 3);
      const tuple = geometry(original);
      for (const edgeIndex of [0, 1, 2, 3] as const) {
        const rotationHandle = { edgeIndex, offset: 37 };
        const engine = createAnnotationEditingEngine({
          rotationHandle: () => rotationHandle,
        });
        const configured = engine.getHandles(original, scale);
        expect(configured).toEqual(
          getAnnotationHandles(original, scale, { rotationHandle }),
        );
        const rotate = configured.find((h) => h.id === "obb-rotate")!;
        const a = original.orientedBox!.points[edgeIndex]!;
        const b = original.orientedBox!.points[(edgeIndex + 1) % 4]!;
        expect(rotate.stemFrom!.x).toBeCloseTo((a.x + b.x) / 2);
        expect(rotate.stemFrom!.y).toBeCloseTo((a.y + b.y) / 2);
        expect(
          Math.hypot(
            rotate.point.x - rotate.stemFrom!.x,
            rotate.point.y - rotate.stemFrom!.y,
          ) * scale,
        ).toBeCloseTo(37);
        expect(
          Math.hypot(rotate.point.x - tuple.x, rotate.point.y - tuple.y),
        ).toBeGreaterThan(
          Math.hypot(
            rotate.stemFrom!.x - tuple.x,
            rotate.stemFrom!.y - tuple.y,
          ),
        );
        expect(configured.filter((h) => h.id !== "obb-rotate")).toEqual(
          getAnnotationHandles(original, scale).filter(
            (h) => h.id !== "obb-rotate",
          ),
        );
      }
    },
  );

  it("resolves every preview and commit from original geometry and latest modifiers", () => {
    const original = {
      ...detection(Math.PI * 0.9),
      metadata: { owner: "host" },
    };
    const resolveRotation = vi.fn(
      (angle: number, { input }: AnnotationRotationContext) =>
        input.shiftKey
          ? Math.round(angle / (Math.PI / 4)) * (Math.PI / 4)
          : angle,
    );
    const onCommit = vi.fn();
    const engine = createAnnotationEditingEngine({ resolveRotation, onCommit });
    const rotate = engine
      .getHandles(original)
      .find((h) => h.id === "obb-rotate")!;
    const start = { x: rotate.point.x + 2, y: rotate.point.y - 3 };
    const angle = Math.PI / 6;
    const dx = start.x - rectangle.x,
      dy = start.y - rectangle.y;
    const end = {
      x: rectangle.x + dx * Math.cos(angle) - dy * Math.sin(angle),
      y: rectangle.y + dx * Math.sin(angle) + dy * Math.cos(angle),
    };
    engine.beginHandleDrag(original, rotate, input(start));
    engine.setModifiers({ shiftKey: true });
    expect(engine.getState().preview).toBeNull();
    expect(resolveRotation).not.toHaveBeenCalled();
    engine.pointerMove(input(end, 100));
    const raw = engine.getState().preview!;
    expect(geometry(raw).rotation).toBeCloseTo((-Math.PI * 14) / 15);
    engine.setModifiers({ shiftKey: true });
    expect(Math.abs(geometry(engine.getState().preview!).rotation)).toBeCloseTo(
      Math.PI,
    );
    engine.setModifiers({});
    expect(engine.getState().preview).toEqual(raw);
    engine.setModifiers({ shiftKey: true });
    expect(onCommit).not.toHaveBeenCalled();
    // The final pointer snapshot releases Shift even without an intervening move.
    engine.pointerUp({ ...input(end, 200), shiftKey: false });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(raw, original);
    expect(resolveRotation).toHaveBeenCalledTimes(5);
    for (const [candidate, context] of resolveRotation.mock.calls) {
      expect(candidate).toBeCloseTo((-Math.PI * 14) / 15);
      expect(context.detection).toBe(original);
      expect(context.initialRotation).toBeCloseTo(Math.PI * 0.9);
    }
    const committed = onCommit.mock.calls[0]![0] as Detection;
    expect(geometry(committed)).toMatchObject({
      x: rectangle.x,
      y: rectangle.y,
    });
    expect(geometry(committed).width).toBeCloseTo(rectangle.width);
    expect(geometry(committed).height).toBeCloseTo(rectangle.height);
    expect(committed.metadata).toBe(original.metadata);
    expect(committed.id).toBe(original.id);
    expect(committed.rect).toBeUndefined();
  });

  it("does not apply a rotation resolver cumulatively or to resize gestures", () => {
    const onCommit = vi.fn();
    const resolveRotation = vi.fn(
      (radians: number) => radians + Math.PI * 4 + 0.1,
    );
    const original = detection();
    const engine = createAnnotationEditingEngine({ onCommit, resolveRotation });
    const rotate = engine
      .getHandles(original)
      .find((h) => h.id === "obb-rotate")!;
    engine.beginHandleDrag(original, rotate, input(rotate.point));
    const end = { x: 250, y: 130 };
    engine.pointerMove(input(end, 100));
    const preview = engine.getState().preview;
    engine.pointerMove(input(end, 110));
    expect(engine.getState().preview).toEqual(preview);
    engine.pointerUp(input(end, 200));
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(preview, original);
    resolveRotation.mockClear();
    engine.beginHandleDrag(
      original,
      handle(original, "obb-se"),
      input({ x: 240, y: 170 }),
    );
    engine.pointerMove(input({ x: 270, y: 190 }, 300));
    const resized = engine.getState().preview;
    engine.setModifiers({ shiftKey: true });
    expect(engine.getState().preview).toBe(resized);
    engine.pointerUp(input({ x: 270, y: 190 }, 400));
    expect(resolveRotation).not.toHaveBeenCalled();
  });

  it.each(["preview", "commit"])(
    "does not overwrite cancellation from the %s resolver callback",
    (phase) => {
      const original = detection();
      const rotate = handle(original, "obb-rotate");
      const onCommit = vi.fn();
      let cancelOnResolve = false;
      const engine = createAnnotationEditingEngine({
        onCommit,
        resolveRotation: (angle) => {
          if (cancelOnResolve) engine.cancel();
          return angle;
        },
      });
      engine.beginHandleDrag(original, rotate, input(rotate.point));
      cancelOnResolve = phase === "preview";
      engine.pointerMove(input({ x: 250, y: 150 }, 100));
      cancelOnResolve = true;
      engine.pointerUp(input({ x: 250, y: 150 }, 200));
      expect(engine.getState().kind).toBe(AnnotationGestureStateKind.Idle);
      expect(engine.getState().preview).toBeNull();
      expect(onCommit).not.toHaveBeenCalled();
    },
  );

  it("rejects nonfinite resolver output before publishing geometry and remains cancellable", () => {
    const onCommit = vi.fn();
    const engine = createAnnotationEditingEngine({
      resolveRotation: () => NaN,
      onCommit,
    });
    const original = detection();
    const rotate = handle(original, "obb-rotate");
    engine.beginHandleDrag(original, rotate, input(rotate.point));
    expect(() => engine.pointerMove(input({ x: 250, y: 150 }, 100))).toThrow(
      RangeError,
    );
    expect(engine.getState().preview).toBeNull();
    engine.keyDown("Escape");
    engine.pointerUp(input({ x: 250, y: 150 }, 200));
    expect(onCommit).not.toHaveBeenCalled();
  });
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
    "resizes in local axes and fixes the opposite corner at %s",
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
      expect(next.rect).toBeUndefined();
    },
  );

  it.each(["nw", "n", "ne", "e", "se", "s", "sw", "w"])(
    "crosses and returns through the original opposite edges with %s",
    (id) => {
      for (const rotation of [0, 0.4, Math.PI / 2, Math.PI, 5.5, Math.PI * 2]) {
        for (const size of [
          { width: 80, height: 40 },
          { width: 30, height: 80 },
          { width: 40, height: 40 },
        ]) {
          const original: Detection = {
            id: "crossing",
            metadata: { owner: "host" },
            orientedBox: createOrientedBoxGeometry(
              { ...rectangle, ...size },
              rotation,
            ),
          };
          const corner = handle(original, `obb-${id}`);
          const cos = Math.cos(rotation),
            sin = Math.sin(rotation);
          const project = (x: number, y: number) => ({
            x: rectangle.x + x * cos - y * sin,
            y: rectangle.y + x * sin + y * cos,
          });
          const sx = id.includes("w") ? -1 : id.includes("e") ? 1 : 0;
          const sy = id.includes("n") ? -1 : id.includes("s") ? 1 : 0;
          const onCommit = vi.fn();
          const engine = createAnnotationEditingEngine({ onCommit });
          engine.beginHandleDrag(original, corner, input(corner.point));
          let end = corner.point;
          let preview: Detection | null = null;
          // Cross each local axis separately, both together, and return.
          const path = [
            [0.5, 0.5],
            [-3, 0.5],
            [0.5, -3],
            [-3, -3],
            [2, 2],
            [-2, -2],
          ];
          for (const [step, [factorX, factorY]] of path.entries()) {
            const x = ((sx * size.width) / 2) * factorX!;
            const y = ((sy * size.height) / 2) * factorY!;
            end = project(x, y);
            engine.pointerMove(input(end, (step + 1) * 50));
            preview = engine.getState().preview!;
            const next = geometry(preview);
            const expected = project(
              sx ? (x - (sx * size.width) / 2) / 2 : 0,
              sy ? (y - (sy * size.height) / 2) / 2 : 0,
            );
            expect(next.x).toBeCloseTo(expected.x);
            expect(next.y).toBeCloseTo(expected.y);
            expect(next.width).toBeCloseTo(
              sx ? Math.abs(x + (sx * size.width) / 2) : size.width,
            );
            expect(next.height).toBeCloseTo(
              sy ? Math.abs(y + (sy * size.height) / 2) : size.height,
            );
            // A crossing changes the occupied bounds, never the ordered axes/front.
            expect(Math.cos(next.rotation)).toBeCloseTo(cos);
            expect(Math.sin(next.rotation)).toBeCloseTo(sin);
            expect(preview.metadata).toBe(original.metadata);
            expect(onCommit).not.toHaveBeenCalled();
          }
          engine.pointerUp(input(end, 400));
          expect(onCommit).toHaveBeenCalledExactlyOnceWith(preview, original);
          expect(original.orientedBox).toEqual(
            createOrientedBoxGeometry({ ...rectangle, ...size }, rotation),
          );
          expect(engine.getState().kind).toBe(AnnotationGestureStateKind.Idle);
        }
      }
    },
  );

  it.each([-0.1, 0, 0.1])(
    "retains a positive minimum on either side of a crossed anchor at %s",
    (offset) => {
      const original = detection();
      const corner = handle(original, "obb-se");
      const next = geometry(
        applyAnnotationHandleDrag(original, corner, {
          x: 160 + offset,
          y: 130 + offset,
        }),
      );
      expect(next.width).toBeCloseTo(1);
      expect(next.height).toBeCloseTo(1);
      expect(next.x).toBeCloseTo(160 + (offset < 0 ? -0.5 : 0.5));
      expect(next.y).toBeCloseTo(130 + (offset < 0 ? -0.5 : 0.5));
      expect(next.rotation).toBe(0);
    },
  );

  it.each(["Escape", "pointerCancel", "toolChange"])(
    "cancels a crossed resize without a history entry on %s",
    (cancellation) => {
      const original = detection(0.4);
      const corner = handle(original, "obb-se");
      const onCommit = vi.fn();
      const onCancel = vi.fn();
      const engine = createAnnotationEditingEngine({ onCommit, onCancel });
      engine.beginHandleDrag(original, corner, input(corner.point));
      const end = {
        x: rectangle.x - 100 * Math.cos(0.4),
        y: rectangle.y - 100 * Math.sin(0.4),
      };
      engine.pointerMove(input(end, 100));
      expect(geometry(engine.getState().preview!).width).toBeCloseTo(60);
      if (cancellation === "Escape") engine.keyDown("Escape");
      else if (cancellation === "pointerCancel") engine.pointerCancel(1);
      else
        engine.setCreationTool({
          geometry: AnnotationGeometryKind.Box,
          createDetection: () => ({}),
        });
      engine.pointerUp(input(end, 300));
      expect(onCommit).not.toHaveBeenCalled();
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(engine.getState().preview).toBeNull();
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

  it.each([
    [{ x: 80, y: 30 }, 0],
    [{ x: 80, y: -30 }, 0],
    [{ x: -80, y: 30 }, Math.PI],
    [{ x: -80, y: -30 }, Math.PI],
    [{ x: 30, y: 80 }, Math.PI / 2],
    [{ x: -30, y: 80 }, Math.PI / 2],
    [{ x: 30, y: -80 }, -Math.PI / 2],
    [{ x: -30, y: -80 }, -Math.PI / 2],
    [{ x: 40, y: 40 }, 0],
    [{ x: -40, y: -40 }, Math.PI],
  ] as const)(
    "orders new local axes along the dominant drag %j",
    (delta, rotation) => {
      const onCommit = vi.fn();
      const shouldCommit = vi.fn(() => true);
      const engine = createAnnotationEditingEngine({ onCommit });
      engine.setCreationTool({
        geometry: AnnotationGeometryKind.OrientedBox,
        shouldCommit,
        createDetection: (points) => ({
          orientedBox: { points: points as OrientedBoxGeometry["points"] },
        }),
      });
      const start = { x: 200, y: 150 };
      const end = { x: start.x + delta.x, y: start.y + delta.y };
      engine.pointerDown(input(start));
      engine.pointerMove(input(end, 100));
      const preview = engine.getState().preview!;
      const next = geometry(preview);
      expect(next.x).toBeCloseTo((start.x + end.x) / 2);
      expect(next.y).toBeCloseTo((start.y + end.y) / 2);
      expect(next.width).toBeCloseTo(
        Math.max(Math.abs(delta.x), Math.abs(delta.y)),
      );
      expect(next.height).toBeCloseTo(
        Math.min(Math.abs(delta.x), Math.abs(delta.y)),
      );
      expect(Math.cos(next.rotation)).toBeCloseTo(Math.cos(rotation));
      expect(Math.sin(next.rotation)).toBeCloseTo(Math.sin(rotation));
      // The footprint remains the same axis-aligned drag rectangle.
      expect(
        preview.orientedBox!.points.map((p) => p.x).sort((a, b) => a - b),
      ).toEqual([start.x, start.x, end.x, end.x].sort((a, b) => a - b));
      expect(
        preview.orientedBox!.points.map((p) => p.y).sort((a, b) => a - b),
      ).toEqual([start.y, start.y, end.y, end.y].sort((a, b) => a - b));
      engine.pointerUp(input(end, 500));
      expect(onCommit).toHaveBeenCalledExactlyOnceWith(preview, null);
      expect(shouldCommit).toHaveBeenCalledExactlyOnceWith(
        preview.orientedBox!.points,
      );
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
      { x: 80, y: 90 },
      { x: 0, y: 90 },
      { x: 0, y: 10 },
      { x: 80, y: 10 },
    ]);
    expect(shouldCommit).toHaveBeenCalledExactlyOnceWith(
      committed.orientedBox!.points,
    );
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});
