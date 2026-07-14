import { describe, expect, it, vi } from "vitest";

import { createPixiBoxLayer } from "#renderers/pixi-box-layer";
import {
  BoxShape,
  BoxStrokeAlignment,
  type BoxStyle,
} from "supervision-js-core";
import type { BufferedDetectionTimeline } from "supervision-js-core";
import type { DetectionFrame } from "supervision-js-core";

const frame: DetectionFrame = {
  detections: [
    {
      className: "player",
      confidence: 0.9,
      rect: { height: 30, width: 20, x: 10, y: 15 },
    },
    {
      className: "player",
      confidence: 0.2,
      rect: { height: 30, width: 20, x: 40, y: 15 },
    },
  ],
  frameIndex: 3,
  mediaTime: 0.1,
};

describe("pixi box layer", () => {
  it("dirty redraws only when the active frame or style changes", () => {
    const graphics = new FakeGraphics();
    const style = createBoxStyle(0xff0000);
    const nextStyle = createBoxStyle(0x00ff00);
    const layer = createPixiBoxLayer({
      boxStyle: style,
      detectionTimeline: createTimeline(frame),
    });

    layer.attachGraphics(graphics as never);

    expect(layer.drawFrame(0.1)).toEqual({
      activeDetectionCount: 1,
      activeDetectionFrameIndex: 3,
      activeDetectionIndexes: [0],
      activeDetectionFrameTime: 0.1,
    });
    layer.drawFrame(0.1);

    expect(graphics.clear).toHaveBeenCalledTimes(1);
    expect(graphics.rect).toHaveBeenCalledTimes(1);
    expect(graphics.stroke).toHaveBeenCalledWith({
      alpha: 1,
      color: 0xff0000,
      width: 2,
    });

    layer.setBoxStyle(nextStyle);
    layer.drawFrame(0.1);

    expect(graphics.clear).toHaveBeenCalledTimes(2);
    expect(graphics.rect).toHaveBeenCalledTimes(2);
    expect(graphics.stroke).toHaveBeenLastCalledWith({
      alpha: 1,
      color: 0x00ff00,
      width: 2,
    });
  });

  it("maps renderer-neutral box stroke alignment to Pixi stroke alignment", () => {
    const graphics = new FakeGraphics();
    const layer = createPixiBoxLayer({
      boxStyle: {
        resolve(detection) {
          if (!detection.rect) {
            return undefined;
          }

          return {
            rect: detection.rect,
            shape: BoxShape.Rect,
            stroke: {
              alignment: BoxStrokeAlignment.Inside,
              alpha: 1,
              color: 0xff0000,
              width: 2,
            },
          };
        },
      },
      detectionTimeline: createTimeline(frame),
    });

    layer.attachGraphics(graphics as never);
    layer.drawFrame(0.1);

    expect(graphics.stroke).toHaveBeenCalledWith({
      alignment: 1,
      alpha: 1,
      color: 0xff0000,
      width: 2,
    });
  });

  it("treats null box style as disabled instead of falling back to defaults", () => {
    const graphics = new FakeGraphics();
    const layer = createPixiBoxLayer({
      boxStyle: null,
      detectionTimeline: createTimeline(frame),
    });

    layer.attachGraphics(graphics as never);

    expect(layer.drawFrame(0.1)).toEqual({
      activeDetectionCount: 0,
      activeDetectionFrameIndex: 3,
      activeDetectionIndexes: [],
      activeDetectionFrameTime: 0.1,
    });
    expect(graphics.clear).toHaveBeenCalledOnce();
    expect(graphics.rect).not.toHaveBeenCalled();
    expect(graphics.stroke).not.toHaveBeenCalled();
  });

  it("retains boxes by id and translates one display without redrawing the frame", () => {
    const retainedFrame: DetectionFrame = {
      ...frame,
      detections: frame.detections.map((detection, index) => ({
        ...detection,
        id: `box-${index}`,
      })),
    };
    const layer = createPixiBoxLayer({
      boxStyle: createBoxStyle(0xff0000),
      Container: FakeContainer as never,
      detectionTimeline: createTimeline(retainedFrame),
      Graphics: FakeGraphics as never,
    });
    const container = layer.createContainer() as unknown as FakeContainer;

    layer.drawFrame(0.1);
    const display = container.children[0]!;
    expect(layer.translateDetection("box-0", 7, -2)).toBe(true);
    expect(display.position.set).toHaveBeenLastCalledWith(7, -2);

    layer.drawFrame(0.1);
    expect(display.clear).toHaveBeenCalledOnce();

    layer.invalidateDetection("box-0");
    layer.drawFrame(0.1);
    expect(display.clear).toHaveBeenCalledTimes(2);
    expect(display.position.set).toHaveBeenLastCalledWith(0, 0);
  });
});

class FakeContainer {
  readonly children: FakeGraphics[] = [];
  sortableChildren = false;

  addChild(...children: FakeGraphics[]) {
    this.children.push(...children);
  }
}

class FakeGraphics {
  readonly clear = vi.fn(() => this);
  readonly fill = vi.fn(() => this);
  readonly rect = vi.fn(() => this);
  readonly roundRect = vi.fn(() => this);
  readonly stroke = vi.fn(() => this);
  readonly position = { set: vi.fn() };
  visible = true;
  zIndex = 0;
}

function createBoxStyle(color: number): BoxStyle {
  return {
    resolve(detection) {
      if (!detection.rect || (detection.confidence ?? 1) < 0.8) {
        return undefined;
      }

      return {
        rect: detection.rect,
        shape: BoxShape.Rect,
        stroke: {
          alpha: 1,
          color,
          width: 2,
        },
      };
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
