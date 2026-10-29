import { describe, expect, it, vi } from "vitest";

import {
  AnnotationGestureStateKind,
  AnnotationGeometryKind,
  BaseBoxStyle,
  BaseBoxCornerStyle,
  BaseKeypointStyle,
  BaseMarkerStyle,
  BaseOrientedBoxStyle,
  BasePercentageBarStyle,
  BasePolygonStyle,
  BoxShape,
  DetectionMaskEncoding,
  createAnnotationEditingEngine,
  createOrientedBoxGeometry,
  getOrientedRectangleGeometry,
  MarkerSizeSpace,
  MediaInteractionMode,
  type AnnotationEditingEngine,
  type AnnotationEditingState,
  type Detection,
  type EllipseStyle,
  type Point,
  type Rect,
} from "supervision-js-core";

import {
  createRenderer,
  domMock,
  flushPixiTicker,
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
  it("updates stationary rotation on modifier press/release and cleans up window ownership", async () => {
    resetMocks();
    const subject: Detection = {
      id: "rotate",
      orientedBox: createOrientedBoxGeometry({
        x: 200,
        y: 150,
        width: 80,
        height: 40,
      }),
    };
    const onCommit = vi.fn();
    const engine = createAnnotationEditingEngine({
      onCommit,
      resolveRotation: (angle, { input }) =>
        input.shiftKey
          ? Math.round(angle / (Math.PI / 4)) * (Math.PI / 4)
          : angle,
    });
    const renderer = await createRenderer(false, false, {
      editingEngine: engine,
      orientedBoxStyle: new BaseOrientedBoxStyle(),
      detectionFrames: [{ detections: [subject], mediaTime: 0 }],
    });
    await renderer.refresh();
    renderer.setSelectedDetection({ detectionId: subject.id! });
    renderer.setViewportTransform({ scale: 1, x: 0, y: 0 });
    const rotate = engine
      .getHandles(subject)
      .find((h) => h.id === "obb-rotate")!;
    sendInteractionPointer("pointerdown", 7, rotate.point);
    sendInteractionPointer("globalpointermove", 7, { x: 230, y: 120 }, 100);
    const raw = engine.getState().preview!;
    const keydown = domMock.windowAddEventListener.mock.calls.find(
      ([name]) => name === "keydown",
    )![1] as (event: unknown) => void;
    const keyup = domMock.windowAddEventListener.mock.calls.find(
      ([name]) => name === "keyup",
    )![1] as (event: unknown) => void;
    const preventDefault = vi.fn();
    keydown({ key: "Shift", shiftKey: true, preventDefault });
    expect(
      getOrientedRectangleGeometry(engine.getState().preview!.orientedBox!)!
        .rotation,
    ).toBeCloseTo(Math.PI / 4);
    keyup({ key: "Shift", shiftKey: false, preventDefault });
    expect(engine.getState().preview).toEqual(raw);
    expect(onCommit).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
    const blur = domMock.windowAddEventListener.mock.calls.find(
      ([name]) => name === "blur",
    )![1] as () => void;
    blur();
    expect(engine.getState().kind).toBe(AnnotationGestureStateKind.Idle);
    expect(onCommit).not.toHaveBeenCalled();
    renderer.destroy();
    for (const name of ["keydown", "keyup", "blur"]) {
      const listener = domMock.windowAddEventListener.mock.calls.find(
        ([event]) => event === name,
      )![1];
      expect(domMock.windowRemoveEventListener).toHaveBeenCalledWith(
        name,
        listener,
      );
    }
  });

  it("keeps the editing canvas stable while edge handles rotate, pan and zoom within its visible crop", async () => {
    resetMocks();
    const subject = {
      id: "edge-box",
      orientedBox: createOrientedBoxGeometry(
        { x: 200, y: 20, width: 80, height: 40 },
        0,
      ),
    } satisfies Detection;
    const engine = createAnnotationEditingEngine({
      rotationHandle: { offset: 40 },
    });
    const initialWindow = window;
    const initialResizeObserver = globalThis.ResizeObserver;
    let resized = () => {};
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resized = callback;
        }
        disconnect = vi.fn();
        observe = vi.fn();
      },
    );
    const container = {
      appendChild: domMock.appendChild,
      clientWidth: 640,
      clientHeight: 480,
    };
    const renderer = await createRenderer(false, false, {
      container,
      editingEngine: engine,
      orientedBoxStyle: new BaseOrientedBoxStyle(),
      detectionFrames: [{ detections: [subject], mediaTime: 0 }],
    });
    try {
      await renderer.refresh();
      expect(pixiMock.rendererResize).toHaveBeenLastCalledWith(640, 360, 1);
      expect(
        renderer.setSelectedDetection({ detectionId: subject.id }),
      ).not.toBeNull();
      expect(pixiMock.rendererResize).toHaveBeenLastCalledWith(640, 480, 1);
      pixiMock.rendererResize.mockClear();
      const canvas = pixiMock.canvasInstances[0]!;
      const hitDisplay = pixiMock.containerInstances.find((display) =>
        display.on.mock.calls.some(([name]) => name === "pointerdown"),
      )!;
      for (const scale of [0.5, 0.25]) {
        renderer.setViewportTransform({ scale, x: 0, y: 60 });
        flushPixiTicker(0);
        const rotate = engine
          .getHandles(subject, scale)
          .find((handle) => handle.id === "obb-rotate")!;
        expect(rotate.point).toEqual({ x: 200, y: -40 / scale });
        const hitArea = hitDisplay.hitArea as {
          contains(x: number, y: number): boolean;
        };
        expect(hitArea.contains(rotate.point.x, rotate.point.y)).toBe(true);
        // The visible crop still reaches the handle's full hit area, while the
        // backing dimensions stay host-sized and retain the old crop origin.
        expect(canvas.style.left).toBe("0px");
        expect(canvas.style.top).toBe("10px");
        expect(canvas.style.clipPath).toBe(
          scale === 0.5
            ? "inset(0px 0px 70px 0px)"
            : "inset(0px 320px 250px 0px)",
        );
        expect(
          renderer.screenToMedia(renderer.mediaToScreen(rotate.point)),
        ).toEqual(rotate.point);
        expect(
          pixiMock.graphicsInstances.some((graphics) =>
            graphics.circle.mock.calls.some(
              ([x, y]) => x === rotate.point.x && y === rotate.point.y,
            ),
          ),
        ).toBe(true);
        sendInteractionPointer("pointerdown", 7, rotate.point);
        expect(engine.getState().kind).toBe(
          AnnotationGestureStateKind.Rotating,
        );
        for (let step = 1; step <= 24; step += 1) {
          const angle = (step * Math.PI) / 12;
          sendInteractionPointer("globalpointermove", 7, {
            x: 200 + Math.sin(angle) * 100,
            y: 20 - Math.cos(angle) * 100,
          });
          const preview = engine.getState().preview!;
          const previewRotate = engine
            .getHandles(preview, scale)
            .find((handle) => handle.id === "obb-rotate")!;
          expect(
            (
              hitDisplay.hitArea as { contains(x: number, y: number): boolean }
            ).contains(previewRotate.point.x, previewRotate.point.y),
          ).toBe(true);
        }
        engine.cancel();
        for (let step = 0; step < 8; step += 1) {
          renderer.panViewportBy(5, -3);
          renderer.zoomViewportAt({ x: 320, y: 240 }, 1.03);
          flushPixiTicker(0);
        }
        flushPixiTicker(0);
      }
      expect(pixiMock.rendererResize).not.toHaveBeenCalled();
      container.clientWidth = 800;
      container.clientHeight = 600;
      resized();
      expect(pixiMock.rendererResize).toHaveBeenLastCalledWith(800, 600, 1);
      vi.stubGlobal("window", { ...window, devicePixelRatio: 2 });
      renderer.setRenderQuality({ maxDevicePixelRatio: 2 });
      expect(pixiMock.rendererResize).toHaveBeenLastCalledWith(800, 600, 2);
      container.clientWidth = 801;
      container.clientHeight = 601;
      resized();
      renderer.setRenderQuality({ maxDevicePixelRatio: 1.25 });
      expect(pixiMock.rendererResize).toHaveBeenLastCalledWith(801, 601, 1.25);
      expect(canvas).toHaveProperty("width", 1001);
      expect(canvas).toHaveProperty("height", 751);
      renderer.setViewportTransform({ scale: 0.25, x: 1, y: 61 });
      flushPixiTicker(0);
      expect(canvas.style).toMatchObject({ left: "1px", top: "11px" });
      pixiMock.rendererResize.mockClear();
      for (let step = 0; step < 8; step += 1) {
        renderer.panViewportBy(5, -3);
        renderer.zoomViewportAt({ x: 320, y: 240 }, 1.03);
        flushPixiTicker(0);
      }
      expect(pixiMock.rendererResize).not.toHaveBeenCalled();
      renderer.setRenderQuality({ maxDevicePixelRatio: 2 });
      renderer.setViewportTransform({ scale: 0.25, x: 0, y: 60 });
      flushPixiTicker(0);
      renderer.setSelectedDetection(null);
      expect(
        (
          hitDisplay.hitArea as { contains(x: number, y: number): boolean }
        ).contains(200, -24),
      ).toBe(false);
      expect(canvas.style.top).toBe("60px");
      expect(canvas.style.clipPath).toBe("");
      expect(pixiMock.rendererResize).toHaveBeenLastCalledWith(320, 180, 2);
    } finally {
      renderer.destroy();
      vi.stubGlobal("window", initialWindow);
      vi.stubGlobal("ResizeObserver", initialResizeObserver);
    }
  });

  it.each(["external preview", "locked", "mask", "unsupported clip"])(
    "retains the picture-sized canvas for %s selections",
    async (kind) => {
      resetMocks();
      const createElement = domMock.createElement.getMockImplementation()!;
      if (kind === "unsupported clip") {
        domMock.createElement.mockImplementation((tag: string) => {
          const element = createElement(tag);
          if (tag === "div") {
            let overflow = "";
            Object.defineProperty(element.style, "overflow", {
              get: () => overflow,
              set: (value: string) => {
                if (value !== "clip") overflow = value;
              },
            });
          }
          return element;
        });
      }
      const subject: Detection = {
        ...SUBJECT,
        locked: kind === "locked",
        ...(kind === "mask"
          ? {
              mask: {
                counts: "0",
                encoding: DetectionMaskEncoding.CompressedRle,
                height: 1,
                width: 1,
              },
            }
          : {}),
      };
      const container = {
        appendChild: domMock.appendChild,
        clientWidth: 640,
        clientHeight: 480,
      };
      const renderer = await createRenderer(false, false, {
        container,
        editingEngine:
          kind === "external preview"
            ? undefined
            : createAnnotationEditingEngine(),
        interaction: { mode: MediaInteractionMode.Always },
        previewOverlay: () => ({ points: [{ x: 100, y: 90, positive: true }] }),
        detectionFrames: [{ detections: [subject], mediaTime: 0 }],
      });
      try {
        await renderer.refresh();
        if (kind === "unsupported clip") {
          const backdrop = domMock.appendChild.mock.calls.find(
            (_, index) =>
              domMock.appendChild.mock.contexts[index] === container,
          )![0];
          expect(backdrop.style.overflow).toBe("hidden");
        }
        pixiMock.rendererResize.mockClear();
        expect(
          renderer.setSelectedDetection({ detectionId: subject.id! }),
        ).not.toBeNull();
        expect(pixiMock.rendererResize).not.toHaveBeenCalled();
        expect(pixiMock.canvasInstances[0]!.style).toMatchObject({
          clipPath: "",
          left: "0px",
          top: "60px",
        });
      } finally {
        renderer.destroy();
        domMock.createElement.mockImplementation(createElement);
      }
    },
  );

  it("retains the canvas keyboard target and theme outline across cropped focus and modality changes", async () => {
    resetMocks();
    const initialDocument = document;
    const initialWindow = window;
    const renderer = await createRenderer(false, false, {
      container: {
        appendChild: domMock.appendChild,
        clientWidth: 640,
        clientHeight: 480,
      },
      editingEngine: createAnnotationEditingEngine(),
      detectionFrames: [{ detections: [SUBJECT], mediaTime: 0 }],
    });
    try {
      await renderer.refresh();
      renderer.setSelectedDetection({ detectionId: SUBJECT.id! });
      renderer.setViewportTransform({ scale: 0.25, x: 0, y: 60 });
      const canvas = pixiMock.canvasInstances[0]!;
      const matches = vi.fn(() => true);
      Object.defineProperty(canvas, "matches", { value: matches });
      const getComputedStyle = vi.fn(() => ({
        outline: "rgb(27, 72, 90) dashed 3px",
        outlineOffset: "2px",
      }));
      vi.stubGlobal("window", { ...window, getComputedStyle });
      vi.stubGlobal("document", { ...document, activeElement: canvas });
      const outline = domMock.createElement.mock.results.find(
        ({ value }) => value.ariaHidden === "true",
      )!.value;
      const send = (type: string, event?: unknown) => {
        const listeners =
          type === "pointerdown"
            ? domMock.windowAddEventListener
            : pixiMock.canvasAddEventListener;
        const listener = listeners.mock.calls.find(
          ([name]) => name === type,
        )![1] as (event?: unknown) => void;
        listener(event);
      };
      send("focus");
      expect(canvas.tabIndex).toBe(0);
      expect(outline.tabIndex).toBeUndefined();
      expect(outline.style).toMatchObject({
        display: "block",
        pointerEvents: "none",
        left: "0px",
        top: "60px",
        width: "320px",
        height: "180px",
        outline: "rgb(27, 72, 90) dashed 3px",
        outlineOffset: "2px",
      });
      renderer.panViewportBy(10, 5);
      flushPixiTicker(0);
      expect(outline.style).toMatchObject({ left: "10px", top: "65px" });
      expect(getComputedStyle).toHaveBeenCalledOnce();
      matches.mockReturnValue(false);
      send("pointerdown");
      await Promise.resolve();
      expect(outline.style.display).toBe("none");
      matches.mockReturnValue(true);
      send("keydown", { key: "Escape" });
      expect(outline.style.display).toBe("block");
      const shadowHost = document.createElement("div");
      vi.stubGlobal("document", { ...document, activeElement: shadowHost });
      send("focus");
      expect(outline.style.display).toBe("block");
      matches.mockReturnValue(false);
      vi.stubGlobal("document", { ...document, activeElement: null });
      send("blur");
      expect(outline.style.display).toBe("none");
      matches.mockReturnValue(true);
      vi.stubGlobal("document", { ...document, activeElement: canvas });
      send("focus");
      renderer.setSelectedDetection(null);
      expect(outline.style.display).toBe("none");
      expect(canvas.style.clipPath).toBe("");
      expect(canvas.style.outline).toBeUndefined();
    } finally {
      renderer.destroy();
      vi.stubGlobal("document", initialDocument);
      vi.stubGlobal("window", initialWindow);
    }
    for (const type of ["focus", "blur"]) {
      const listener = pixiMock.canvasAddEventListener.mock.calls.find(
        ([name]) => name === type,
      )![1];
      expect(pixiMock.canvasRemoveEventListener).toHaveBeenCalledWith(
        type,
        listener,
      );
    }
    const pointerDown = domMock.windowAddEventListener.mock.calls.find(
      ([name]) => name === "pointerdown",
    )![1];
    expect(domMock.windowRemoveEventListener).toHaveBeenCalledWith(
      "pointerdown",
      pointerDown,
      true,
    );
  });

  it.each(["pointercancel", "lostpointercapture"])(
    "retains routed polygon vertices after native %s and accepts the next contact",
    async (eventType) => {
      resetMocks();
      const onCommit = vi.fn();
      const releasePointer = vi.fn();
      const engine = createAnnotationEditingEngine({
        onCommit,
        releasePointer,
      });
      const interrupt = vi.spyOn(engine, "pointerCancel");
      engine.setCreationTool({
        geometry: AnnotationGeometryKind.Polygon,
        createDetection: (points) => ({
          polygon: { points: points as Point[] },
        }),
      });
      const renderer = await createRenderer(false, false, {
        editingEngine: engine,
      });
      const listeners =
        eventType === "pointercancel"
          ? domMock.windowAddEventListener
          : pixiMock.canvasAddEventListener;
      const cancel = listeners.mock.calls.find(
        ([type]) => type === eventType,
      )?.[1] as ((event: PointerEvent) => void) | undefined;
      expect(cancel).toBeTypeOf("function");

      sendInteractionPointer("pointerdown", 7, { x: 10, y: 20 });
      const ownerState = engine.getState();
      cancel!({ pointerId: 8 } as PointerEvent);
      expect(engine.getState()).toEqual(ownerState);
      cancel!({ pointerId: 7 } as PointerEvent);
      expect(engine.getState()).toMatchObject({
        kind: AnnotationGestureStateKind.Creating,
        pointerId: null,
        preview: {
          polygon: {
            points: [
              { x: 10, y: 20 },
              { x: 10, y: 20 },
            ],
          },
        },
      });
      expect(releasePointer).toHaveBeenCalledExactlyOnceWith(7);
      expect(onCommit).not.toHaveBeenCalled();

      interrupt.mockClear();
      if (eventType === "lostpointercapture") {
        cancel!({ pointerId: 7 } as PointerEvent);
        expect(interrupt).not.toHaveBeenCalled();
      }
      sendInteractionPointer("pointerdown", 8, { x: 60, y: 20 }, 300);
      sendInteractionPointer("pointerup", 8, { x: 60, y: 20 }, 301);
      sendInteractionPointer("pointerdown", 9, { x: 60, y: 80 }, 600);
      engine.keyDown("Enter");
      expect(onCommit).toHaveBeenCalledExactlyOnceWith(
        {
          polygon: {
            points: [
              { x: 10, y: 20 },
              { x: 60, y: 20 },
              { x: 60, y: 80 },
            ],
          },
        },
        null,
      );
      renderer.destroy();
      if (eventType === "pointercancel")
        expect(domMock.windowRemoveEventListener).toHaveBeenCalledWith(
          eventType,
          cancel,
          true,
        );
      else
        expect(pixiMock.canvasRemoveEventListener).toHaveBeenCalledWith(
          eventType,
          cancel,
        );
    },
  );

  it("commits when pointerup arrives in a later task after released capture", async () => {
    resetMocks();
    const onCommit = vi.fn();
    const engine = createAnnotationEditingEngine({ onCommit });
    engine.setCreationTool({
      geometry: AnnotationGeometryKind.Box,
      createDetection: (rect) => ({ rect: rect as Rect }),
    });
    const renderer = await createRenderer(false, false, {
      editingEngine: engine,
    });
    const lost = pixiMock.canvasAddEventListener.mock.calls.find(
      ([type]) => type === "lostpointercapture",
    )![1] as (event: PointerEvent) => void;
    sendInteractionPointer("pointerdown", 7, { x: 10, y: 20 });
    sendInteractionPointer("globalpointermove", 7, { x: 60, y: 80 });
    lost({ pointerId: 7, buttons: 0 } as PointerEvent);
    expect(engine.getState().kind).toBe(AnnotationGestureStateKind.Creating);
    await new Promise<void>((resolve) => setTimeout(resolve, 7));
    expect(engine.getState().kind).toBe(AnnotationGestureStateKind.Creating);
    sendInteractionPointer("pointerup", 7, { x: 60, y: 80 });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(
      { rect: { x: 35, y: 50, width: 50, height: 60 } },
      null,
    );
    renderer.destroy();
  });

  it.each(["creating", "moving"])(
    "replaces an abandoned %s gesture on the next press after released capture",
    async (kind) => {
      resetMocks();
      const onCommit = vi.fn();
      const engine = createAnnotationEditingEngine({ onCommit });
      if (kind === "creating") {
        engine.setCreationTool({
          geometry: AnnotationGeometryKind.Box,
          createDetection: (rect) => ({ rect: rect as Rect }),
        });
      }
      const renderer = await createRenderer(false, false, {
        editingEngine: engine,
        detectionFrames: [
          { detections: [SUBJECT], frameIndex: 0, mediaTime: 0 },
        ],
      });
      await vi.waitFor(() =>
        expect(renderer.getState().activeDetectionCount).toBe(1),
      );
      const lost = pixiMock.canvasAddEventListener.mock.calls.find(
        ([type]) => type === "lostpointercapture",
      )![1] as (event: PointerEvent) => void;
      sendInteractionPointer("pointerdown", 7, { x: 100, y: 90 });
      sendInteractionPointer("globalpointermove", 7, { x: 110, y: 100 });
      lost({ pointerId: 7, buttons: 0 } as PointerEvent);
      expect(engine.getState().kind).toBe(kind);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(engine.getState().kind).toBe(kind);
      expect(onCommit).not.toHaveBeenCalled();
      sendInteractionPointer("pointerdown", 8, { x: 100, y: 90 });
      sendInteractionPointer("globalpointermove", 8, { x: 110, y: 100 });
      sendInteractionPointer("pointerup", 8, { x: 110, y: 100 }, 300);
      expect(onCommit).toHaveBeenCalledTimes(1);
      renderer.destroy();
    },
  );

  it("retires a routed press through the native pointer-up fallback and removes its listener", async () => {
    resetMocks();
    const onCommit = vi.fn();
    const engine = createAnnotationEditingEngine({ onCommit });
    engine.setCreationTool({
      geometry: AnnotationGeometryKind.Box,
      createDetection: (rect) => ({ rect: rect as Rect }),
    });
    const renderer = await createRenderer(false, false, {
      editingEngine: engine,
    });
    const pointerUp = domMock.windowAddEventListener.mock.calls.find(
      ([type]) => type === "pointerup",
    )?.[1] as (event: PointerEvent) => void;
    expect(domMock.windowAddEventListener).toHaveBeenCalledWith(
      "pointerup",
      expect.any(Function),
      true,
    );
    sendInteractionPointer("pointerdown", 7, { x: 10, y: 20 });
    expect(engine.getState().pointerId).toBe(7);
    pointerUp({ pointerId: 7 } as PointerEvent);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(engine.getState().kind).toBe(AnnotationGestureStateKind.Idle);
    expect(onCommit).not.toHaveBeenCalled();
    renderer.destroy();
    expect(domMock.windowRemoveEventListener).toHaveBeenCalledWith(
      "pointerup",
      pointerUp,
      true,
    );
  });

  it("retires a handled press cancelled on its capture host and completes the next edit", async () => {
    resetMocks();
    const windowEvents = new EventTarget();
    domMock.windowAddEventListener.mockImplementation(
      (...args: Parameters<EventTarget["addEventListener"]>) =>
        windowEvents.addEventListener(...args),
    );
    domMock.windowRemoveEventListener.mockImplementation(
      (...args: Parameters<EventTarget["removeEventListener"]>) =>
        windowEvents.removeEventListener(...args),
    );
    const onCommit = vi.fn();
    const engine = createAnnotationEditingEngine({ onCommit });
    engine.setCreationTool({
      geometry: AnnotationGeometryKind.Polyline,
      createDetection: (points) => ({
        polyline: { points: points as readonly Point[] },
      }),
    });
    engine.pointerDown({ point: { x: 10, y: 20 }, timestamp: 0, pointerId: 7 });
    const draft = engine.getState();
    const onPointerPress = vi.fn((): "handled" | "continue" => "handled");
    const renderer = await createRenderer(false, false, {
      editingEngine: engine,
      interaction: { onPointerPress },
    });
    const display = pixiMock.containerInstances.find((container) =>
      container.on.mock.calls.some(([type]) => type === "pointerdown"),
    )!;
    const send = (
      type: string,
      point: Point,
      pointerId = 7,
      timeStamp = 500,
    ) => {
      const handler = display.on.mock.calls.find(
        ([name]) => name === type,
      )![1] as (event: unknown) => void;
      handler({
        pointerId,
        timeStamp,
        button: 0,
        getLocalPosition: () => point,
      });
    };
    const cancelListener = domMock.windowAddEventListener.mock.calls.find(
      ([type]) => type === "pointercancel",
    )?.[1];
    const captureLost = pixiMock.canvasAddEventListener.mock.calls.find(
      ([type]) => type === "lostpointercapture",
    )?.[1] as (event: { pointerId: number }) => void;
    try {
      send("pointerdown", { x: 50, y: 60 });
      captureLost({ pointerId: 7 });
      send("globalpointermove", { x: 70, y: 80 });
      expect(engine.getState()).toEqual(draft);

      const captureHost = new EventTarget();
      const cancel = (pointerId: number) => {
        const event = new Event("pointercancel");
        Object.defineProperties(event, {
          pointerId: { value: pointerId },
          target: { value: captureHost },
        });
        windowEvents.dispatchEvent(event);
        expect(event.target).toBe(captureHost);
      };
      cancel(8);
      send("globalpointermove", { x: 70, y: 80 });
      expect(engine.getState()).toEqual(draft);
      cancel(7);
      send("globalpointermove", { x: 70, y: 80 });
      expect(engine.getState().preview?.polyline?.points).toEqual([
        { x: 10, y: 20 },
        { x: 70, y: 80 },
      ]);

      engine.setCreationTool({
        geometry: AnnotationGeometryKind.Box,
        createDetection: (rect) => ({ rect: rect as Rect }),
      });
      onPointerPress.mockReturnValue("continue");
      send("pointerdown", { x: 10, y: 20 }, 8, 0);
      send("globalpointermove", { x: 80, y: 90 }, 8, 300);
      send("pointerup", { x: 80, y: 90 }, 8, 400);
      expect(engine.getState().kind).toBe(AnnotationGestureStateKind.Idle);
      expect(onCommit).toHaveBeenCalledExactlyOnceWith(
        { rect: { x: 45, y: 55, width: 70, height: 70 } },
        null,
      );
      expect(domMock.windowAddEventListener).toHaveBeenCalledWith(
        "pointercancel",
        expect.any(Function),
        true,
      );
      expect(
        pixiMock.canvasAddEventListener.mock.calls.some(
          ([type]) => type === "lostpointercapture",
        ),
      ).toBe(true);
    } finally {
      renderer.destroy();
    }
    expect(domMock.windowRemoveEventListener).toHaveBeenCalledWith(
      "pointercancel",
      cancelListener,
      true,
    );
  });

  it.each([
    [0, 1, [0x0000ff, 0xff0000]],
    [1, 0, [0xff0000, 0x0000ff]],
    [undefined, undefined, [0xff0000, 0x0000ff]],
    [4, 4, [0xff0000, 0x0000ff]],
    [-1.5, -0.25, [0x0000ff, 0xff0000]],
  ] as const)(
    "composes mixed retained geometry by detection order (%s, %s)",
    async (polygonZ, boxZ, expected) => {
      resetMocks();
      const editing = createEditingEngineHarness();
      const renderer = await createRenderer(false, false, {
        boxStyle: new BaseBoxStyle({
          fill: { alpha: 1, color: 0xff0000 },
          shouldRender: (detection) => !detection.polygon,
        }),
        polygonStyle: new BasePolygonStyle({
          fill: { alpha: 1, color: 0x0000ff },
        }),
        detectionFrames: [
          {
            detections: [
              { ...SUBJECT, zIndex: boxZ },
              {
                id: "polygon",
                zIndex: polygonZ,
                polygon: {
                  points: [
                    { x: 0, y: 0 },
                    { x: 200, y: 0 },
                    { x: 200, y: 200 },
                    { x: 0, y: 200 },
                  ],
                },
              },
            ],
            frameIndex: 0,
            mediaTime: 0,
          },
        ],
        editingEngine: editing.engine,
      });
      await vi.waitFor(() =>
        expect(renderer.getState().activeDetectionCount).toBe(1),
      );
      expect(visibleFillColors()).toEqual(expected);
      renderer.destroy();
    },
  );

  it("keeps a skeleton's keypoints above its box when the box appears later", async () => {
    resetMocks();
    const keypointStyle = new BaseKeypointStyle({
      markerFill: { alpha: 1, color: 0x0000ff },
    });
    const renderer = await createRenderer(false, false, {
      labelStyle: null,
      boxStyle: null,
      keypointStyle,
      editingEngine: createEditingEngineHarness().engine,
      detectionFrames: [
        {
          detections: [
            {
              ...SUBJECT,
              keypoints: {
                points: [
                  { x: 100, y: 90 },
                  { x: 110, y: 90 },
                ],
                edges: [[0, 1]],
              },
            },
          ],
          mediaTime: 0,
        },
      ],
    });
    await vi.waitFor(() => expect(visibleFillColors()).toEqual([0x0000ff]));
    renderer.setPresentation({
      keypointStyle,
      labelStyle: null,
      boxStyle: new BaseBoxStyle({ fill: { alpha: 1, color: 0xff0000 } }),
    });
    await vi.waitFor(() =>
      expect(renderer.getState().activeDetectionCount).toBe(1),
    );
    expect(visibleFillColors()).toEqual([0xff0000, 0x0000ff]);
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
      markerStyle: new BaseMarkerStyle({
        fill: { alpha: 1, color: 0x123456 },
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
    flushPixiTicker(0);
    const markerDisplays = pixiMock.graphicsInstances.filter((graphics) =>
      graphics.fill.mock.calls.some(([fill]) => fill.color === 0x123456),
    );
    expect(markerDisplays).toHaveLength(1);
    expect(markerDisplays[0]!.visible).toBe(true);

    renderer.destroy();
  });

  it.each([
    ["box", SUBJECT, AnnotationGestureStateKind.Moving],
    ["OBB and rect", OBB_SUBJECT, AnnotationGestureStateKind.Rotating],
    [
      "skeleton",
      {
        ...SUBJECT,
        keypoints: {
          points: [
            { x: 100, y: 90 },
            { x: 110, y: 90 },
          ],
          edges: [[0, 1]],
        },
      },
      AnnotationGestureStateKind.Resizing,
    ],
  ] satisfies [string, Detection, AnnotationGestureStateKind][])(
    "keeps composed decorations on a live %s preview without drawing the OBB twice",
    async (_label, subject, kind) => {
      resetMocks();
      const editing = createEditingEngineHarness();
      const markerStyle = new BaseMarkerStyle({
        fill: { alpha: 1, color: 0x123456 },
        size: 10,
        sizeSpace: MarkerSizeSpace.Media,
        stroke: null,
      });
      const ellipseStyle: EllipseStyle = {
        resolve: (detection, context) =>
          detection.rect && !context.hidden
            ? {
                center: detection.rect,
                radiusX: 4,
                radiusY: 3,
                fill: { alpha: 1, color: 0x234567 },
              }
            : undefined,
      };
      const renderer = await createRenderer(false, false, {
        detectionFrames: [
          { detections: [subject], frameIndex: 0, mediaTime: 0 },
        ],
        editingEngine: editing.engine,
        labelStyle: null,
        markerStyle,
        ellipseStyle,
        boxCornerStyle: new BaseBoxCornerStyle({
          stroke: { color: 0x56789a, width: 2 },
        }),
        percentageBarStyle: new BasePercentageBarStyle({
          value: 0.5,
          fill: { alpha: 1, color: 0x345678 },
        }),
        orientedBoxStyle: new BaseOrientedBoxStyle({
          fill: { alpha: 1, color: 0x6789ab },
        }),
        keypointStyle: new BaseKeypointStyle({
          markerFill: { alpha: 1, color: 0x789abc },
        }),
      });
      await renderer.refresh();
      const source = pixiMock.graphicsInstances.find((graphics) =>
        graphics.fill.mock.calls.some(([fill]) => fill.color === 0x123456),
      );
      expect(source).toBeDefined();
      const preview: Detection = {
        ...subject,
        rect: { ...subject.rect!, x: 140, y: 60 },
        ...(subject.orientedBox
          ? {
              orientedBox: createOrientedBoxGeometry(
                { x: 140, y: 60, width: 40, height: 20 },
                Math.PI / 4,
              ),
            }
          : {}),
      };
      editing.emitState({
        ...movingState(),
        kind,
        activeDetectionId: subject.id!,
        preview,
      });
      flushPixiTicker(0);

      expect(source!.visible).toBe(false);
      const overlay = pixiMock.graphicsInstances.find((graphics) =>
        graphics.circle.mock.calls.some(
          ([x, y, radius]) => x === 140 && y === 60 && radius === 5,
        ),
      );
      expect(overlay).toBeDefined();
      for (const color of [0x123456, 0x234567, 0x345678]) {
        expect(overlay!.fill).toHaveBeenCalledWith(
          expect.objectContaining({ color }),
        );
      }
      expect(overlay!.stroke).toHaveBeenCalledWith(
        expect.objectContaining({ color: 0x56789a }),
      );
      expect(overlay!.fill).not.toHaveBeenCalledWith(
        expect.objectContaining({ color: 0x6789ab }),
      );
      if (subject.keypoints) {
        expect(overlay!.fill).toHaveBeenCalledWith(
          expect.objectContaining({ color: 0x789abc }),
        );
      }
      if (preview.orientedBox) {
        expect(overlay!.poly).toHaveBeenCalledWith(
          preview.orientedBox.points.flatMap(({ x, y }) => [x, y]),
          true,
        );
      }

      overlay!.fill.mockClear();
      renderer.setPresentation({ markerStyle: null });
      flushPixiTicker(1);
      expect(overlay!.fill).not.toHaveBeenCalledWith(
        expect.objectContaining({ color: 0x123456 }),
      );
      expect(overlay!.fill).toHaveBeenCalledWith(
        expect.objectContaining({ color: 0x234567 }),
      );
      renderer.setPresentation({
        markerStyle: new BaseMarkerStyle({
          fill: { alpha: 1, color: 0xabcdef },
          stroke: null,
        }),
      });
      flushPixiTicker(2);
      expect(overlay!.fill).toHaveBeenCalledWith({ alpha: 1, color: 0xabcdef });

      overlay!.fill.mockClear();
      editing.emitState(idleState());
      flushPixiTicker(3);
      expect(source!.visible).toBe(true);
      expect(overlay!.fill).not.toHaveBeenCalled();
      renderer.destroy();
    },
  );

  it.each(["commit", "cancel"] as const)(
    "removes the rotating marker preview and restores its source after %s",
    async (finish) => {
      resetMocks();
      const subject: Detection = {
        className: OBB_SUBJECT.className,
        id: OBB_SUBJECT.id,
        orientedBox: OBB_SUBJECT.orientedBox,
      };
      const onCommit = vi.fn();
      const engine = createAnnotationEditingEngine({ onCommit });
      const renderer = await createRenderer(false, false, {
        detectionFrames: [{ detections: [subject], mediaTime: 0 }],
        editingEngine: engine,
        markerStyle: new BaseMarkerStyle({
          center: (detection) => detection.orientedBox?.points[0],
          fill: { alpha: 1, color: 0x123456 },
          size: 10,
          sizeSpace: MarkerSizeSpace.Media,
          stroke: null,
        }),
      });
      await renderer.refresh();
      const source = pixiMock.graphicsInstances.find((graphics) =>
        graphics.fill.mock.calls.some(([fill]) => fill.color === 0x123456),
      )!;
      const handle = engine
        .getHandles(subject)
        .find(({ id }) => id === "obb-rotate")!;
      engine.beginHandleDrag(subject, handle, {
        point: handle.point,
        pointerId: 7,
        timestamp: 0,
      });
      const input = { point: { x: 160, y: 100 }, pointerId: 7, timestamp: 100 };
      engine.pointerMove(input);
      flushPixiTicker(0);
      const corner = engine.getState().preview!.orientedBox!.points[0];
      expect(corner).not.toEqual(subject.orientedBox!.points[0]);
      const overlay = pixiMock.graphicsInstances.find((graphics) =>
        graphics.circle.mock.calls.some(
          ([x, y, radius]) => x === corner.x && y === corner.y && radius === 5,
        ),
      )!;
      expect(overlay).toBeDefined();
      expect(source.visible).toBe(false);

      overlay.fill.mockClear();
      renderer.setPresentation({
        visibility: { hiddenDetectionIds: [subject.id!] },
      });
      flushPixiTicker(1);
      expect(overlay.fill).not.toHaveBeenCalled();
      renderer.setPresentation({ visibility: {} });
      flushPixiTicker(2);
      expect(overlay.fill).toHaveBeenCalledWith({ alpha: 1, color: 0x123456 });

      overlay.circle.mockClear();
      overlay.fill.mockClear();
      if (finish === "commit") engine.pointerUp(input);
      else engine.cancel();
      flushPixiTicker(3);
      expect(engine.getState().kind).toBe(AnnotationGestureStateKind.Idle);
      expect(onCommit).toHaveBeenCalledTimes(finish === "commit" ? 1 : 0);
      expect(source.visible).toBe(true);
      expect(overlay.circle).not.toHaveBeenCalled();
      expect(overlay.fill).not.toHaveBeenCalled();
      renderer.destroy();
    },
  );

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

function sendInteractionPointer(
  eventType: "pointerdown" | "pointerup" | "globalpointermove",
  pointerId: number,
  point: Point,
  timeStamp = 0,
) {
  const handler = pixiMock.containerInstances
    .flatMap((container) => container.on.mock.calls)
    .find(([type]) => type === eventType)?.[1];
  expect(handler).toBeTypeOf("function");
  handler({ button: 0, getLocalPosition: () => point, pointerId, timeStamp });
}

function visibleFillColors(): number[] {
  type SceneDisplay = {
    children?: SceneDisplay[];
    sortableChildren?: boolean;
    zIndex?: number;
    visible?: boolean;
    fill?: ReturnType<typeof vi.fn>;
  };
  const fills: number[] = [];
  function collect(display: SceneDisplay) {
    if (display.visible === false) return;
    const fill = display.fill?.mock.calls.at(-1)?.[0];
    if (fill?.alpha === 1) fills.push(fill.color);
    const children = [...(display.children ?? [])];
    if (display.sortableChildren)
      children.sort((left, right) => (left.zIndex ?? 0) - (right.zIndex ?? 0));
    children.forEach(collect);
  }
  collect(pixiMock.stageAddChild.mock.calls.at(-1)![0]);
  return fills;
}

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
