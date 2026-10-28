import { createPackedMaskCoverage } from "#render-preparation/packed-mask-coverage";
import { pickPackedMaskAtPoint } from "#renderers/packed-mask-picker";
import { describe, expect, it, vi } from "vitest";
import "pixi.js/events";
import {
  Container,
  EventBoundary,
  FederatedPointerEvent,
  Rectangle,
} from "pixi.js";

import { createPixiAnnotationOverlayLayer } from "#renderers/pixi-annotation-overlay-layer";
import { createPixiInteractionLayer } from "#renderers/pixi-interaction-layer";
import {
  AnnotationGeometryKind,
  AnnotationGestureStateKind,
  createAnnotationEditingEngine,
  DetectionMaskEncoding,
  encodeBinaryMask,
  DetectionPickTarget,
  KeypointMarkerShape,
  MediaInteractionMode,
} from "supervision-js-core";
import type { BufferedDetectionTimeline } from "supervision-js-core";
import type {
  AnnotationEditingEngine,
  DetectionFrame,
  Point,
  Rect,
} from "supervision-js-core";
import type { MediaInteractionOptions } from "supervision-js-core";

const frame: DetectionFrame = {
  detections: [
    {
      className: "player",
      id: "player-1",
      rect: { height: 30, width: 20, x: 10, y: 15 },
    },
  ],
  frameIndex: 3,
  mediaTime: 0.1,
};

const nextFrame: DetectionFrame = {
  detections: [
    {
      className: "player",
      id: "player-2",
      rect: { height: 30, width: 20, x: 50, y: 15 },
    },
  ],
  frameIndex: 4,
  mediaTime: 0.2,
};

describe("pixi interaction layer", () => {
  it("releases browser capture when the host interrupts the engine directly", () => {
    const h = createDefaultPressHarness();
    h.engine.setCreationTool({
      geometry: AnnotationGeometryKind.Box,
      createDetection: (rect) => ({ rect: rect as Rect }),
    });
    h.send("pointerdown", 7, 40, 40);
    expect(h.capture).toHaveBeenCalledExactlyOnceWith(7);
    h.engine.pointerCancel?.(7);
    expect(h.release).toHaveBeenCalledExactlyOnceWith(7);
    h.layer.pointerCancel(7);
    expect(h.release).toHaveBeenCalledTimes(1);
    h.send("pointerdown", 8, 50, 40);
    h.send("pointerup", 8, 110, 75, 400);
    expect(h.engine.getState().kind).toBe(AnnotationGestureStateKind.Idle);
  });

  it("preserves capture and tap suppression for a same-id successor started during cancellation", () => {
    let started = false;
    const engine = createAnnotationEditingEngine({
      onCancel: () => {
        if (started) return;
        started = true;
        h.send("pointerdown", 7, 50, 40);
      },
    });
    const h = createDefaultPressHarness(engine);
    engine.setCreationTool({
      geometry: AnnotationGeometryKind.Box,
      createDetection: (rect) => ({ rect: rect as Rect }),
    });
    h.layer.setSelectedDetection({ detectionId: "player-1" });
    h.send("pointerdown", 7, 40, 40);
    h.layer.pointerCancel(7);
    expect(engine.getState().kind).toBe(AnnotationGestureStateKind.Creating);
    expect(h.release).not.toHaveBeenCalled();
    h.send("pointerup", 7, 110, 75, 400);
    h.send("pointertap", 7, 110, 75);
    expect(h.layer.getState().selectedPick?.detection.id).toBe("player-1");
    expect(h.release).toHaveBeenCalledExactlyOnceWith(7);
  });

  it("owns marquee movement and cancellation without applying an interrupted selection", () => {
    const h = createDefaultPressHarness();
    h.send("pointerdown", 7, 110, 75);
    h.send("globalpointermove", 7, 0, 0);
    const dragged = h.layer.getState().marqueeRect;
    expect(dragged).not.toBeNull();
    h.send("pointermove", 8, 80, 60);
    h.send("pointerdown", 8, 80, 60);
    h.send("pointerup", 8, 80, 60);
    h.layer.pointerCancel(8);
    expect(h.layer.getState().marqueeRect).toEqual(dragged);
    h.layer.pointerCancel(7);
    h.send("pointerup", 7, 0, 0);
    expect(h.layer.getState().selectedPicks).toEqual([]);
    expect(h.layer.getState().marqueeRect).toBeNull();
    h.send("pointerdown", 8, 110, 75);
    h.send("globalpointermove", 8, 0, 0);
    h.send("pointerup", 8, 0, 0);
    h.layer.pointerCancel(8);
    h.send("pointertap", 8, 0, 0);
    expect(h.layer.getState().selectedPick?.detection.id).toBe("player-1");
    expect(h.capture.mock.calls).toEqual([[7], [8]]);
    expect(h.release.mock.calls).toEqual([[7], [8]]);
  });

  it("updates a marquee once per Pixi move inside and outside the hit area", () => {
    const onMarqueeChange = vi.fn();
    const layer = createPixiInteractionLayer({
      Container,
      Rectangle,
      canInteract: () => true,
      detectionTimeline: createTimeline(frame),
      interaction: {
        mode: MediaInteractionMode.Always,
        multiSelect: true,
        onMarqueeChange,
      },
    });
    const display = layer.createDisplay({
      width: 120,
      height: 80,
    }) as Container;
    const boundary = new EventBoundary(display);
    const send = (type: string, x: number, y: number) => {
      const event = new FederatedPointerEvent(boundary);
      event.type = type;
      event.pointerId = 7;
      event.pointerType = "mouse";
      event.button = 0;
      event.global.set(x, y);
      boundary.mapEvent(event);
    };
    layer.drawFrame(frame.mediaTime);
    send("pointerdown", 110, 75);
    send("pointermove", 80, 60);
    expect(onMarqueeChange).toHaveBeenCalledExactlyOnceWith({
      x: 80,
      y: 60,
      width: 30,
      height: 15,
    });
    send("pointermove", 150, 100);
    expect(onMarqueeChange).toHaveBeenCalledTimes(2);
    expect(layer.getState().marqueeRect).toEqual({
      x: 110,
      y: 75,
      width: 40,
      height: 25,
    });
    layer.destroy();
  });

  it("ignores capture loss outside a layer-owned press", () => {
    const h = createDefaultPressHarness();
    const cancel = vi.spyOn(h.engine, "pointerCancel");
    h.engine.setCreationTool({
      geometry: AnnotationGeometryKind.Box,
      createDetection: (rect) => ({ rect: rect as Rect }),
    });
    h.send("pointerdown", 7, 40, 40);
    h.send("pointerup", 7, 110, 75, 400);
    h.onStateChange.mockClear();
    h.layer.pointerCaptureLost(7);
    expect(cancel).not.toHaveBeenCalled();
    expect(h.onStateChange).not.toHaveBeenCalled();

    h.engine.pointerDown({
      point: { x: 40, y: 40 },
      timestamp: 500,
      pointerId: 8,
    });
    h.layer.pointerCaptureLost(8);
    expect(h.engine.getState().pointerId).toBe(8);
    h.layer.pointerCancel(7);
    expect(h.engine.getState().pointerId).toBe(8);
    h.layer.pointerCancel(8);
    expect(h.engine.getState().kind).toBe(AnnotationGestureStateKind.Idle);
  });

  it.each([true, false])(
    "preserves multi-click drafts after normal capture release (capability: %s)",
    (hasCapability) => {
      const builtIn = createAnnotationEditingEngine();
      const { pointerCancel: _pointerCancel, ...legacy } = builtIn;
      const h = createDefaultPressHarness(hasCapability ? builtIn : legacy);
      h.engine.setCreationTool({
        geometry: AnnotationGeometryKind.Polygon,
        createDetection: (points) => ({
          polygon: { points: points as Point[] },
        }),
      });
      h.send("pointerdown", 7, 40, 40);
      h.send("pointerup", 7, 40, 40, 1);
      h.layer.pointerCancel(7);
      expect(h.engine.getState().kind).toBe(
        AnnotationGestureStateKind.Creating,
      );
      if (!hasCapability) return;
      h.send("pointerdown", 8, 100, 40, 300);
      h.layer.pointerCancel(8);
      expect(h.engine.getState().preview?.polygon?.points).toEqual([
        { x: 40, y: 40 },
        { x: 100, y: 40 },
        { x: 100, y: 40 },
      ]);
      expect(h.engine.undoCreation?.()).toBe(true);
      expect(h.engine.getState().kind).toBe(
        AnnotationGestureStateKind.Creating,
      );
      expect(h.release.mock.calls).toEqual([[7], [8]]);
    },
  );

  it("keeps the closing press tap suppressed after its normal capture release", () => {
    const h = createDefaultPressHarness();
    h.layer.setSelectedDetection({ detectionId: "player-1" });
    h.engine.setCreationTool({
      geometry: AnnotationGeometryKind.Polygon,
      createDetection: (points) => ({ polygon: { points: points as Point[] } }),
    });
    const points = [
      { x: 40, y: 40 },
      { x: 100, y: 40 },
      { x: 100, y: 70 },
    ];
    points.forEach((point, index) => {
      h.send("pointerdown", 7, point.x, point.y, index * 300);
      h.send("pointerup", 7, point.x, point.y, index * 300 + 1);
    });
    h.send("pointerdown", 7, 40, 40, 900);
    expect(h.engine.getState().kind).toBe(AnnotationGestureStateKind.Idle);
    h.layer.pointerCancel(7);
    h.send("pointertap", 7, 110, 75);
    expect(h.layer.getState().selectedPick?.detection.id).toBe("player-1");
  });

  it("scopes legacy custom-engine cancellation to an explicitly matching owner", () => {
    const builtIn = createAnnotationEditingEngine();
    const { pointerCancel: _pointerCancel, ...legacy } = builtIn;
    const h = createDefaultPressHarness(legacy);
    h.engine.setCreationTool({
      geometry: AnnotationGeometryKind.Box,
      createDetection: (rect) => ({ rect: rect as Rect }),
    });
    h.send("pointerdown", 7, 40, 40);
    h.layer.pointerCancel(8);
    expect(h.engine.getState().pointerId).toBe(7);
    h.layer.pointerCancel(7);
    expect(h.engine.getState().kind).toBe(AnnotationGestureStateKind.Idle);
    expect(h.release).toHaveBeenCalledExactlyOnceWith(7);
  });

  it("commits a native drag when microtasks run before Pixi receives pointerup", async () => {
    const h = createPressHarness(() => "continue");
    h.send("pointerdown", 40, 40, { pointerId: 7 });
    h.send("pointermove", 60, 60, { pointerId: 7 });
    h.layer.pointerUpFallback(7);
    await Promise.resolve();
    expect(h.engine.getState().kind).toBe(AnnotationGestureStateKind.Moving);
    h.send("pointerup", 60, 60, { pointerId: 7 });
    expect(h.onCommit).toHaveBeenCalledExactlyOnceWith(
      { id: "a", rect: { x: 60, y: 60, width: 40, height: 40 } },
      expect.objectContaining({ id: "a" }),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(h.engine.getState().kind).toBe(AnnotationGestureStateKind.Idle);
  });

  it("keeps a released drag selected when pointerup arrives in a later task outside its old box", async () => {
    const h = createPressHarness(() => "continue");
    h.send("pointerdown", 40, 40, { pointerId: 7 });
    h.send("pointermove", 180, 140, { pointerId: 7 });
    h.layer.pointerCaptureLost(7, 0);
    await new Promise<void>((resolve) => setTimeout(resolve, 7));
    expect(h.engine.getState().kind).toBe(AnnotationGestureStateKind.Moving);
    h.send("pointerup", 200, 160, { pointerId: 7 });
    expect(h.onCommit).toHaveBeenCalledExactlyOnceWith(
      { id: "a", rect: { x: 200, y: 160, width: 40, height: 40 } },
      expect.objectContaining({ id: "a" }),
    );
    expect(h.layer.getState().selectedPick?.detection.id).toBe("a");
  });

  it.each([7, 8])(
    "accepts pointer %s after released capture without pointerup",
    async (pointerId) => {
      const h = createPressHarness(() => "continue");
      h.send("pointerdown", 40, 40, { pointerId: 7 });
      h.send("pointermove", 210, 180, { pointerId: 7 });
      h.layer.pointerCaptureLost(7, 0);
      await new Promise<void>((resolve) => setTimeout(resolve, 7));
      h.send("pointerdown", 40, 40, { pointerId });
      h.send("pointermove", 60, 60, { pointerId });
      h.send("pointerup", 60, 60, { pointerId });
      expect(h.onCommit).toHaveBeenCalledExactlyOnceWith(
        { id: "a", rect: { x: 60, y: 60, width: 40, height: 40 } },
        expect.objectContaining({ id: "a" }),
      );
      expect(h.layer.getState().selectedPick?.detection.id).toBe("a");
    },
  );

  it.each([
    { kind: "editing", x: 100, y: 100 },
    { kind: "editing", x: 300, y: 250 },
    { kind: "marquee", x: 100, y: 100 },
    { kind: "marquee", x: 300, y: 250 },
  ])(
    "retires a released $kind before a buttonless move to ($x, $y)",
    ({ kind, x, y }) => {
      const h = createPressHarness(() => "continue");
      h.send(
        "pointerdown",
        kind === "editing" ? 40 : 230,
        kind === "editing" ? 40 : 190,
        { pointerId: 7 },
      );
      h.send("pointermove", 180, 140, { pointerId: 7 });
      h.layer.pointerCaptureLost(7, 0);
      const preview = h.engine.getState().preview;
      const marquee = h.layer.getState().marqueeRect;
      h.send("pointermove", x, y, { pointerId: 8, buttons: 0 });
      expect(h.engine.getState().preview).toEqual(preview);
      expect(h.layer.getState().marqueeRect).toEqual(marquee);
      h.send("pointermove", x, y, { pointerId: 7, buttons: 0 });
      expect(h.engine.getState().kind).toBe(AnnotationGestureStateKind.Idle);
      expect(h.layer.getState().marqueeRect).toBeNull();
      expect(h.onCommit).not.toHaveBeenCalled();
      h.send("pointerdown", 40, 40, { pointerId: 8 });
      h.send("pointermove", 60, 60, { pointerId: 8 });
      h.send("pointerup", 60, 60, { pointerId: 8 });
      expect(h.onCommit).toHaveBeenCalledExactlyOnceWith(
        { id: "a", rect: { x: 60, y: 60, width: 40, height: 40 } },
        expect.objectContaining({ id: "a" }),
      );
    },
  );

  it("retires a consumed native up without cancelling a fresh same-id press", async () => {
    const h = createDefaultPressHarness();
    h.engine.setCreationTool({
      geometry: AnnotationGeometryKind.Box,
      createDetection: (rect) => ({ rect: rect as Rect }),
    });
    h.send("pointerdown", 7, 40, 40);
    h.layer.pointerUpFallback(7);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(h.engine.getState().kind).toBe(AnnotationGestureStateKind.Idle);
    expect(h.release).toHaveBeenCalledExactlyOnceWith(7);
    h.send("pointerdown", 7, 40, 40);
    h.layer.pointerUpFallback(7);
    h.engine.pointerCancel?.(7);
    h.send("pointerdown", 7, 50, 50);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(h.engine.getState().pointerId).toBe(7);
    expect(h.engine.getState().kind).toBe(AnnotationGestureStateKind.Creating);
  });

  it("keeps editing tap suppression attached to its originating pointer", () => {
    const h = createDefaultPressHarness();
    h.send("pointerdown", 7, 15, 20);
    h.send("pointerup", 7, 15, 20);
    h.send("pointertap", 8, 110, 70);
    expect(h.layer.getState().selectedPick).toBeNull();
    h.send("pointertap", 7, 15, 20);
    expect(h.layer.getState().selectedPick).toBeNull();
  });

  it.each([
    {
      name: "body",
      point: [40, 40],
      selection: [],
      pick: "a",
      kind: AnnotationGestureStateKind.Moving,
    },
    {
      name: "repeated body",
      point: [40, 40],
      selection: ["a"],
      pick: "a",
      kind: AnnotationGestureStateKind.Moving,
    },
    {
      name: "composed label",
      point: [100, 110],
      selection: ["b"],
      pick: "a",
      kind: AnnotationGestureStateKind.Moving,
    },
    {
      name: "composed mask",
      point: [200, 20],
      selection: ["mask"],
      pick: "mask",
      kind: AnnotationGestureStateKind.Idle,
    },
    {
      name: "locked body",
      point: [140, 40],
      selection: ["locked"],
      pick: "locked",
      kind: AnnotationGestureStateKind.Idle,
    },
    {
      name: "primary handle",
      point: [60, 60],
      selection: ["b", "a"],
      pick: "b",
      handle: ["a", "se"],
      kind: AnnotationGestureStateKind.Resizing,
    },
    {
      name: "empty",
      point: [230, 180],
      selection: ["a", "b"],
      pick: null,
      kind: AnnotationGestureStateKind.Idle,
    },
    {
      name: "Shift toggle",
      point: [80, 70],
      selection: ["a"],
      pick: "b",
      shiftKey: true,
      kind: AnnotationGestureStateKind.Idle,
    },
    {
      name: "secondary vertex",
      point: [160, 90],
      selection: ["polygon"],
      pick: "polygon",
      handle: ["polygon", "vertex-0"],
      button: 2,
      kind: AnnotationGestureStateKind.Idle,
    },
    {
      name: "selected keypoint",
      point: [40, 130],
      selection: ["pose"],
      pick: "pose",
      handle: ["pose", "kp-0"],
      button: 2,
      kind: AnnotationGestureStateKind.Idle,
    },
  ])(
    "resolves $name before defaults and honors its disposition",
    (testCase) => {
      for (const disposition of ["handled", "continue"] as const) {
        const h = createPressHarness(disposition);
        h.layer.setSelectedDetection({ detectionIds: testCase.selection });
        h.onSelectionChange.mockClear();
        h.send("pointerdown", testCase.point[0]!, testCase.point[1]!, {
          button: testCase.button,
          shiftKey: testCase.shiftKey,
        });
        expect(h.onPointerPress).toHaveBeenCalledOnce();
        const press = h.onPointerPress.mock.calls[0]![0];
        expect(press.input).toMatchObject({
          point: { x: testCase.point[0], y: testCase.point[1] },
          pointerId: 7,
          timestamp: expect.any(Number),
          button: testCase.button ?? 0,
          shiftKey: testCase.shiftKey ?? false,
          mediaDimensions: { width: 240, height: 200 },
        });
        expect(press.pick?.detection.id ?? null).toBe(testCase.pick);
        expect(
          press.selectedHandle
            ? [
                press.selectedHandle.pick.detection.id,
                press.selectedHandle.handle.id,
              ]
            : undefined,
        ).toEqual(testCase.handle);
        expect(h.selectionAtPress).toEqual(testCase.selection);
        if (testCase.name === "composed label")
          expect(press.pick?.target).toBe(DetectionPickTarget.Label);
        if (testCase.name === "composed mask")
          expect(press.pick?.target).toBe(DetectionPickTarget.Mask);
        if (testCase.name === "selected keypoint")
          expect(press.selectedHandle?.handle.geometryIndex).toBe(0);
        expect(h.engine.getState().kind).toBe(
          disposition === "handled"
            ? AnnotationGestureStateKind.Idle
            : testCase.kind,
        );
        h.send("pointerup", testCase.point[0]!, testCase.point[1]!, {
          button: testCase.button,
          shiftKey: testCase.shiftKey,
        });
        if (disposition === "handled") {
          expect(
            h.layer.getState().selectedPicks.map((pick) => pick.detection.id),
          ).toEqual(testCase.selection);
          expect(h.onSelectionChange).not.toHaveBeenCalled();
          expect(h.onCommit).not.toHaveBeenCalled();
        } else if (testCase.name === "secondary vertex") {
          expect(h.onCommit.mock.calls[0]?.[0].polygon.points).toHaveLength(3);
        } else if (testCase.name === "Shift toggle") {
          expect(
            h.layer.getState().selectedPicks.map((pick) => pick.detection.id),
          ).toEqual(["a", "b"]);
        }
      }
    },
  );

  it("retires concurrent handled contacts independently while default editing keeps its own lifecycle", async () => {
    const h = createPressHarness((press) =>
      press.input.altKey ? "handled" : "continue",
    );
    h.engine.setCreationTool({
      geometry: AnnotationGeometryKind.Polyline,
      createDetection: (points) => ({
        polyline: { points: points as readonly Point[] },
      }),
    });
    h.engine.pointerDown({
      point: { x: 10, y: 10 },
      timestamp: 0,
      pointerId: 1,
    });
    h.engine.pointerUp({ point: { x: 10, y: 10 }, timestamp: 1, pointerId: 1 });
    const move = vi.spyOn(h.engine, "pointerMove");
    h.send("pointerdown", 40, 40, { pointerId: 7, altKey: true });
    h.send("pointerdown", 40, 40, { pointerId: 8, altKey: true });
    expect(h.onPointerPress).toHaveBeenCalledTimes(2);
    h.send("pointermove", 60, 60, { pointerId: 7 });
    h.send("pointermove", 60, 60, { pointerId: 8 });
    expect(move).not.toHaveBeenCalled();
    h.layer.pointerUpFallback(7);
    h.send("pointerdown", 40, 40, { pointerId: 7, altKey: true });
    h.layer.pointerCancel(8);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    h.send("pointermove", 60, 60, { pointerId: 7 });
    expect(move).not.toHaveBeenCalled();
    h.send("pointermove", 60, 60, { pointerId: 8 });
    expect(move).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ pointerId: 8 }),
    );
    h.layer.pointerUpFallback(7);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    h.send("pointermove", 60, 60, { pointerId: 7 });
    expect(move).toHaveBeenCalledTimes(2);

    h.engine.setCreationTool({
      geometry: AnnotationGeometryKind.Box,
      createDetection: (rect) => ({ rect: rect as Rect }),
    });
    h.send("pointerdown", 40, 40, { pointerId: 9 });
    h.layer.pointerCancel(8);
    expect(h.engine.getState().pointerId).toBe(9);
    h.layer.pointerCancel(9);
    expect(h.engine.getState().kind).toBe(AnnotationGestureStateKind.Idle);
    h.send("pointerdown", 40, 40, { pointerId: 9 });
    h.send("pointermove", 80, 80, { pointerId: 9 });
    h.layer.pointerUpFallback(9);
    h.send("pointerup", 80, 80, { pointerId: 9 });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(h.engine.getState().kind).toBe(AnnotationGestureStateKind.Idle);
    expect(h.onCommit).toHaveBeenCalledExactlyOnceWith(
      { rect: { x: 60, y: 60, width: 40, height: 40 } },
      null,
    );
  });

  it("retains host capture ownership while another pointer completes an edit", () => {
    const h = createPressHarness((press) =>
      press.input.pointerId === 8 ? "handled" : "continue",
    );
    h.send("pointerdown", 230, 180, { pointerId: 8 });
    expect(h.capture).not.toHaveBeenCalled();
    h.send("pointerdown", 40, 40, { pointerId: 7 });
    h.send("pointermove", 50, 50, { pointerId: 7 });
    expect(h.capture).toHaveBeenCalledExactlyOnceWith(7);
    h.layer.pointerCaptureLost(8);
    h.send("pointerup", 60, 60, { pointerId: 7 });
    expect(h.engine.getState().kind).toBe(AnnotationGestureStateKind.Idle);
    h.send("pointerup", 230, 180, { pointerId: 8 });
    expect(h.layer.getState().selectedPick?.detection.id).toBe("a");
    expect(h.onCommit).toHaveBeenCalledExactlyOnceWith(
      { id: "a", rect: { x: 60, y: 60, width: 40, height: 40 } },
      expect.objectContaining({ id: "a" }),
    );
  });

  it("does not begin a marquee or consume another pointer's tap for a handled empty press", async () => {
    const h = createPressHarness((press) =>
      press.input.pointerId === 7 ? "handled" : "continue",
    );
    h.layer.setSelectedDetection({ detectionIds: ["a", "b"] });
    h.send("pointerdown", 230, 180);
    h.send("pointermove", 10, 10);
    expect(h.layer.getState().marqueeRect).toBeNull();
    h.send("pointerdown", 140, 40, { pointerId: 8 });
    h.send("pointerup", 140, 40, { pointerId: 8 });
    expect(h.layer.getState().selectedPick?.detection.id).toBe("locked");
    h.send("pointerup", 230, 180);
    expect(h.layer.getState().selectedPick?.detection.id).toBe("locked");

    h.send("pointerdown", 230, 180);
    h.send("pointerupoutside", 260, 210);
    await Promise.resolve();
    h.onPointerPress.mockImplementation(() => "continue");
    h.send("pointerdown", 40, 40);
    h.send("pointermove", 50, 50);
    h.send("pointerup", 60, 60);
    expect(h.layer.getState().selectedPick?.detection.id).toBe("a");
    expect(h.engine.getState().kind).toBe(AnnotationGestureStateKind.Idle);
    expect(h.onCommit).toHaveBeenCalledExactlyOnceWith(
      { id: "a", rect: { x: 60, y: 60, width: 40, height: 40 } },
      expect.objectContaining({ id: "a" }),
    );
  });

  it.each(["altKey", "ctrlKey", "metaKey"] as const)(
    "routes a modified %s press to the host and an unmodified edit to completion",
    (modifier) => {
      const h = createPressHarness((press) =>
        press.input[modifier] ? "handled" : "continue",
      );
      h.layer.setSelectedDetection({ detectionIds: ["a", "b"] });
      h.send("pointerdown", 40, 40, { [modifier]: true });
      h.send("pointerup", 40, 40, { [modifier]: true });
      expect(h.onPointerPress.mock.calls[0]![0].input[modifier]).toBe(true);
      expect(h.engine.getState().kind).toBe(AnnotationGestureStateKind.Idle);
      expect(
        h.layer.getState().selectedPicks.map((pick) => pick.detection.id),
      ).toEqual(["a", "b"]);
      expect(h.onCommit).not.toHaveBeenCalled();

      h.send("pointerdown", 40, 40);
      h.send("pointermove", 50, 50);
      h.send("pointerup", 60, 60);
      expect(h.onPointerPress.mock.calls[1]![0].input[modifier]).toBe(false);
      expect(h.engine.getState().kind).toBe(AnnotationGestureStateKind.Idle);
      expect(h.onCommit).toHaveBeenCalledExactlyOnceWith(
        { id: "a", rect: { x: 60, y: 60, width: 40, height: 40 } },
        expect.objectContaining({ id: "a" }),
      );
    },
  );

  it("retires a lost handled press when the same pointer starts a continued edit", () => {
    const h = createPressHarness("handled");
    h.send("pointerdown", 230, 180);
    h.onPointerPress.mockReturnValue("continue");
    h.send("pointerdown", 40, 40);
    h.send("pointermove", 50, 50);
    h.send("pointerup", 60, 60);
    expect(h.engine.getState().kind).toBe(AnnotationGestureStateKind.Idle);
    expect(h.onCommit).toHaveBeenCalledExactlyOnceWith(
      { id: "a", rect: { x: 60, y: 60, width: 40, height: 40 } },
      expect.objectContaining({ id: "a" }),
    );
  });

  it("leaves an existing creation draft untouched during a handled press", () => {
    const h = createPressHarness("handled");
    h.engine.setCreationTool({
      geometry: AnnotationGeometryKind.Polyline,
      createDetection: (points) => ({
        polyline: { points: points as readonly Point[] },
      }),
    });
    h.engine.pointerDown({
      point: { x: 10, y: 10 },
      timestamp: 0,
      pointerId: 7,
    });
    h.engine.pointerUp({ point: { x: 10, y: 10 }, timestamp: 1, pointerId: 7 });
    const pointerUp = vi.spyOn(h.engine, "pointerUp");
    const draft = h.engine.getState();
    h.send("pointerdown", 40, 40);
    h.send("pointermove", 70, 70);
    h.send("pointerup", 70, 70);
    expect(h.engine.getState()).toEqual(draft);
    expect(pointerUp).not.toHaveBeenCalled();
    expect(h.onCommit).not.toHaveBeenCalled();
  });

  it.each([
    [4, "mask", DetectionPickTarget.Mask, false],
    [0, "polygon", DetectionPickTarget.Polygon, false],
    [2, "polygon", DetectionPickTarget.Polygon, false],
    [4, "mask", DetectionPickTarget.Keypoint, true],
  ] as const)(
    "picks the rendered topmost mask/geometry with mask zIndex %s",
    (maskZ, expected, target, withKeypoint) => {
      const mask = encodeBinaryMask(new Uint8Array([1, 1, 1, 1]), 2, 2);
      const mixed: DetectionFrame = {
        mediaTime: 0,
        detections: [
          {
            id: "mask",
            zIndex: maskZ,
            mask,
            keypoints: withKeypoint
              ? { points: [{ x: 15, y: 20 }], edges: [] }
              : undefined,
          },
          {
            id: "box",
            zIndex: 1,
            rect: { x: 15, y: 20, width: 30, height: 30 },
          },
          {
            id: "polygon",
            zIndex: 2,
            polygon: {
              points: [
                { x: 0, y: 0 },
                { x: 30, y: 0 },
                { x: 30, y: 40 },
                { x: 0, y: 40 },
              ],
            },
          },
        ],
      };
      const coverage = [createPackedMaskCoverage(mask, 0)!];
      const layer = createPixiInteractionLayer({
        Container: FakeContainer as never,
        Rectangle: FakeRectangle as never,
        canInteract: () => true,
        detectionTimeline: createTimeline(mixed),
        interaction: { preferTopmost: true, maskOrder: "detection" },
        pickMaskDetectionAtPoint: (point, _time, options) =>
          pickPackedMaskAtPoint(
            mixed,
            coverage,
            point,
            { width: 120, height: 80 },
            options,
          ),
      });
      const display = layer.createDisplay({
        width: 120,
        height: 80,
      }) as FakeContainer;
      layer.drawFrame(0);
      display.emit("pointermove", createPointerEvent(display, 15, 20));
      expect(layer.getState().hoveredPick?.detection.id).toBe(expected);
      expect(layer.getState().hoveredPick?.target).toBe(target);
      layer.destroy();
    },
  );

  it("toggles editing selections through real pointerdown/up events without moving geometry", () => {
    const onCommit = vi.fn();
    const capturePointer = vi.fn();
    const onSelectionChange = vi.fn();
    const editingEngine = createAnnotationEditingEngine({ onCommit });
    const boxes: DetectionFrame = {
      ...frame,
      detections: [
        { id: "first", rect: { x: 40, y: 40, width: 40, height: 40 } },
        { id: "second", rect: { x: 120, y: 40, width: 40, height: 40 } },
      ],
    };
    const layer = createPixiInteractionLayer({
      Container,
      Rectangle,
      canInteract: () => true,
      capturePointer,
      detectionTimeline: createTimeline(boxes),
      editingEngine,
      interaction: {
        mode: MediaInteractionMode.Always,
        multiSelect: true,
        onSelectionChange,
      },
    });
    const display = layer.createDisplay({
      width: 200,
      height: 100,
    }) as Container;
    const boundary = new EventBoundary(display);
    const send = (type: string, x: number, shiftKey = false) => {
      const event = new FederatedPointerEvent(boundary);
      event.type = type;
      event.pointerType = "mouse";
      event.pointerId = 1;
      event.button = 0;
      event.shiftKey = shiftKey;
      event.global.set(x, 40);
      boundary.mapEvent(event);
    };
    const click = (x: number, shiftKey = false) => {
      send("pointerdown", x, shiftKey);
      send("pointerup", x, shiftKey);
    };
    layer.drawFrame(frame.mediaTime);
    click(40);
    capturePointer.mockClear();
    onSelectionChange.mockClear();

    send("pointerdown", 120, true);
    expect(editingEngine.getState().kind).toBe(AnnotationGestureStateKind.Idle);
    send("pointermove", 125, true);
    send("pointerup", 120, true);
    expect(
      layer.getState().selectedPicks.map((pick) => pick.detection.id),
    ).toEqual(["first", "second"]);
    expect(onSelectionChange).toHaveBeenCalledOnce();
    expect(capturePointer).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();

    click(40, true);
    expect(
      layer.getState().selectedPicks.map((pick) => pick.detection.id),
    ).toEqual(["second"]);
    click(120, true);
    expect(layer.getState().selectedPicks).toEqual([]);
    expect(onSelectionChange).toHaveBeenCalledTimes(3);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "keeps normal editing routing when multiSelect is %s and a creation tool is active",
    (multiSelect) => {
      const onCommit = vi.fn();
      const editingEngine = createAnnotationEditingEngine({ onCommit });
      const boxes: DetectionFrame = {
        ...frame,
        detections: [
          { id: "first", rect: { x: 30, y: 30, width: 30, height: 30 } },
          { id: "second", rect: { x: 90, y: 30, width: 30, height: 30 } },
        ],
      };
      const layer = createPixiInteractionLayer({
        Container: FakeContainer as never,
        Rectangle: FakeRectangle as never,
        canInteract: () => true,
        detectionTimeline: createTimeline(boxes),
        editingEngine,
        interaction: { mode: MediaInteractionMode.Always, multiSelect },
      });
      const display = layer.createDisplay({
        width: 160,
        height: 120,
      }) as FakeContainer;
      layer.drawFrame(frame.mediaTime);
      layer.setSelectedDetection({ detectionId: "first" });
      if (multiSelect) {
        editingEngine.setCreationTool({
          geometry: AnnotationGeometryKind.Box,
          createDetection: (rect) => ({ id: "created", rect: rect as Rect }),
        });
      }
      const input = createPointerEvent(display, 90, 30, {
        button: 0,
        pointerId: 1,
        shiftKey: true,
      });
      display.emit("pointerdown", input);
      expect(editingEngine.getState().kind).toBe(
        multiSelect
          ? AnnotationGestureStateKind.Creating
          : AnnotationGestureStateKind.Moving,
      );
      display.emit("pointerup", input);
      display.emit("pointertap", input);
      expect(
        layer.getState().selectedPicks.map((pick) => pick.detection.id),
      ).toEqual([multiSelect ? "first" : "second"]);
      expect(onCommit).not.toHaveBeenCalled();
    },
  );

  it.each(["shift", "secondary"] as const)(
    "preserves %s vertex deletion before multi-selection",
    (modifier) => {
      const onCommit = vi.fn();
      const editingEngine = createAnnotationEditingEngine({ onCommit });
      const polygon = {
        id: "polygon",
        polygon: {
          points: [
            { x: 20, y: 20 },
            { x: 80, y: 20 },
            { x: 80, y: 80 },
            { x: 20, y: 80 },
          ],
        },
      };
      const layer = createPixiInteractionLayer({
        Container: FakeContainer as never,
        Rectangle: FakeRectangle as never,
        canInteract: () => true,
        detectionTimeline: createTimeline({ ...frame, detections: [polygon] }),
        editingEngine,
        interaction: { mode: MediaInteractionMode.Always, multiSelect: true },
      });
      const display = layer.createDisplay({
        width: 120,
        height: 100,
      }) as FakeContainer;
      layer.drawFrame(frame.mediaTime);
      layer.setSelectedDetection({ detectionId: "polygon" });
      const input = createPointerEvent(display, 20, 20, {
        button: modifier === "shift" ? 0 : 2,
        pointerId: 1,
        shiftKey: modifier === "shift",
      });
      display.emit("pointerdown", input);
      display.emit("pointerup", input);
      if (modifier === "shift") display.emit("pointertap", input);
      expect(onCommit).toHaveBeenCalledOnce();
      expect(onCommit.mock.calls[0]?.[0].polygon.points).toHaveLength(3);
      expect(
        layer.getState().selectedPicks.map((pick) => pick.detection.id),
      ).toEqual(["polygon"]);
    },
  );

  it("releases each multi-click press while retaining the draft and unidentified hover", () => {
    const onCommit = vi.fn();
    const editingEngine = createAnnotationEditingEngine({ onCommit });
    editingEngine.setCreationTool({
      geometry: AnnotationGeometryKind.Polyline,
      createDetection: (points) => ({
        polyline: { points: points as readonly Point[] },
      }),
    });
    const layer = createPixiInteractionLayer({
      Container: FakeContainer as never,
      Rectangle: FakeRectangle as never,
      canInteract: () => true,
      detectionTimeline: createTimeline(frame),
      editingEngine,
      interaction: { mode: MediaInteractionMode.Always },
    });
    const display = layer.createDisplay({
      width: 120,
      height: 100,
    }) as FakeContainer;
    layer.drawFrame(frame.mediaTime);
    display.emit(
      "pointerdown",
      createPointerEvent(display, 30, 40, { pointerId: 7, timeStamp: 0 }),
    );
    display.emit(
      "pointerup",
      createPointerEvent(display, 30, 40, { pointerId: 7, timeStamp: 1 }),
    );
    display.emit(
      "pointerdown",
      createPointerEvent(display, 70, 70, { pointerId: 8, timeStamp: 300 }),
    );
    display.emit("globalpointermove", createPointerEvent(display, 80, 60));
    expect(editingEngine.getState().preview?.polyline?.points).toEqual([
      { x: 30, y: 40 },
      { x: 70, y: 70 },
      { x: 80, y: 60 },
    ]);
    display.emit(
      "pointertap",
      createPointerEvent(display, 10, 15, { pointerId: 7 }),
    );
    display.emit(
      "pointertap",
      createPointerEvent(display, 10, 15, { pointerId: 7 }),
    );
    expect(layer.getState().selectedPick).toBeNull();
    display.emit(
      "pointerup",
      createPointerEvent(display, 70, 70, { pointerId: 8, timeStamp: 301 }),
    );
    editingEngine.keyDown("Enter");
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(
      {
        polyline: {
          points: [
            { x: 30, y: 40 },
            { x: 70, y: 70 },
          ],
        },
      },
      null,
    );
  });

  it.each(["move", "resize", "create"] as const)(
    "keeps a %s preview bounded and synchronized with captured moves outside the media",
    (gesture) => {
      const onCommit = vi.fn();
      const onPreview = vi.fn();
      const capturePointer = vi.fn();
      const releasePointer = vi.fn();
      const editingEngine = createAnnotationEditingEngine({
        onCommit,
        onPreview,
      });
      const detection = {
        id: "box",
        rect: { x: 60, y: 50, width: 80, height: 60 },
      };
      const layer = createPixiInteractionLayer({
        Container,
        Rectangle,
        canInteract: () => true,
        capturePointer,
        detectionTimeline: createTimeline({
          ...frame,
          detections: [detection],
        }),
        editingEngine,
        interaction: { mode: MediaInteractionMode.Always },
        releasePointer,
      });
      const display = layer.createDisplay({
        width: 120,
        height: 100,
      }) as Container;
      const boundary = new EventBoundary(display);
      const sendPointer = (
        type: string,
        x: number,
        y: number,
        pointerId = 1,
      ) => {
        const event = new FederatedPointerEvent(boundary);
        event.type = type;
        event.pointerId = pointerId;
        event.pointerType = "mouse";
        event.button = 0;
        event.timeStamp = 500;
        event.global.set(x, y);
        boundary.mapEvent(event);
      };
      layer.drawFrame(0.1);
      if (gesture === "resize") {
        layer.setSelectedDetection({ detectionId: "box" });
      } else if (gesture === "create") {
        editingEngine.setCreationTool({
          geometry: AnnotationGeometryKind.Box,
          createDetection: (rect) => ({
            id: "created",
            rect: rect as typeof detection.rect,
          }),
        });
      }
      const start =
        gesture === "move"
          ? [60, 50]
          : gesture === "resize"
            ? [100, 50]
            : [20, 20];
      sendPointer("pointerdown", start[0]!, start[1]!);
      onPreview.mockClear();
      sendPointer("pointermove", 80, 60);
      sendPointer("pointermove", 200, 150);

      const expected =
        gesture === "move"
          ? { x: 80, y: 70, width: 80, height: 60 }
          : gesture === "resize"
            ? { x: 70, y: 50, width: 100, height: 60 }
            : { x: 70, y: 60, width: 100, height: 80 };
      expect(editingEngine.getState().preview?.rect).toEqual(expected);
      expect(onPreview).toHaveBeenCalledTimes(2);
      expect(onCommit).not.toHaveBeenCalled();

      // A different pointer cannot take over the captured gesture.
      const ownerPoint = layer.getState().pointerPoint;
      sendPointer("pointerdown", 80, 60, 2);
      sendPointer("pointermove", 300, 200, 2);
      sendPointer("pointerup", 300, 200, 2);
      expect(editingEngine.getState().preview?.rect).toEqual(expected);
      expect(layer.getState().pointerPoint).toEqual(ownerPoint);
      expect(onPreview).toHaveBeenCalledTimes(2);
      expect(onCommit).not.toHaveBeenCalled();
      expect(capturePointer).toHaveBeenCalledExactlyOnceWith(1);
      expect(releasePointer).not.toHaveBeenCalled();

      // Re-entering the hit area must not dispatch the same move twice.
      sendPointer("pointermove", 80, 60);
      sendPointer("pointermove", 200, 150);
      expect(onPreview).toHaveBeenCalledTimes(4);
      const finalPreview = editingEngine.getState().preview;
      sendPointer("pointerup", 200, 150);
      expect(onCommit).toHaveBeenCalledExactlyOnceWith(
        finalPreview,
        gesture === "create" ? null : detection,
      );
      expect(editingEngine.getState().kind).toBe(
        AnnotationGestureStateKind.Idle,
      );
      expect(releasePointer).toHaveBeenCalledExactlyOnceWith(1);
      expect(layer.getState().hoveredPick).toBeNull();

      const finalPoint = layer.getState().pointerPoint;
      sendPointer("pointermove", 300, 200);
      expect(layer.getState().pointerPoint).toEqual(finalPoint);
      expect(onPreview).toHaveBeenCalledTimes(5); // Commit clears the preview.
    },
  );

  it("uses the selected annotation handle cursor before the box cursor", () => {
    const layer = createPixiInteractionLayer({
      Container: FakeContainer as never,
      Rectangle: FakeRectangle as never,
      canInteract: () => true,
      detectionTimeline: createTimeline(frame),
      interaction: { mode: MediaInteractionMode.PausedOnly },
    });
    const display = layer.createDisplay({
      height: 80,
      width: 120,
    }) as FakeContainer;

    layer.drawFrame(0.1);
    layer.setSelectedDetection({ detectionId: "player-1" });
    // North-west box handle: it must take precedence over the box's pointer cursor.
    display.emit("pointermove", createPointerEvent(display, 0, 0));

    expect(display.cursor).toBe("nwse-resize");
  });

  it("advertises move over editable geometry and pointer over keypoints", () => {
    const skeletonFrame: DetectionFrame = {
      detections: [
        {
          id: "pose-1",
          keypoints: { edges: [], points: [{ x: 15, y: 20 }] },
          rect: { height: 30, width: 20, x: 15, y: 30 },
        },
      ],
      frameIndex: 3,
      mediaTime: 0.1,
    };
    const layer = createPixiInteractionLayer({
      Container: FakeContainer as never,
      Rectangle: FakeRectangle as never,
      canInteract: () => true,
      detectionTimeline: createTimeline(skeletonFrame),
      editingEngine: createAnnotationEditingEngine(),
      interaction: { mode: MediaInteractionMode.PausedOnly },
    });
    const display = layer.createDisplay({
      height: 80,
      width: 120,
    }) as FakeContainer;

    layer.drawFrame(0.1);
    display.emit("pointermove", createPointerEvent(display, 15, 38));
    expect(display.cursor).toBe("move");

    display.emit("pointermove", createPointerEvent(display, 15, 20));
    expect(display.cursor).toBe("pointer");

    display.emit("pointermove", createPointerEvent(display, 100, 70));
    expect(display.cursor).toBe("default");
  });

  it("uses one media-sized hit surface and ignores picking while gated off", () => {
    const onHover = vi.fn();
    const onSelect = vi.fn();
    let canInteract = false;
    const layer = createPixiInteractionLayer({
      Container: FakeContainer as never,
      Rectangle: FakeRectangle as never,
      canInteract: () => canInteract,
      detectionTimeline: createTimeline(frame),
      interaction: {
        mode: MediaInteractionMode.PausedOnly,
        onHover,
        onSelect,
      },
    });
    const display = layer.createDisplay({
      height: 80,
      width: 120,
    }) as FakeContainer;

    layer.drawFrame(0.1);
    display.emit("pointermove", createPointerEvent(display, 15, 20));
    display.emit("pointertap", createPointerEvent(display, 15, 20));

    expect(onHover).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(display.hitArea).toEqual(
      expect.objectContaining({ height: 80, width: 120, x: 0, y: 0 }),
    );

    canInteract = true;
    display.emit("pointermove", createPointerEvent(display, 15, 20));
    display.emit("pointertap", createPointerEvent(display, 15, 20));

    expect(onHover).toHaveBeenLastCalledWith(
      expect.objectContaining({
        detection: frame.detections[0],
        detectionIndex: 0,
      }),
    );
    expect(onSelect).toHaveBeenLastCalledWith(
      expect.objectContaining({
        detection: frame.detections[0],
        detectionIndex: 0,
      }),
    );
    expect(layer.getState().hoveredPick?.detection.id).toBe("player-1");
    expect(layer.getState().selectedPick?.detection.id).toBe("player-1");

    canInteract = false;
    layer.drawFrame(0.1);

    expect(layer.getState()).toEqual({
      hoveredPick: null,
      selectedPick: expect.objectContaining({
        detection: frame.detections[0],
        detectionIndex: 0,
      }),
    });
    expect(onHover).toHaveBeenLastCalledWith(null);
    expect(onSelect).toHaveBeenLastCalledWith(
      expect.objectContaining({
        detection: frame.detections[0],
        detectionIndex: 0,
      }),
    );
  });

  it("does not pick, select, or cycle through detections rejected by visibility", () => {
    const onSelect = vi.fn();
    const layer = createPixiInteractionLayer({
      Container: FakeContainer as never,
      Rectangle: FakeRectangle as never,
      canInteract: () => true,
      canPickDetection: (detection) => detection.className !== "player",
      detectionTimeline: createTimeline({
        ...frame,
        detections: [
          frame.detections[0]!,
          {
            className: "ball",
            id: "ball-1",
            rect: { height: 10, width: 10, x: 80, y: 20 },
          },
        ],
      }),
      interaction: { mode: MediaInteractionMode.Always, onSelect },
    });
    const display = layer.createDisplay({
      height: 80,
      width: 120,
    }) as FakeContainer;

    layer.drawFrame(frame.mediaTime);
    display.emit("pointertap", createPointerEvent(display, 10, 15));
    expect(layer.getState().selectedPick).toBeNull();

    expect(layer.setSelectedDetection({ detectionId: "player-1" })).toBeNull();
    expect(layer.cycleSelection()?.detection.id).toBe("ball-1");
    expect(onSelect).toHaveBeenLastCalledWith(
      expect.objectContaining({
        detection: expect.objectContaining({ id: "ball-1" }),
      }),
    );
  });

  it("removes only hidden detections from a multi-selection", () => {
    const multiFrame: DetectionFrame = {
      detections: [
        frame.detections[0]!,
        {
          className: "ball",
          id: "ball-1",
          rect: { height: 10, width: 10, x: 80, y: 20 },
        },
      ],
      frameIndex: frame.frameIndex,
      mediaTime: frame.mediaTime,
    };
    const hiddenClasses = new Set<string>();
    const onSelectionChange = vi.fn();
    const layer = createPixiInteractionLayer({
      Container: FakeContainer as never,
      Rectangle: FakeRectangle as never,
      canInteract: () => true,
      canPickDetection: (detection) =>
        !hiddenClasses.has(detection.className ?? ""),
      detectionTimeline: createTimeline(multiFrame),
      interaction: {
        mode: MediaInteractionMode.Always,
        multiSelect: true,
        onSelectionChange,
      },
    });
    const display = layer.createDisplay({
      height: 80,
      width: 120,
    }) as FakeContainer;

    layer.drawFrame(multiFrame.mediaTime);
    display.emit(
      "pointertap",
      createPointerEvent(display, 10, 15, { shiftKey: true }),
    );
    display.emit(
      "pointertap",
      createPointerEvent(display, 80, 20, { shiftKey: true }),
    );
    expect(
      layer.getState().selectedPicks.map(({ detection }) => detection.id),
    ).toEqual(["player-1", "ball-1"]);

    hiddenClasses.add("player");
    layer.drawFrame(multiFrame.mediaTime);

    expect(
      layer.getState().selectedPicks.map(({ detection }) => detection.id),
    ).toEqual(["ball-1"]);
    expect(layer.getState().selectedPick?.detection.id).toBe("ball-1");
    expect(onSelectionChange).toHaveBeenLastCalledWith([
      expect.objectContaining({
        detection: expect.objectContaining({ id: "ball-1" }),
      }),
    ]);
  });

  it("keeps duplicate-id detections distinct when Shift toggles an editing selection", () => {
    const layer = createPixiInteractionLayer({
      Container: FakeContainer as never,
      Rectangle: FakeRectangle as never,
      canInteract: () => true,
      detectionTimeline: createTimeline({
        ...frame,
        detections: [
          { id: "duplicate", rect: { x: 30, y: 30, width: 30, height: 30 } },
          { id: "duplicate", rect: { x: 90, y: 30, width: 30, height: 30 } },
        ],
      }),
      editingEngine: createAnnotationEditingEngine(),
      interaction: { mode: MediaInteractionMode.Always, multiSelect: true },
    });
    const display = layer.createDisplay({
      width: 150,
      height: 100,
    }) as FakeContainer;
    layer.drawFrame(frame.mediaTime);
    const click = (x: number, shiftKey = false) => {
      const event = createPointerEvent(display, x, 30, {
        button: 0,
        pointerId: 1,
        shiftKey,
      });
      display.emit("pointerdown", event);
      display.emit("pointerup", event);
      display.emit("pointertap", event);
    };
    click(30);
    click(90, true);
    expect(
      layer.getState().selectedPicks.map((pick) => pick.detectionIndex),
    ).toEqual([0, 1]);
    click(30, true);
    expect(
      layer.getState().selectedPicks.map((pick) => pick.detectionIndex),
    ).toEqual([1]);
    layer.setSelectedDetection({
      detectionIndex: 1,
      target: DetectionPickTarget.Label,
    });
    click(90, true);
    expect(layer.getState().selectedPicks).toEqual([]);
  });

  it("prefers exact mask picks without advertising an unsupported move", () => {
    const onHover = vi.fn();
    const maskFrame: DetectionFrame = {
      ...frame,
      detections: [
        {
          ...frame.detections[0]!,
          mask: {
            counts: "04",
            encoding: DetectionMaskEncoding.CompressedRle,
            height: 80,
            width: 120,
          },
        },
      ],
    };
    const maskPick = {
      detection: maskFrame.detections[0],
      detectionIndex: 0,
      frame: maskFrame,
      mediaTime: maskFrame.mediaTime,
      point: { x: 15, y: 20 },
      target: DetectionPickTarget.Mask,
    };
    const pickMaskDetectionAtPoint = vi.fn(() => maskPick);
    const layer = createPixiInteractionLayer({
      Container: FakeContainer as never,
      Rectangle: FakeRectangle as never,
      canInteract: () => true,
      detectionTimeline: createTimeline(maskFrame),
      editingEngine: createAnnotationEditingEngine(),
      interaction: {
        mode: MediaInteractionMode.PausedOnly,
        onHover,
      },
      pickMaskDetectionAtPoint,
    });
    const display = layer.createDisplay({
      height: 80,
      width: 120,
    }) as FakeContainer;

    layer.drawFrame(0.1);
    display.emit("pointermove", createPointerEvent(display, 15, 20));

    expect(pickMaskDetectionAtPoint).toHaveBeenCalledWith(
      { x: 15, y: 20 },
      0.1,
    );
    expect(onHover).toHaveBeenLastCalledWith(maskPick);
    expect(display.cursor).toBe("pointer");
  });

  it("picks geometry above a prepared mask when topmost geometry is requested", () => {
    const onHover = vi.fn();
    const mixedFrame: DetectionFrame = {
      detections: [
        { id: "box", rect: { x: 15, y: 20, width: 10, height: 10 } },
        {
          id: "mask",
          zIndex: 99,
          rect: { x: 60, y: 40, width: 120, height: 80 },
          mask: {
            counts: "04",
            encoding: DetectionMaskEncoding.CompressedRle,
            height: 80,
            width: 120,
          },
        },
      ],
      mediaTime: 0.1,
    };
    const maskPick = {
      detection: mixedFrame.detections[1]!,
      detectionIndex: 1,
      frame: mixedFrame,
      mediaTime: 0.1,
      point: { x: 15, y: 20 },
      target: DetectionPickTarget.Mask,
    };
    const layer = createPixiInteractionLayer({
      Container: FakeContainer as never,
      Rectangle: FakeRectangle as never,
      canInteract: () => true,
      detectionTimeline: createTimeline(mixedFrame),
      interaction: { onHover, preferTopmost: true },
      pickMaskDetectionAtPoint: () => maskPick,
    });
    const display = layer.createDisplay({
      height: 80,
      width: 120,
    }) as FakeContainer;
    layer.drawFrame(0.1);
    display.emit("pointermove", createPointerEvent(display, 15, 20));
    expect(onHover).toHaveBeenLastCalledWith(
      expect.objectContaining({
        detection: expect.objectContaining({ id: "box" }),
        target: DetectionPickTarget.Box,
      }),
    );
    display.emit("pointermove", createPointerEvent(display, 90, 70));
    expect(onHover).toHaveBeenLastCalledWith(maskPick);
    layer.destroy();
  });

  it("lets keypoint picks outrank the prepared-mask fast path", () => {
    const onHover = vi.fn();
    const keypointFrame: DetectionFrame = {
      detections: [
        frame.detections[0]!,
        {
          className: "person",
          id: "pose-1",
          keypoints: {
            edges: [[0, 1]],
            points: [
              { x: 15, y: 20 },
              { x: 18, y: 40 },
            ],
          },
          rect: { height: 30, width: 20, x: 15, y: 30 },
        },
      ],
      frameIndex: 3,
      mediaTime: 0.1,
    };
    const maskPick = {
      detection: keypointFrame.detections[0],
      detectionIndex: 0,
      frame: keypointFrame,
      mediaTime: keypointFrame.mediaTime,
      point: { x: 15, y: 20 },
      target: DetectionPickTarget.Mask,
    };
    const pickMaskDetectionAtPoint = vi.fn(() => maskPick);
    const layer = createPixiInteractionLayer({
      Container: FakeContainer as never,
      Rectangle: FakeRectangle as never,
      canInteract: () => true,
      detectionTimeline: createTimeline(keypointFrame),
      interaction: {
        mode: MediaInteractionMode.PausedOnly,
        onHover,
      },
      pickMaskDetectionAtPoint,
    });
    const display = layer.createDisplay({
      height: 80,
      width: 120,
    }) as FakeContainer;

    layer.drawFrame(0.1);
    display.emit("pointermove", createPointerEvent(display, 15, 20));

    expect(onHover).toHaveBeenLastCalledWith(
      expect.objectContaining({
        detection: keypointFrame.detections[1],
        geometryIndex: 0,
        target: DetectionPickTarget.Keypoint,
      }),
    );
  });

  it("keeps keypoint hover tolerance constant on screen when zoomed out", () => {
    const onHover = vi.fn();
    const keypointFrame: DetectionFrame = {
      detections: [
        {
          className: "person",
          id: "pose-1",
          keypoints: {
            edges: [[0, 1]],
            points: [
              { x: 100, y: 100 },
              { x: 100, y: 400 },
            ],
          },
          rect: { height: 400, width: 200, x: 150, y: 250 },
        },
      ],
      frameIndex: 3,
      mediaTime: 0.1,
    };
    let viewportScale = 1;
    const layer = createPixiInteractionLayer({
      Container: FakeContainer as never,
      Rectangle: FakeRectangle as never,
      canInteract: () => true,
      detectionTimeline: createTimeline(keypointFrame),
      getViewportScale: () => viewportScale,
      interaction: {
        mode: MediaInteractionMode.PausedOnly,
        onHover,
      },
    });
    const display = layer.createDisplay({
      height: 800,
      width: 800,
    }) as FakeContainer;

    layer.drawFrame(0.1);
    // 24 media units from the keypoint: 24 screen px at 1:1, but only 6 screen
    // px once the media is fitted at a quarter scale.
    display.emit("pointermove", createPointerEvent(display, 124, 100));

    expect(onHover).toHaveBeenLastCalledWith(
      expect.objectContaining({ target: DetectionPickTarget.Box }),
    );

    viewportScale = 0.25;
    display.emit("pointermove", createPointerEvent(display, 124, 101));

    expect(onHover).toHaveBeenLastCalledWith(
      expect.objectContaining({
        detection: keypointFrame.detections[0],
        geometryIndex: 0,
        target: DetectionPickTarget.Keypoint,
      }),
    );
  });

  it("lets skeleton edge picks outrank the prepared-mask fast path", () => {
    const onHover = vi.fn();
    const keypointFrame: DetectionFrame = {
      detections: [
        frame.detections[0]!,
        {
          className: "person",
          id: "pose-1",
          keypoints: {
            edges: [[0, 1]],
            points: [
              { x: 15, y: 5 },
              { x: 15, y: 55 },
            ],
          },
          rect: { height: 50, width: 20, x: 15, y: 30 },
        },
      ],
      frameIndex: 3,
      mediaTime: 0.1,
    };
    const maskPick = {
      detection: keypointFrame.detections[0],
      detectionIndex: 0,
      frame: keypointFrame,
      mediaTime: keypointFrame.mediaTime,
      point: { x: 15, y: 30 },
      target: DetectionPickTarget.Mask,
    };
    const layer = createPixiInteractionLayer({
      Container: FakeContainer as never,
      Rectangle: FakeRectangle as never,
      canInteract: () => true,
      detectionTimeline: createTimeline(keypointFrame),
      interaction: {
        mode: MediaInteractionMode.PausedOnly,
        onHover,
      },
      pickMaskDetectionAtPoint: vi.fn(() => maskPick),
    });
    const display = layer.createDisplay({
      height: 80,
      width: 120,
    }) as FakeContainer;

    layer.drawFrame(0.1);
    display.emit("pointermove", createPointerEvent(display, 15, 30));

    expect(onHover).toHaveBeenLastCalledWith(
      expect.objectContaining({
        detection: keypointFrame.detections[1],
        geometryIndex: 0,
        target: DetectionPickTarget.Edge,
      }),
    );
  });

  it.each([
    {
      area: "empty space",
      from: { x: 80, y: 60 },
      to: { x: 90, y: 65 },
      hoverCalls: 0,
    },
    {
      area: "the same detection",
      from: { x: 10, y: 20 },
      to: { x: 15, y: 25 },
      hoverCalls: 1,
    },
  ])(
    "invalidates creation guides for each pointer move over $area without repeating hover callbacks",
    ({ from, to, hoverCalls }) => {
      const onStateChange = vi.fn();
      const onHover = vi.fn();
      const editingEngine = createAnnotationEditingEngine();
      editingEngine.setCreationTool({
        geometry: AnnotationGeometryKind.Box,
        createDetection: () => ({ id: "created" }),
      });
      const layer = createPixiInteractionLayer({
        Container: FakeContainer as never,
        Rectangle: FakeRectangle as never,
        canInteract: () => true,
        detectionTimeline: createTimeline(frame),
        editingEngine,
        interaction: { mode: MediaInteractionMode.PausedOnly, onHover },
        onStateChange,
      });
      const display = layer.createDisplay({
        height: 80,
        width: 120,
      }) as FakeContainer;
      layer.drawFrame(0.1);
      onStateChange.mockClear();
      onHover.mockClear();

      display.emit("pointermove", createPointerEvent(display, from.x, from.y));
      display.emit("pointermove", createPointerEvent(display, to.x, to.y));

      expect(layer.getState().pointerPoint).toEqual(to);
      expect(onHover).toHaveBeenCalledTimes(hoverCalls);
      expect(onStateChange).toHaveBeenCalledTimes(2);
      expect(
        onStateChange.mock.calls.map(([state]) => state.pointerPoint),
      ).toEqual([from, to]);
    },
  );

  it("invalidates creation guides on pointer exit even when no detection was hovered", () => {
    const onStateChange = vi.fn();
    const onHover = vi.fn();
    const editingEngine = createAnnotationEditingEngine();
    editingEngine.setCreationTool({
      geometry: AnnotationGeometryKind.Box,
      createDetection: () => ({ id: "created" }),
    });
    const layer = createPixiInteractionLayer({
      Container: FakeContainer as never,
      Rectangle: FakeRectangle as never,
      canInteract: () => true,
      detectionTimeline: createTimeline(frame),
      editingEngine,
      interaction: { mode: MediaInteractionMode.PausedOnly, onHover },
      onStateChange,
    });
    const display = layer.createDisplay({
      height: 80,
      width: 120,
    }) as FakeContainer;
    layer.drawFrame(0.1);
    display.emit("pointermove", createPointerEvent(display, 80, 60));
    expect(layer.getState().pointerPoint).toEqual({ x: 80, y: 60 });
    expect(layer.getState().hoveredPick).toBeNull();
    onStateChange.mockClear();
    onHover.mockClear();

    display.emit("pointerout", createPointerEvent(display, 121, 60));

    expect(layer.getState().pointerPoint).toBeNull();
    expect(onHover).not.toHaveBeenCalled();
    expect(onStateChange).toHaveBeenCalledTimes(1);
    expect(onStateChange.mock.calls[0]![0].pointerPoint).toBeNull();
  });

  it("notifies the host when hover or selected interaction state changes", () => {
    const onStateChange = vi.fn();
    const layer = createPixiInteractionLayer({
      Container: FakeContainer as never,
      Rectangle: FakeRectangle as never,
      canInteract: () => true,
      detectionTimeline: createTimeline(frame),
      interaction: {
        mode: MediaInteractionMode.PausedOnly,
      },
      onStateChange,
    });
    const display = layer.createDisplay({
      height: 80,
      width: 120,
    }) as FakeContainer;

    layer.drawFrame(0.1);
    display.emit("pointermove", createPointerEvent(display, 15, 20));

    expect(onStateChange).toHaveBeenLastCalledWith({
      hoveredPick: expect.objectContaining({
        detection: frame.detections[0],
        detectionIndex: 0,
      }),
      selectedPick: null,
    });

    display.emit("pointertap", createPointerEvent(display, 15, 20));

    expect(onStateChange).toHaveBeenLastCalledWith({
      hoveredPick: expect.objectContaining({
        detection: frame.detections[0],
        detectionIndex: 0,
      }),
      selectedPick: expect.objectContaining({
        detection: frame.detections[0],
        detectionIndex: 0,
      }),
    });
  });

  it("picks against the active drawn frame instead of reselecting independently", () => {
    const onHover = vi.fn();
    let selectedFrame = frame;
    const layer = createPixiInteractionLayer({
      Container: FakeContainer as never,
      Rectangle: FakeRectangle as never,
      canInteract: () => true,
      detectionTimeline: createTimeline(() => selectedFrame),
      interaction: {
        mode: MediaInteractionMode.PausedOnly,
        onHover,
      },
    });
    const display = layer.createDisplay({
      height: 80,
      width: 120,
    }) as FakeContainer;

    layer.drawFrame(0.1);
    selectedFrame = nextFrame;
    display.emit("pointermove", createPointerEvent(display, 15, 20));

    expect(onHover).toHaveBeenLastCalledWith(
      expect.objectContaining({
        detection: frame.detections[0],
        detectionIndex: 0,
        frame,
        mediaTime: frame.mediaTime,
        target: DetectionPickTarget.Box,
      }),
    );

    layer.drawFrame(0.2);

    expect(onHover).toHaveBeenLastCalledWith(null);
  });

  it("keeps hover and selected picks when the active frame is an equivalent clone", () => {
    const onHover = vi.fn();
    const onSelect = vi.fn();
    let selectedFrame = frame;
    const layer = createPixiInteractionLayer({
      Container: FakeContainer as never,
      Rectangle: FakeRectangle as never,
      canInteract: () => true,
      detectionTimeline: createTimeline(() => selectedFrame),
      interaction: {
        mode: MediaInteractionMode.PausedOnly,
        onHover,
        onSelect,
      },
    });
    const display = layer.createDisplay({
      height: 80,
      width: 120,
    }) as FakeContainer;

    layer.drawFrame(0.1);
    display.emit("pointermove", createPointerEvent(display, 15, 20));
    display.emit("pointertap", createPointerEvent(display, 15, 20));

    selectedFrame = cloneDetectionFrame(frame);
    layer.drawFrame(0.1);

    expect(layer.getState().hoveredPick).toMatchObject({
      detection: selectedFrame.detections[0],
      detectionIndex: 0,
      target: DetectionPickTarget.Box,
    });
    expect(layer.getState().selectedPick).toMatchObject({
      detection: selectedFrame.detections[0],
      detectionIndex: 0,
      target: DetectionPickTarget.Box,
    });
    expect(layer.getState().hoveredPick?.frame).toBe(selectedFrame);
    expect(layer.getState().selectedPick?.frame).toBe(selectedFrame);
    expect(onHover).not.toHaveBeenLastCalledWith(null);
    expect(onSelect).not.toHaveBeenLastCalledWith(null);
  });

  it("follows the selected detection id onto later frames while hover stays per-frame", () => {
    const onHover = vi.fn();
    const onSelect = vi.fn();
    const followedFrame: DetectionFrame = {
      detections: [
        {
          className: "player",
          id: "player-2",
          rect: { height: 30, width: 20, x: 50, y: 15 },
        },
        {
          className: "player",
          id: "player-1",
          rect: { height: 30, width: 20, x: 40, y: 45 },
        },
      ],
      frameIndex: 4,
      mediaTime: 0.2,
    };
    let activeFrame = frame;
    const layer = createPixiInteractionLayer({
      Container: FakeContainer as never,
      Rectangle: FakeRectangle as never,
      canInteract: () => true,
      detectionTimeline: createTimeline(() => activeFrame),
      interaction: {
        mode: MediaInteractionMode.PausedOnly,
        onHover,
        onSelect,
      },
    });
    const display = layer.createDisplay({
      height: 80,
      width: 120,
    }) as FakeContainer;

    layer.drawFrame(0.1);
    display.emit("pointermove", createPointerEvent(display, 15, 20));
    display.emit("pointertap", createPointerEvent(display, 15, 20));

    activeFrame = followedFrame;
    layer.drawFrame(0.2);

    expect(layer.getState().selectedPick).toMatchObject({
      detection: followedFrame.detections[1],
      detectionIndex: 1,
      frame: followedFrame,
      mediaTime: 0.2,
    });
    // Following the same identity onto a new frame is an internal refresh,
    // not a public selection change.
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenLastCalledWith(
      expect.objectContaining({ detection: frame.detections[0] }),
    );
    expect(layer.getState().hoveredPick).toBeNull();
    expect(onHover).toHaveBeenLastCalledWith(null);
  });

  it("keeps public selection callbacks at identity-change frequency", () => {
    const onSelect = vi.fn();
    const onSelectionChange = vi.fn();
    const onStateChange = vi.fn();
    const frames: DetectionFrame[] = [0.1, 0.2, 0.3, 0.4].map(
      (mediaTime, frameIndex) => ({
        detections: [
          {
            className: "player",
            id: "player-1",
            rect: { height: 30, width: 20, x: 10 + frameIndex, y: 15 },
          },
        ],
        frameIndex: frameIndex + 3,
        mediaTime,
      }),
    );
    let activeFrame: DetectionFrame = frames[0]!;
    const layer = createPixiInteractionLayer({
      Container: FakeContainer as never,
      Rectangle: FakeRectangle as never,
      canInteract: () => true,
      detectionTimeline: createTimeline(() => activeFrame),
      interaction: {
        mode: MediaInteractionMode.PausedOnly,
        onSelect,
        onSelectionChange,
      },
      onStateChange,
    });
    const display = layer.createDisplay({
      height: 80,
      width: 120,
    }) as FakeContainer;

    layer.drawFrame(0.1);
    display.emit("pointermove", createPointerEvent(display, 15, 20));
    display.emit("pointertap", createPointerEvent(display, 15, 20));

    const selectCallsAfterTap = onSelect.mock.calls.length;
    display.emit("pointerout", createPointerEvent(display, 15, 20));

    for (const [index, nextFrame] of frames.entries()) {
      if (index === 0) continue;
      const stateCallsBeforeFrame = onStateChange.mock.calls.length;
      activeFrame = nextFrame;
      layer.drawFrame(nextFrame.mediaTime);
      expect(onStateChange.mock.calls.length).toBe(stateCallsBeforeFrame);
    }

    // The normal scene frame path consumes the refreshed internal state. No
    // event-driven redraw or public selection callback fires while identity
    // is unchanged.
    expect(onSelect.mock.calls.length).toBe(selectCallsAfterTap);
    expect(onSelectionChange.mock.calls.length).toBe(selectCallsAfterTap);
    expect(layer.getState().selectedPick?.frame).toBe(frames.at(-1));

    activeFrame = nextFrameWithoutPlayer();
    layer.drawFrame(0.5);

    expect(onSelect).toHaveBeenLastCalledWith(null);
    expect(onSelect.mock.calls.length).toBe(selectCallsAfterTap + 1);

    function nextFrameWithoutPlayer(): DetectionFrame {
      return {
        detections: [
          {
            className: "player",
            id: "player-9",
            rect: { height: 30, width: 20, x: 60, y: 15 },
          },
        ],
        frameIndex: 9,
        mediaTime: 0.5,
      };
    }
  });

  it("reports removal when a numeric id is replaced by its string form", () => {
    const onSelect = vi.fn();
    const onSelectionChange = vi.fn();
    const numericFrame = {
      detections: [
        {
          className: "player",
          id: 1,
          rect: { height: 30, width: 20, x: 10, y: 15 },
        },
      ],
      frameIndex: 3,
      mediaTime: 0.1,
    } satisfies DetectionFrame;
    const stringFrame = {
      detections: [
        {
          className: "player",
          id: "1",
          rect: { height: 30, width: 20, x: 10, y: 15 },
        },
      ],
      frameIndex: 4,
      mediaTime: 0.2,
    } satisfies DetectionFrame;
    let activeFrame: DetectionFrame = numericFrame;
    const layer = createPixiInteractionLayer({
      Container: FakeContainer as never,
      Rectangle: FakeRectangle as never,
      canInteract: () => true,
      detectionTimeline: createTimeline(() => activeFrame),
      interaction: {
        mode: MediaInteractionMode.PausedOnly,
        onSelect,
        onSelectionChange,
      },
    });
    const display = layer.createDisplay({
      height: 80,
      width: 120,
    }) as FakeContainer;

    layer.drawFrame(0.1);
    display.emit("pointermove", createPointerEvent(display, 15, 20));
    display.emit("pointertap", createPointerEvent(display, 15, 20));

    activeFrame = stringFrame;
    layer.drawFrame(0.2);

    expect(layer.getState().selectedPick).toBeNull();
    expect(onSelect).toHaveBeenLastCalledWith(null);
    expect(onSelectionChange).toHaveBeenLastCalledWith([]);
  });

  it("keeps the selection following its detection during paused-only playback", () => {
    const onSelect = vi.fn();
    const followedFrame: DetectionFrame = {
      detections: [
        {
          className: "player",
          id: "player-1",
          rect: { height: 30, width: 20, x: 40, y: 45 },
        },
      ],
      frameIndex: 4,
      mediaTime: 0.2,
    };
    let activeFrame = frame;
    let paused = true;
    const layer = createPixiInteractionLayer({
      Container: FakeContainer as never,
      Rectangle: FakeRectangle as never,
      canInteract: () => paused,
      detectionTimeline: createTimeline(() => activeFrame),
      interaction: {
        mode: MediaInteractionMode.PausedOnly,
        onSelect,
      },
    });
    const display = layer.createDisplay({
      height: 80,
      width: 120,
    }) as FakeContainer;

    layer.drawFrame(0.1);
    display.emit("pointermove", createPointerEvent(display, 15, 20));
    display.emit("pointertap", createPointerEvent(display, 15, 20));

    paused = false;
    activeFrame = followedFrame;
    layer.drawFrame(0.2);

    expect(layer.getState().selectedPick).toMatchObject({
      detection: followedFrame.detections[0],
      detectionIndex: 0,
      frame: followedFrame,
    });

    activeFrame = nextFrame;
    layer.drawFrame(0.3);

    expect(layer.getState().selectedPick).toBeNull();
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it("holds the selection through a media time whose detections have not arrived", () => {
    const onSelect = vi.fn();
    const onSelectionChange = vi.fn();
    const laterFrame: DetectionFrame = {
      detections: [
        {
          className: "ball",
          id: "ball-1",
          rect: { height: 10, width: 10, x: 80, y: 20 },
        },
        {
          className: "player",
          id: "player-1",
          rect: { height: 30, width: 20, x: 40, y: 45 },
        },
      ],
      frameIndex: 5,
      mediaTime: 0.3,
    };
    let activeFrame: DetectionFrame | undefined = frame;
    const layer = createPixiInteractionLayer({
      Container: FakeContainer as never,
      Rectangle: FakeRectangle as never,
      canInteract: () => true,
      detectionTimeline: createTimeline(() => activeFrame),
      interaction: {
        mode: MediaInteractionMode.PausedOnly,
        onSelect,
        onSelectionChange,
      },
    });
    const display = layer.createDisplay({
      height: 80,
      width: 120,
    }) as FakeContainer;

    layer.drawFrame(0.1);
    display.emit("pointertap", createPointerEvent(display, 15, 20));
    const selectCalls = onSelect.mock.calls.length;
    const selectionChangeCalls = onSelectionChange.mock.calls.length;

    activeFrame = undefined;
    layer.drawFrame(0.2);

    expect(layer.getState().selectedPick?.detection.id).toBe("player-1");
    expect(
      layer.getState().selectedPicks.map(({ detection }) => detection.id),
    ).toEqual(["player-1"]);
    expect(onSelect.mock.calls.length).toBe(selectCalls);
    expect(onSelectionChange.mock.calls.length).toBe(selectionChangeCalls);

    activeFrame = laterFrame;
    layer.drawFrame(0.3);

    expect(layer.getState().selectedPick).toMatchObject({
      detection: laterFrame.detections[1],
      detectionIndex: 1,
      frame: laterFrame,
      mediaTime: 0.3,
    });
  });

  it("clears a held selection on the first arriving frame without the detection", () => {
    const onSelect = vi.fn();
    const onSelectionChange = vi.fn();
    let activeFrame: DetectionFrame | undefined = frame;
    const layer = createPixiInteractionLayer({
      Container: FakeContainer as never,
      Rectangle: FakeRectangle as never,
      canInteract: () => true,
      detectionTimeline: createTimeline(() => activeFrame),
      interaction: {
        mode: MediaInteractionMode.PausedOnly,
        onSelect,
        onSelectionChange,
      },
    });
    const display = layer.createDisplay({
      height: 80,
      width: 120,
    }) as FakeContainer;

    layer.drawFrame(0.1);
    display.emit("pointertap", createPointerEvent(display, 15, 20));

    activeFrame = undefined;
    layer.drawFrame(0.2);

    expect(layer.getState().selectedPick?.detection.id).toBe("player-1");

    activeFrame = nextFrame;
    layer.drawFrame(0.3);

    expect(layer.getState().selectedPick).toBeNull();
    expect(onSelect).toHaveBeenLastCalledWith(null);
    expect(onSelectionChange).toHaveBeenLastCalledWith([]);
  });

  it("drops a held selection hidden while its detections had not arrived", () => {
    const onSelectionChange = vi.fn();
    const hiddenClasses = new Set<string>();
    let activeFrame: DetectionFrame | undefined = frame;
    const layer = createPixiInteractionLayer({
      Container: FakeContainer as never,
      Rectangle: FakeRectangle as never,
      canInteract: () => true,
      canPickDetection: (detection) =>
        !hiddenClasses.has(detection.className ?? ""),
      detectionTimeline: createTimeline(() => activeFrame),
      interaction: {
        mode: MediaInteractionMode.PausedOnly,
        onSelectionChange,
      },
    });
    const display = layer.createDisplay({
      height: 80,
      width: 120,
    }) as FakeContainer;

    layer.drawFrame(0.1);
    display.emit("pointertap", createPointerEvent(display, 15, 20));

    hiddenClasses.add("player");
    activeFrame = undefined;
    layer.drawFrame(0.2);

    expect(layer.getState().selectedPick?.detection.id).toBe("player-1");

    activeFrame = frame;
    layer.drawFrame(0.1);

    expect(layer.getState().selectedPick).toBeNull();
    expect(onSelectionChange).toHaveBeenLastCalledWith([]);
  });

  it("ignores stale mask picks and falls back to boxes on the active frame", () => {
    const onHover = vi.fn();
    const staleMaskPick = {
      detection: nextFrame.detections[0],
      detectionIndex: 0,
      frame: nextFrame,
      mediaTime: nextFrame.mediaTime,
      point: { x: 15, y: 20 },
      target: DetectionPickTarget.Mask,
    };
    const pickMaskDetectionAtPoint = vi.fn(() => staleMaskPick);
    const layer = createPixiInteractionLayer({
      Container: FakeContainer as never,
      Rectangle: FakeRectangle as never,
      canInteract: () => true,
      detectionTimeline: createTimeline(frame),
      interaction: {
        mode: MediaInteractionMode.PausedOnly,
        onHover,
      },
      pickMaskDetectionAtPoint,
    });
    const display = layer.createDisplay({
      height: 80,
      width: 120,
    }) as FakeContainer;

    layer.drawFrame(0.1);
    display.emit("pointermove", createPointerEvent(display, 15, 20));

    expect(onHover).toHaveBeenLastCalledWith(
      expect.objectContaining({
        detection: frame.detections[0],
        frame,
        target: DetectionPickTarget.Box,
      }),
    );
  });

  it("allows the host to select and clear an active detection programmatically", () => {
    const onSelect = vi.fn();
    const layer = createPixiInteractionLayer({
      Container: FakeContainer as never,
      Rectangle: FakeRectangle as never,
      canInteract: () => true,
      detectionTimeline: createTimeline(frame),
      interaction: {
        mode: MediaInteractionMode.PausedOnly,
        onSelect,
      },
    });
    layer.createDisplay({
      height: 80,
      width: 120,
    });
    layer.drawFrame(0.1);

    const pick = layer.setSelectedDetection({
      detectionIndex: 0,
      target: DetectionPickTarget.Box,
    });

    expect(pick).toMatchObject({
      detection: frame.detections[0],
      detectionIndex: 0,
      frame,
      target: DetectionPickTarget.Box,
    });
    expect(onSelect).toHaveBeenLastCalledWith(pick);
    expect(layer.getState().selectedPick).toBe(pick);

    expect(layer.setSelectedDetection(null)).toBeNull();
    expect(layer.getState().selectedPick).toBeNull();
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it("restores ordered host multi-selections, filters missing ids, and clears or narrows them", () => {
    const onSelectionChange = vi.fn();
    let activeFrame: DetectionFrame = {
      ...frame,
      detections: [
        { id: "first", rect: { x: 30, y: 30, width: 20, height: 20 } },
        { id: 1, rect: { x: 60, y: 30, width: 20, height: 20 } },
        { id: "1", rect: { x: 90, y: 30, width: 20, height: 20 } },
        { id: "hidden", rect: { x: 120, y: 30, width: 20, height: 20 } },
      ],
    };
    const layer = createPixiInteractionLayer({
      Container: FakeContainer as never,
      Rectangle: FakeRectangle as never,
      canInteract: () => true,
      canPickDetection: (detection) => detection.id !== "hidden",
      detectionTimeline: createTimeline(() => activeFrame),
      interaction: {
        mode: MediaInteractionMode.Always,
        multiSelect: true,
        onSelectionChange,
      },
    });
    layer.createDisplay({ width: 160, height: 80 });
    layer.drawFrame(frame.mediaTime);
    const selection = {
      detectionId: "first",
      detectionIds: ["first", "missing", "hidden", 1, "1", "first"],
    };
    expect(layer.setSelectedDetection(selection)?.detection.id).toBe("1");
    expect(
      layer.getState().selectedPicks.map((pick) => pick.detection.id),
    ).toEqual(["first", 1, "1"]);
    layer.setSelectedDetection(selection);
    expect(onSelectionChange).toHaveBeenCalledOnce();

    activeFrame = {
      ...activeFrame,
      detections: activeFrame.detections.map((detection) => ({
        ...detection,
        className: "updated",
      })),
    };
    layer.drawFrame(frame.mediaTime);
    layer.setSelectedDetection(selection);
    expect(
      layer.getState().selectedPicks.map((pick) => pick.detection.className),
    ).toEqual(["updated", "updated", "updated"]);
    expect(onSelectionChange).toHaveBeenCalledOnce();

    // The primary pick is unchanged, but membership still changes.
    layer.setSelectedDetection({ detectionId: "1" });
    expect(
      layer.getState().selectedPicks.map((pick) => pick.detection.id),
    ).toEqual(["1"]);
    expect(onSelectionChange).toHaveBeenCalledTimes(2);
    layer.setSelectedDetection({ detectionIds: ["1", "first"] });
    expect(layer.getState().selectedPick?.detection.id).toBe("first");
    expect(layer.setSelectedDetection({ detectionIds: [] })).toBeNull();
    expect(layer.getState().selectedPicks).toEqual([]);
    expect(
      layer.setSelectedDetection({ detectionIds: ["missing"] }),
    ).toBeNull();
    expect(layer.getState().selectedPicks).toEqual([]);
  });

  it.each([
    { mode: undefined, reverse: false },
    { mode: "intersects", reverse: false },
    { mode: "contained", reverse: false },
    { mode: undefined, reverse: true },
    { mode: "intersects", reverse: true },
    { mode: "contained", reverse: true },
  ] as const)(
    "keeps $mode marquee selection through the editing-engine sequence (reverse=$reverse)",
    ({ mode, reverse }) => {
      const onCommit = vi.fn();
      const onSelectionChange = vi.fn();
      const editingEngine = createAnnotationEditingEngine({ onCommit });
      const layer = createPixiInteractionLayer({
        Container: FakeContainer as never,
        Rectangle: FakeRectangle as never,
        canInteract: () => true,
        detectionTimeline: createTimeline({
          ...frame,
          detections: [
            { id: "first", rect: { x: 30, y: 30, width: 20, height: 20 } },
            { id: "second", rect: { x: 70, y: 30, width: 20, height: 20 } },
            { id: "boundary", rect: { x: 50, y: 50, width: 10, height: 20 } },
            { id: "outside", rect: { x: 120, y: 30, width: 20, height: 20 } },
          ],
        }),
        editingEngine,
        interaction: {
          mode: MediaInteractionMode.Always,
          multiSelect: true,
          marqueeSelectionMode: mode,
          onSelectionChange,
        },
      });
      const display = layer.createDisplay({
        width: 160,
        height: 80,
      }) as FakeContainer;
      layer.drawFrame(frame.mediaTime);
      display.emit(
        "pointerdown",
        createPointerEvent(display, reverse ? 75 : 5, reverse ? 60 : 5, {
          button: 0,
          pointerId: 1,
          shiftKey: true,
        }),
      );
      display.emit(
        "globalpointermove",
        createPointerEvent(display, reverse ? 5 : 75, reverse ? 5 : 60, {
          pointerId: 1,
          shiftKey: true,
        }),
      );
      display.emit(
        "pointerup",
        createPointerEvent(display, reverse ? 5 : 75, reverse ? 5 : 60, {
          button: 0,
          pointerId: 1,
          shiftKey: true,
        }),
      );
      display.emit(
        "pointertap",
        createPointerEvent(display, reverse ? 5 : 75, reverse ? 5 : 60, {
          shiftKey: true,
        }),
      );
      expect(
        layer.getState().selectedPicks.map((pick) => pick.detection.id),
      ).toEqual(
        mode === "contained"
          ? ["first", "boundary"]
          : ["first", "second", "boundary"],
      );
      expect(onSelectionChange).toHaveBeenCalledOnce();
      expect(onSelectionChange.mock.calls[0]?.[0]).toEqual(
        layer.getState().selectedPicks,
      );
      expect(onCommit).not.toHaveBeenCalled();
    },
  );

  it("previews a dragged keypoint at the pointer before the gesture commits", () => {
    const onCommit = vi.fn();
    const editingEngine = createAnnotationEditingEngine({
      onCommit,
      viewportScale: () => 0.5,
    });
    const skeletonFrame: DetectionFrame = {
      detections: [
        {
          className: "person",
          id: "pose-1",
          keypoints: {
            edges: [[0, 1]],
            points: [
              { x: 100, y: 100 },
              { x: 100, y: 200 },
            ],
          },
          rect: { height: 100, width: 100, x: 100, y: 150 },
        },
      ],
      frameIndex: 3,
      mediaTime: 0.1,
    };
    const layer = createPixiInteractionLayer({
      Container: FakeContainer as never,
      Rectangle: FakeRectangle as never,
      canInteract: () => true,
      detectionTimeline: createTimeline(skeletonFrame),
      editingEngine,
      getViewportScale: () => 0.5,
      interaction: { mode: MediaInteractionMode.PausedOnly },
    });
    const display = layer.createDisplay({
      height: 400,
      width: 400,
    }) as FakeContainer;
    const graphics = {
      arc: vi.fn(),
      circle: vi.fn(),
      clear: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(),
      lineTo: vi.fn(),
      moveTo: vi.fn(),
      poly: vi.fn(),
      roundRect: vi.fn(),
      stroke: vi.fn(),
    };
    for (const method of Object.values(graphics)) {
      method.mockReturnValue(graphics);
    }
    const overlay = createPixiAnnotationOverlayLayer(editingEngine, undefined, {
      resolve: (detection) => ({
        edges: [],
        markers: (detection.keypoints?.points ?? []).map((point, index) => ({
          fill: { alpha: 1, color: 0x00ff66 },
          index,
          point,
          radius: 4,
          shape: KeypointMarkerShape.Circle,
        })),
      }),
    });
    overlay.attachGraphics(graphics as never);
    const drawOverlay = () =>
      overlay.draw({
        frame: skeletonFrame,
        marquee: null,
        mediaHeight: 400,
        mediaWidth: 400,
        now: 0,
        pointer: null,
        selectedDetectionIds: ["pose-1"],
        viewportScale: 0.5,
      });

    layer.drawFrame(0.1);
    layer.setSelectedDetection({ detectionId: "pose-1" });
    // Press on the first keypoint's handle, then move without releasing.
    display.emit(
      "pointerdown",
      createPointerEvent(display, 100, 100, {
        button: 0,
        pointerId: 1,
        timeStamp: 0,
      }),
    );
    display.emit(
      "globalpointermove",
      createPointerEvent(display, 140, 130, {
        buttons: 1,
        pointerId: 1,
        timeStamp: 1,
      }),
    );
    drawOverlay();

    expect(editingEngine.getState()).toMatchObject({
      activeDetectionId: "pose-1",
      kind: AnnotationGestureStateKind.Resizing,
    });
    expect(editingEngine.getState().preview?.keypoints?.points[0]).toEqual({
      x: 140,
      y: 130,
    });
    expect(graphics.circle).toHaveBeenCalledWith(140, 130, expect.any(Number));
    expect(onCommit).not.toHaveBeenCalled();

    display.emit(
      "pointerup",
      createPointerEvent(display, 140, 130, {
        button: 0,
        pointerId: 1,
        timeStamp: 2,
      }),
    );

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0]?.[0]).toMatchObject({
      keypoints: expect.objectContaining({
        points: [
          { x: 140, y: 130 },
          { x: 100, y: 200 },
        ],
      }),
    });
    expect(editingEngine.getState().kind).toBe(AnnotationGestureStateKind.Idle);
  });

  it.each([false, true])(
    "uses the composed label pick for the first gesture (drag: %s)",
    (drag) => {
      const onCommit = vi.fn();
      const onSelect = vi.fn();
      const editingEngine = createAnnotationEditingEngine({ onCommit });
      const labelPoint = { x: 60, y: 60 };
      const layer = createPixiInteractionLayer({
        Container: FakeContainer as never,
        Rectangle: FakeRectangle as never,
        canInteract: () => true,
        detectionTimeline: createTimeline(frame),
        editingEngine,
        interaction: { mode: MediaInteractionMode.PausedOnly, onSelect },
        pickLabelDetectionAtPoint: () => ({
          detection: frame.detections[0]!,
          detectionIndex: 0,
          frame,
          mediaTime: frame.mediaTime,
          point: labelPoint,
          target: DetectionPickTarget.Label,
        }),
      });
      const display = layer.createDisplay({
        width: 120,
        height: 80,
      }) as FakeContainer;
      layer.drawFrame(frame.mediaTime);
      display.emit(
        "pointerdown",
        createPointerEvent(display, 60, 60, {
          button: 0,
          pointerId: 8,
          timeStamp: 0,
        }),
      );
      editingEngine.setCreationTool(null);
      if (drag)
        display.emit(
          "globalpointermove",
          createPointerEvent(display, 70, 70, { pointerId: 8, timeStamp: 16 }),
        );
      display.emit(
        "pointerup",
        createPointerEvent(display, drag ? 70 : 60, drag ? 70 : 60, {
          button: 0,
          pointerId: 8,
          timeStamp: 32,
        }),
      );
      display.emit("pointertap", createPointerEvent(display, 60, 60));
      expect(layer.getState().selectedPick?.mediaTime).toBe(frame.mediaTime);
      expect(onSelect).toHaveBeenCalledOnce();
      expect(onCommit).toHaveBeenCalledTimes(drag ? 1 : 0);
      if (drag)
        expect(onCommit.mock.calls[0]?.[0].rect).toEqual({
          x: 20,
          y: 25,
          width: 20,
          height: 30,
        });
    },
  );

  it("selects a detection before beginning a primary editing gesture", () => {
    const onSelect = vi.fn();
    const editingEngine = createAnnotationEditingEngine();
    const layer = createPixiInteractionLayer({
      Container: FakeContainer as never,
      Rectangle: FakeRectangle as never,
      canInteract: () => true,
      detectionTimeline: createTimeline(frame),
      editingEngine,
      interaction: {
        mode: MediaInteractionMode.PausedOnly,
        onSelect,
      },
    });
    const display = layer.createDisplay({
      height: 80,
      width: 120,
    }) as FakeContainer;

    layer.drawFrame(0.1);
    display.emit(
      "pointerdown",
      createPointerEvent(display, 15, 20, {
        button: 0,
        pointerId: 1,
        timeStamp: 0,
      }),
    );

    expect(layer.getState().selectedPick?.detection.id).toBe("player-1");
    expect(editingEngine.getState().kind).toBe(
      AnnotationGestureStateKind.Moving,
    );
    expect(onSelect).toHaveBeenCalledTimes(1);

    display.emit(
      "pointerup",
      createPointerEvent(display, 15, 20, {
        button: 0,
        pointerId: 1,
        timeStamp: 1,
      }),
    );
    display.emit("pointertap", createPointerEvent(display, 15, 20));

    expect(layer.getState().selectedPick?.detection.id).toBe("player-1");
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

class FakeRectangle {
  constructor(
    readonly x: number,
    readonly y: number,
    readonly width: number,
    readonly height: number,
  ) {}

  contains(x: number, y: number) {
    return (
      x >= this.x &&
      x <= this.x + this.width &&
      y >= this.y &&
      y <= this.y + this.height
    );
  }
}

class FakeContainer {
  cursor = "default";
  eventMode = "none";
  hitArea: unknown;
  readonly children: unknown[] = [];
  private readonly handlers = new Map<string, (event: unknown) => void>();

  addChild(...children: unknown[]) {
    this.children.push(...children);
  }

  on(eventName: string, handler: (event: unknown) => void) {
    this.handlers.set(eventName, handler);
  }

  emit(eventName: string, event: unknown) {
    this.handlers.get(eventName)?.(event);
  }
}

function createPointerEvent(
  display: FakeContainer,
  x: number,
  y: number,
  options: Record<string, unknown> = {},
) {
  return {
    ...options,
    getLocalPosition(container: FakeContainer) {
      expect(container).toBe(display);
      return { x, y };
    },
  };
}

function createTimeline(
  activeFrame: DetectionFrame | (() => DetectionFrame | undefined),
): BufferedDetectionTimeline {
  const getActiveFrame =
    typeof activeFrame === "function" ? activeFrame : () => activeFrame;

  return {
    destroy() {},
    getBufferedFrames: () => {
      const bufferedFrame = getActiveFrame();
      return bufferedFrame ? [bufferedFrame] : [];
    },
    getState: () => {
      const bufferedFrame = getActiveFrame();
      return {
        bufferEndTime: bufferedFrame?.endTime ?? bufferedFrame?.mediaTime ?? 0,
        bufferStartTime: bufferedFrame?.mediaTime ?? 0,
        detectionCount: bufferedFrame?.detections.length ?? 0,
        errorMessage: null,
        frameCount: bufferedFrame ? 1 : 0,
        requestedEndTime:
          bufferedFrame?.endTime ?? bufferedFrame?.mediaTime ?? 0,
        requestedStartTime: bufferedFrame?.mediaTime ?? 0,
        status: "ready",
      };
    },
    prepare: async () => undefined,
    prefetch() {},
    selectFrame: () => getActiveFrame(),
  } as unknown as BufferedDetectionTimeline;
}

function cloneDetectionFrame(sourceFrame: DetectionFrame): DetectionFrame {
  return {
    ...sourceFrame,
    detections: sourceFrame.detections.map((detection) => ({ ...detection })),
  };
}

function createPressHarness(
  disposition:
    | "handled"
    | "continue"
    | NonNullable<MediaInteractionOptions["onPointerPress"]>,
) {
  const pressFrame: DetectionFrame = {
    mediaTime: 0,
    detections: [
      { id: "a", rect: { x: 40, y: 40, width: 40, height: 40 } },
      { id: "b", rect: { x: 80, y: 70, width: 50, height: 40 } },
      {
        id: "locked",
        locked: true,
        rect: { x: 140, y: 40, width: 30, height: 30 },
      },
      {
        id: "mask",
        rect: { x: 200, y: 20, width: 20, height: 20 },
        mask: encodeBinaryMask(new Uint8Array([1]), 1, 1),
      },
      { id: "under-label", rect: { x: 100, y: 110, width: 40, height: 40 } },
      {
        id: "polygon",
        polygon: {
          points: [
            { x: 160, y: 90 },
            { x: 190, y: 90 },
            { x: 190, y: 120 },
            { x: 160, y: 120 },
          ],
        },
      },
      {
        id: "pose",
        keypoints: {
          points: [
            { x: 40, y: 130 },
            { x: 70, y: 130 },
          ],
          edges: [[0, 1]],
        },
      },
    ],
  };
  const capture = vi.fn();
  const onCommit = vi.fn();
  const onSelectionChange = vi.fn();
  const engine = createAnnotationEditingEngine({ onCommit });
  let selectionAtPress: (string | number | undefined)[] = [];
  const onPointerPress = vi.fn<
    NonNullable<MediaInteractionOptions["onPointerPress"]>
  >((press) => {
    selectionAtPress = layer
      .getState()
      .selectedPicks.map((pick) => pick.detection.id);
    return typeof disposition === "function" ? disposition(press) : disposition;
  });
  const layer = createPixiInteractionLayer({
    Container,
    Rectangle,
    canInteract: () => true,
    detectionTimeline: createTimeline(pressFrame),
    editingEngine: engine,
    capturePointer: capture,
    interaction: {
      mode: MediaInteractionMode.Always,
      multiSelect: true,
      preferTopmost: true,
      onPointerPress,
      onSelectionChange,
    },
    pickLabelDetectionAtPoint: (point) =>
      point.x === 100 && point.y === 110
        ? {
            detection: pressFrame.detections[0]!,
            detectionIndex: 0,
            frame: pressFrame,
            mediaTime: 0,
            point,
            target: DetectionPickTarget.Label,
          }
        : null,
    pickMaskDetectionAtPoint: (point) =>
      point.x === 200 && point.y === 20
        ? {
            detection: pressFrame.detections[3]!,
            detectionIndex: 3,
            frame: pressFrame,
            mediaTime: 0,
            point,
            target: DetectionPickTarget.Mask,
          }
        : null,
  });
  const display = layer.createDisplay({ width: 240, height: 200 }) as Container;
  const boundary = new EventBoundary(display);
  layer.drawFrame(0);
  return {
    layer,
    engine,
    capture,
    onCommit,
    onPointerPress,
    onSelectionChange,
    get selectionAtPress() {
      return selectionAtPress;
    },
    send(
      type: string,
      x: number,
      y: number,
      options: {
        pointerId?: number;
        button?: number;
        buttons?: number;
        shiftKey?: boolean;
        altKey?: boolean;
        ctrlKey?: boolean;
        metaKey?: boolean;
      } = {},
    ) {
      const event = new FederatedPointerEvent(boundary);
      event.type = type;
      event.pointerType = "mouse";
      event.pointerId = options.pointerId ?? 7;
      event.button = options.button ?? 0;
      event.buttons = options.buttons ?? (type === "pointerup" ? 0 : 1);
      event.shiftKey = options.shiftKey ?? false;
      event.altKey = options.altKey ?? false;
      event.ctrlKey = options.ctrlKey ?? false;
      event.metaKey = options.metaKey ?? false;
      event.timeStamp = 500;
      event.global.set(x, y);
      boundary.mapEvent(event);
    },
  };
}

function createDefaultPressHarness(customEngine?: AnnotationEditingEngine) {
  const engine = customEngine ?? createAnnotationEditingEngine();
  const capture = vi.fn();
  const release = vi.fn();
  const onStateChange = vi.fn();
  const layer = createPixiInteractionLayer({
    Container: FakeContainer as never,
    Rectangle: FakeRectangle as never,
    canInteract: () => true,
    detectionTimeline: createTimeline(frame),
    editingEngine: engine,
    interaction: { mode: MediaInteractionMode.Always, multiSelect: true },
    capturePointer: capture,
    releasePointer: release,
    onStateChange,
  });
  const display = layer.createDisplay({
    width: 120,
    height: 80,
  }) as FakeContainer;
  layer.drawFrame(0.1);
  return {
    engine,
    capture,
    release,
    layer,
    onStateChange,
    send(type: string, pointerId: number, x: number, y: number, timeStamp = 0) {
      display.emit(
        type,
        createPointerEvent(display, x, y, { pointerId, timeStamp, button: 0 }),
      );
    },
  };
}
