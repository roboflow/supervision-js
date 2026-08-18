import { describe, expect, it, vi } from "vitest";

import { createPixiInteractionPresentationLayer } from "#renderers/pixi-interaction-presentation-layer";
import { BaseBoxStyle, BaseInteractionStyle } from "supervision-js-core";
import type {
  Detection,
  DetectionFrame,
  InteractionStyleContext,
} from "supervision-js-core";
import {
  DetectionInteractionState,
  DetectionPickTarget,
} from "supervision-js-core";

const frame: DetectionFrame = {
  detections: [
    {
      className: "player",
      id: "player-1",
      rect: { height: 30, width: 20, x: 20, y: 30 },
    },
  ],
  frameIndex: 3,
  mediaTime: 0.1,
};

describe("pixi interaction presentation layer", () => {
  it("passes the picked sub-geometry index to interaction styles", () => {
    const keypointFrame: DetectionFrame = {
      detections: [
        {
          className: "person",
          id: "person-1",
          keypoints: {
            edges: [],
            points: [{ x: 20, y: 30 }],
          },
        },
      ],
      mediaTime: 0.1,
    };
    const resolve = vi.fn(() => ({
      keypointStyle: {
        resolve: () => ({ edges: [], markers: [] }),
      },
    }));
    const layer = createPixiInteractionPresentationLayer({
      Container: FakeContainer as never,
      Graphics: FakeGraphics as never,
      Text: FakeText as never,
      interactionStyle: { resolve },
    });
    layer.createDisplay({ height: 80, width: 120 });

    layer.drawFrame({
      frame: keypointFrame,
      hoveredPick: {
        detection: keypointFrame.detections[0]!,
        detectionIndex: 0,
        frame: keypointFrame,
        geometryIndex: 0,
        mediaTime: keypointFrame.mediaTime,
        point: { x: 20, y: 30 },
        target: DetectionPickTarget.Keypoint,
      },
      mediaTime: keypointFrame.mediaTime,
      selectedPick: null,
    });

    expect(resolve).toHaveBeenCalledWith(
      keypointFrame.detections[0],
      expect.objectContaining({
        geometryIndex: 0,
        target: DetectionPickTarget.Keypoint,
      }),
    );
  });

  it("prefers hovered presentation for a selected keypoint under the pointer", () => {
    const keypointFrame: DetectionFrame = {
      detections: [
        {
          className: "person",
          id: "person-1",
          keypoints: { edges: [], points: [{ x: 20, y: 30 }] },
          rect: { height: 20, width: 20, x: 20, y: 30 },
        },
      ],
      mediaTime: 0.1,
    };
    const pick = {
      detection: keypointFrame.detections[0]!,
      detectionIndex: 0,
      frame: keypointFrame,
      geometryIndex: 0,
      mediaTime: keypointFrame.mediaTime,
      point: { x: 20, y: 30 },
      target: DetectionPickTarget.Keypoint,
    };
    const resolve = vi.fn(
      (_detection: Detection, context: InteractionStyleContext) => ({
        boxStyle: new BaseBoxStyle({
          fill: { alpha: 0, color: 0 },
          stroke: {
            alpha: 1,
            color:
              context.state === DetectionInteractionState.Hovered
                ? 0x00ff00
                : 0xff0000,
            width: 2,
          },
        }),
      }),
    );
    const layer = createPixiInteractionPresentationLayer({
      Container: FakeContainer as never,
      Graphics: FakeGraphics as never,
      Text: FakeText as never,
      interactionStyle: { resolve },
    });
    const display = layer.createDisplay({
      height: 80,
      width: 120,
    }) as FakeContainer;
    const graphics = display.children[0] as FakeGraphics;

    layer.drawFrame({
      frame: keypointFrame,
      hoveredPick: pick,
      mediaTime: keypointFrame.mediaTime,
      selectedPick: pick,
    });

    expect(graphics.stroke).toHaveBeenCalledWith(
      expect.objectContaining({ color: 0x00ff00 }),
    );
  });

  it("preserves selected presentation for a selected box under the pointer", () => {
    const pick = {
      detection: frame.detections[0]!,
      detectionIndex: 0,
      frame,
      mediaTime: frame.mediaTime,
      point: { x: 15, y: 20 },
      target: DetectionPickTarget.Box,
    };
    const resolve = vi.fn(
      (_detection: Detection, context: InteractionStyleContext) => ({
        boxStyle: new BaseBoxStyle({
          fill: { alpha: 0, color: 0 },
          stroke: {
            alpha: 1,
            color:
              context.state === DetectionInteractionState.Hovered
                ? 0x00ff00
                : 0xff0000,
            width: 2,
          },
        }),
      }),
    );
    const layer = createPixiInteractionPresentationLayer({
      Container: FakeContainer as never,
      Graphics: FakeGraphics as never,
      Text: FakeText as never,
      interactionStyle: { resolve },
    });
    const display = layer.createDisplay({
      height: 80,
      width: 120,
    }) as FakeContainer;
    const graphics = display.children[0] as FakeGraphics;

    layer.drawFrame({
      frame,
      hoveredPick: pick,
      mediaTime: frame.mediaTime,
      selectedPick: pick,
    });

    expect(graphics.stroke).toHaveBeenCalledWith(
      expect.objectContaining({ color: 0xff0000 }),
    );
  });

  it("keeps selected and hovered vector presentations for one detection", () => {
    const keypointFrame: DetectionFrame = {
      detections: [
        {
          className: "person",
          id: "person-1",
          keypoints: { edges: [], points: [{ x: 20, y: 30 }] },
          rect: { height: 20, width: 20, x: 20, y: 30 },
        },
      ],
      mediaTime: 0.1,
    };
    const layer = createPixiInteractionPresentationLayer({
      Container: FakeContainer as never,
      Graphics: FakeGraphics as never,
      Text: FakeText as never,
      interactionStyle: new BaseInteractionStyle({
        hovered: { keypointStyle: emptyKeypointStyle },
        selected: { keypointStyle: emptyKeypointStyle },
      }),
    });
    const display = layer.createDisplay({
      height: 80,
      width: 120,
    }) as FakeContainer;

    layer.drawFrame({
      frame: keypointFrame,
      hoveredPick: {
        detection: keypointFrame.detections[0]!,
        detectionIndex: 0,
        frame: keypointFrame,
        geometryIndex: 0,
        mediaTime: keypointFrame.mediaTime,
        point: { x: 20, y: 30 },
        target: DetectionPickTarget.Keypoint,
      },
      mediaTime: keypointFrame.mediaTime,
      selectedPick: {
        detection: keypointFrame.detections[0]!,
        detectionIndex: 0,
        frame: keypointFrame,
        mediaTime: keypointFrame.mediaTime,
        point: { x: 20, y: 30 },
        target: DetectionPickTarget.Box,
      },
    });

    const vectorContainer = display.children[1] as FakeContainer;
    expect(vectorContainer.children).toHaveLength(2);
  });

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

  it("omits interaction presentation for hidden detections", () => {
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
      isDetectionVisible: () => false,
    });
    const display = layer.createDisplay({
      height: 80,
      width: 120,
    }) as FakeContainer;
    const graphics = display.children[0] as FakeGraphics;

    layer.drawFrame({
      frame,
      hoveredPick: null,
      mediaTime: frame.mediaTime,
      selectedPick,
    });

    expect(graphics.rect).not.toHaveBeenCalled();
    expect(graphics.stroke).not.toHaveBeenCalled();
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

const emptyKeypointStyle = {
  resolve: () => ({ edges: [], markers: [] }),
};
