import { describe, expect, it, vi } from "vitest";

import { createPixiLabelLayer } from "#renderers/pixi-label-layer";
import type { BufferedDetectionTimeline } from "supervision-js-core";
import type { DetectionFrame } from "supervision-js-core";
import { LabelPlacement } from "supervision-js-core";
import { DetectionPickTarget } from "supervision-js-core";
import type { LabelStyle } from "supervision-js-core";

const firstFrame: DetectionFrame = {
  detections: [
    {
      className: "player",
      confidence: 0.93,
      id: "player-1",
      rect: { height: 20, width: 10, x: 15, y: 40 },
    },
  ],
  frameIndex: 1,
  mediaTime: 1,
};

const secondFrame: DetectionFrame = {
  detections: [
    {
      className: "player",
      confidence: 0.93,
      rect: { height: 20, width: 10, x: 21, y: 44 },
    },
  ],
  frameIndex: 2,
  mediaTime: 2,
};

describe("pixi label layer", () => {
  it("moves stable labels without re-rasterizing text or redrawing backgrounds", () => {
    const timeline = createTimeline([firstFrame, secondFrame]);
    const layer = createPixiLabelLayer({
      Container: FakeContainer as never,
      Graphics: FakeGraphics as never,
      Text: FakeText as never,
      detectionTimeline: timeline,
      labelStyle: createStableLabelStyle(),
    });
    const container = layer.createContainer() as FakeContainer;

    layer.drawFrame(1);
    layer.drawFrame(2);

    const [background, label] = container.children as [FakeGraphics, FakeText];

    expect(label.textAssignments).toBe(1);
    expect(label.styleAssignments).toBe(1);
    expect(label.x).toBe(23);
    expect(label.y).toBe(20);
    expect(background.clear).toHaveBeenCalledTimes(1);
    expect(background.roundRect).toHaveBeenCalledTimes(1);
    expect(background.x).toBe(16);
    expect(background.y).toBe(16);
  });

  it("redraws a replacement frame at the same timeline position", () => {
    const frames = [firstFrame];
    const layer = createPixiLabelLayer({
      Container: FakeContainer as never,
      Graphics: FakeGraphics as never,
      Text: FakeText as never,
      detectionTimeline: createTimeline(frames),
      labelStyle: createStableLabelStyle(),
    });
    const container = layer.createContainer() as FakeContainer;

    layer.drawFrame(1);
    const [background] = container.children as [FakeGraphics, FakeText];
    expect(background.x).toBe(10);

    frames[0] = {
      ...firstFrame,
      detections: [
        {
          ...firstFrame.detections[0]!,
          rect: { height: 20, width: 10, x: 45, y: 40 },
        },
      ],
    };
    layer.drawFrame(1);

    expect(background.x).toBe(40);
  });

  it("places labels relative to detection rectangles", () => {
    const timeline = createTimeline([firstFrame]);
    const layer = createPixiLabelLayer({
      Container: FakeContainer as never,
      Graphics: FakeGraphics as never,
      Text: FakeText as never,
      detectionTimeline: timeline,
      labelStyle: {
        resolve(detection) {
          if (!detection.rect) {
            return undefined;
          }

          return {
            background: {
              alpha: 0.8,
              color: 0x111111,
              cornerRadius: 4,
              paddingX: 7,
              paddingY: 4,
            },
            offsetX: 2,
            offsetY: 3,
            placement: LabelPlacement.Bottom,
            rect: detection.rect,
            text: "player",
          };
        },
      },
    });
    const container = layer.createContainer() as FakeContainer;

    layer.drawFrame(1);

    const [background, label] = container.children as [FakeGraphics, FakeText];

    expect(background.x).toBe(12);
    expect(background.y).toBe(53);
    expect(label.x).toBe(19);
    expect(label.y).toBe(57);
  });

  it("does not add an implicit top gutter when the scene supplies viewport scale", () => {
    const timeline = createTimeline([firstFrame]);
    const layer = createPixiLabelLayer({
      Container: FakeContainer as never,
      Graphics: FakeGraphics as never,
      Text: FakeText as never,
      detectionTimeline: timeline,
      labelStyle: createStableLabelStyle(),
    });
    const container = layer.createContainer() as FakeContainer;

    layer.drawFrame(1, 2);

    const [background, label] = container.children as [FakeGraphics, FakeText];

    expect(background.y).toBe(16);
    expect(label.y).toBe(18);
  });

  it.each([LabelPlacement.Top, LabelPlacement.InsideBottom])(
    "keeps %s labels inside the media at its top edge",
    (placement) => {
      const edgeFrame: DetectionFrame = {
        detections: [
          {
            rect: { height: 10, width: 10, x: 10, y: 5 },
          },
        ],
        mediaTime: 3,
      };
      const layer = createPixiLabelLayer({
        Container: FakeContainer as never,
        Graphics: FakeGraphics as never,
        Text: FakeText as never,
        detectionTimeline: createTimeline([edgeFrame]),
        labelStyle: {
          resolve(detection) {
            if (!detection.rect) return undefined;
            return {
              background: {
                alpha: 0.8,
                color: 0x111111,
                paddingX: 7,
                paddingY: 4,
              },
              placement,
              rect: detection.rect,
              text: "edge",
            };
          },
        },
      });
      const container = layer.createContainer() as FakeContainer;

      layer.drawFrame(3);

      const [background, label] = container.children as [
        FakeGraphics,
        FakeText,
      ];
      expect(background.y).toBe(0);
      expect(label.y).toBe(4);
    },
  );

  it("picks the visible label chip before underlying geometry", () => {
    const timeline = createTimeline([firstFrame]);
    const layer = createPixiLabelLayer({
      Container: FakeContainer as never,
      Graphics: FakeGraphics as never,
      Text: FakeText as never,
      detectionTimeline: timeline,
      labelStyle: createStableLabelStyle(),
    });

    layer.createContainer();
    layer.drawFrame(1);

    const pick = layer.pickDetectionAtPoint({ x: 11, y: 13 }, 1);

    expect(pick?.detectionIndex).toBe(0);
    expect(pick?.target).toBe(DetectionPickTarget.Label);
    expect(layer.pickDetectionAtPoint({ x: 100, y: 100 }, 1)).toBeNull();
  });

  it("reports the exact laid-out label bounds by detection id", () => {
    const layer = createPixiLabelLayer({
      Container: FakeContainer as never,
      Graphics: FakeGraphics as never,
      Text: FakeText as never,
      detectionTimeline: createTimeline([firstFrame]),
      labelStyle: createStableLabelStyle(),
    });

    layer.createContainer();
    layer.drawFrame(1);

    expect(layer.getDetectionLabelBounds("player-1")).toEqual({
      height: 18,
      width: 34,
      x: 10,
      y: 12,
    });

    layer.translateDetection("player-1", 3, 4);

    expect(layer.getDetectionLabelBounds("player-1")).toEqual({
      height: 18,
      width: 34,
      x: 13,
      y: 16,
    });

    layer.drawFrame(99);
    expect(layer.getDetectionLabelBounds("player-1")).toBeNull();
  });
});

class FakeContainer {
  readonly children: unknown[] = [];

  addChild(...children: unknown[]) {
    this.children.push(...children);
  }
}

class FakeGraphics {
  readonly clear = vi.fn(() => this);
  readonly fill = vi.fn(() => this);
  readonly roundRect = vi.fn(() => this);
  visible = false;
  x = 0;
  y = 0;
}

class FakeText {
  private currentText = "";
  private currentStyle: unknown = {};
  alpha = 1;
  visible = false;
  x = 0;
  y = 0;
  styleAssignments = 0;
  textAssignments = 0;

  constructor(options: { text?: string; style?: unknown }) {
    this.currentText = options.text ?? "";
    this.currentStyle = options.style ?? {};
  }

  get height() {
    return 10;
  }

  get style() {
    return this.currentStyle;
  }

  set style(nextStyle: unknown) {
    this.styleAssignments += 1;
    this.currentStyle = nextStyle;
  }

  get text() {
    return this.currentText;
  }

  set text(nextText: string) {
    this.textAssignments += 1;
    this.currentText = nextText;
  }

  get width() {
    return 20;
  }
}

function createStableLabelStyle(): LabelStyle {
  return {
    resolve(detection) {
      if (!detection.rect) {
        return undefined;
      }

      return {
        background: {
          alpha: 0.8,
          color: 0x111111,
          cornerRadius: 4,
          paddingX: 7,
          paddingY: 4,
        },
        rect: detection.rect,
        text: "player 93%",
        textStyle: {
          alpha: 1,
          color: 0xffffff,
          fontFamily: "Inter, sans-serif",
          fontSize: 14,
          fontWeight: "750",
        },
      };
    },
  };
}

function createTimeline(
  frames: readonly DetectionFrame[],
): BufferedDetectionTimeline {
  return {
    destroy() {},
    getBufferedFrames: () => frames,
    getState: () => ({
      bufferEndTime: frames.at(-1)?.mediaTime ?? null,
      bufferStartTime: frames[0]?.mediaTime ?? null,
      detectionCount: frames.reduce(
        (count, frame) => count + frame.detections.length,
        0,
      ),
      errorMessage: null,
      frameCount: frames.length,
      requestedEndTime: frames.at(-1)?.mediaTime ?? null,
      requestedStartTime: frames[0]?.mediaTime ?? null,
      status: "ready",
    }),
    prepare: async () => undefined,
    prefetch() {},
    selectFrame: (mediaTime: number) =>
      frames.find((frame) => frame.mediaTime === mediaTime),
  } as unknown as BufferedDetectionTimeline;
}
