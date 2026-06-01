import { describe, expect, it, vi } from "vitest";

import { createPixiInteractionLayer } from "#renderers/pixi-interaction-layer";
import { DetectionPickTarget, MediaInteractionMode } from "#types/interaction";
import type { BufferedDetectionTimeline } from "#types/detection-timeline";
import type { DetectionFrame } from "#types/detections";

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

describe("pixi interaction layer", () => {
  it("uses one media-sized hit surface and ignores picking while gated off", () => {
    const onHover = vi.fn();
    const onSelect = vi.fn();
    let canInteract = false;
    const layer = createPixiInteractionLayer({
      Container: FakeContainer as never,
      Graphics: FakeGraphics as never,
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
      Graphics: FakeGraphics as never,
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

class FakeGraphics {
  readonly fill = vi.fn(() => this);
  readonly clear = vi.fn(() => this);
  readonly rect = vi.fn(() => this);
  readonly stroke = vi.fn(() => this);
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

function createPointerEvent(display: FakeContainer, x: number, y: number) {
  return {
    getLocalPosition(container: FakeContainer) {
      expect(container).toBe(display);
      return { x, y };
    },
  };
}

function createTimeline(
  activeFrame: DetectionFrame,
): BufferedDetectionTimeline {
  return {
    destroy() {},
    getBufferedFrames: () => [activeFrame],
    getState: () => ({
      bufferEndTime: activeFrame.endTime ?? activeFrame.mediaTime,
      bufferStartTime: activeFrame.mediaTime,
      detectionCount: activeFrame.detections.length,
      errorMessage: null,
      frameCount: 1,
      requestedEndTime: activeFrame.endTime ?? activeFrame.mediaTime,
      requestedStartTime: activeFrame.mediaTime,
      status: "ready",
    }),
    prepare: async () => undefined,
    prefetch() {},
    selectFrame: () => activeFrame,
  } as unknown as BufferedDetectionTimeline;
}
