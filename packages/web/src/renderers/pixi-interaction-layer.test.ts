import { describe, expect, it, vi } from "vitest";

import { createPixiInteractionLayer } from "#renderers/pixi-interaction-layer";
import {
  AnnotationGestureStateKind,
  createAnnotationEditingEngine,
  DetectionPickTarget,
  MediaInteractionMode,
} from "supervision-js-core";
import type { BufferedDetectionTimeline } from "supervision-js-core";
import type { DetectionFrame } from "supervision-js-core";

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
      selectedPick: null,
    });
    expect(onHover).toHaveBeenLastCalledWith(null);
    expect(onSelect).toHaveBeenLastCalledWith(null);
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

  it("prefers exact mask picks before falling back to box picks", () => {
    const onHover = vi.fn();
    const maskPick = {
      detection: frame.detections[0],
      detectionIndex: 0,
      frame,
      mediaTime: frame.mediaTime,
      point: { x: 15, y: 20 },
      target: DetectionPickTarget.Mask,
    };
    const pickMaskDetectionAtPoint = vi.fn(() => maskPick);
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

    expect(pickMaskDetectionAtPoint).toHaveBeenCalledWith(
      { x: 15, y: 20 },
      0.1,
    );
    expect(onHover).toHaveBeenLastCalledWith(maskPick);
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
  activeFrame: DetectionFrame | (() => DetectionFrame),
): BufferedDetectionTimeline {
  const getActiveFrame =
    typeof activeFrame === "function" ? activeFrame : () => activeFrame;

  return {
    destroy() {},
    getBufferedFrames: () => [getActiveFrame()],
    getState: () => ({
      bufferEndTime: getActiveFrame().endTime ?? getActiveFrame().mediaTime,
      bufferStartTime: getActiveFrame().mediaTime,
      detectionCount: getActiveFrame().detections.length,
      errorMessage: null,
      frameCount: 1,
      requestedEndTime: getActiveFrame().endTime ?? getActiveFrame().mediaTime,
      requestedStartTime: getActiveFrame().mediaTime,
      status: "ready",
    }),
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
