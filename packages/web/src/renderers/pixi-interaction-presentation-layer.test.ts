import { describe, expect, it, vi } from "vitest";

import { createPixiInteractionPresentationLayer } from "#renderers/pixi-interaction-presentation-layer";
import { BaseInteractionStyle } from "supervision-js-core";
import type { DetectionFrame } from "supervision-js-core";
import { DetectionPickTarget } from "supervision-js-core";

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

describe("pixi interaction presentation layer", () => {
  it("draws selected presentations when the active frame is an equivalent clone", () => {
    const selectedPick = {
      detection: frame.detections[0]!,
      detectionIndex: 0,
      frame,
      mediaTime: frame.mediaTime,
      point: { x: 15, y: 20 },
      target: DetectionPickTarget.Box,
    };
    const layer = createPixiInteractionPresentationLayer({
      Container: FakeContainer as never,
      Graphics: FakeGraphics as never,
      Text: FakeText as never,
      interactionStyle: new BaseInteractionStyle(),
    });
    const display = layer.createDisplay({
      height: 80,
      width: 120,
    }) as FakeContainer;
    const graphics = display.children[0] as FakeGraphics;
    const clonedFrame = cloneDetectionFrame(frame);

    layer.drawFrame({
      frame: clonedFrame,
      hoveredPick: null,
      mediaTime: clonedFrame.mediaTime,
      selectedPick,
    });

    expect(graphics.rect).toHaveBeenCalledWith(10, 15, 20, 30);
    expect(graphics.stroke).toHaveBeenCalled();
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
  readonly rect = vi.fn(() => this);
  readonly roundRect = vi.fn(() => this);
  readonly stroke = vi.fn(() => this);
}

class FakeText {
  alpha = 1;
  height = 10;
  style: unknown;
  text = "";
  visible = true;
  width = 20;
  x = 0;
  y = 0;

  constructor(options: { readonly style?: unknown; readonly text?: string }) {
    this.style = options.style;
    this.text = options.text ?? "";
  }
}

function cloneDetectionFrame(sourceFrame: DetectionFrame): DetectionFrame {
  return {
    ...sourceFrame,
    detections: sourceFrame.detections.map((detection) => ({ ...detection })),
  };
}
