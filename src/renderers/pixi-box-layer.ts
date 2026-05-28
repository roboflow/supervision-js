import { BaseBoxStyle } from "#styles/box-style";
import {
  BoxShape,
  type BoxDrawInstruction,
  type BoxStyle,
} from "#types/box-style";
import type { BufferedDetectionTimeline } from "#types/detection-timeline";
import type { DetectionFrame } from "#types/detections";
import type { Graphics as PixiGraphics } from "pixi.js";

export interface PixiBoxLayerState {
  readonly activeDetectionFrameTime: number | null;
  readonly activeDetectionFrameIndex: number | null;
  readonly activeDetectionCount: number;
}

export interface PixiBoxLayer {
  attachGraphics(graphics: PixiGraphics): void;
  drawFrame(mediaTime: number): PixiBoxLayerState;
  setBoxStyle(boxStyle: BoxStyle | null | undefined): void;
}

export function createPixiBoxLayer(options: {
  readonly detectionTimeline: BufferedDetectionTimeline;
  readonly boxStyle: BoxStyle | undefined;
}): PixiBoxLayer {
  let boxStyle: BoxStyle | null = options.boxStyle ?? new BaseBoxStyle();
  let boxGraphics: PixiGraphics | undefined;
  let lastDrawnDetectionFrameTime: number | null = null;
  let hasDrawnDetectionFrame = false;
  let isDirty = true;

  return {
    attachGraphics(graphics) {
      boxGraphics = graphics;
    },

    drawFrame(mediaTime) {
      const detectionFrame = options.detectionTimeline.selectFrame(mediaTime);
      const detectionFrameTime = detectionFrame?.mediaTime ?? null;

      if (
        !isDirty &&
        hasDrawnDetectionFrame &&
        detectionFrameTime === lastDrawnDetectionFrameTime
      ) {
        return getBoxLayerState(detectionFrame);
      }

      isDirty = false;
      hasDrawnDetectionFrame = true;
      lastDrawnDetectionFrameTime = detectionFrameTime;
      boxGraphics?.clear();

      if (boxStyle && detectionFrame) {
        for (const [
          detectionIndex,
          detection,
        ] of detectionFrame.detections.entries()) {
          const instruction = boxStyle.resolve(detection, {
            detectionIndex,
            frame: detectionFrame,
            mediaTime,
          });

          if (!instruction) {
            continue;
          }

          drawBoxInstruction(boxGraphics, instruction);
        }
      }

      return getBoxLayerState(detectionFrame);
    },

    setBoxStyle(nextBoxStyle) {
      if (nextBoxStyle === undefined) {
        return;
      }

      boxStyle = nextBoxStyle;
      isDirty = true;
    },
  };
}

function drawBoxInstruction(
  graphics: PixiGraphics | undefined,
  instruction: BoxDrawInstruction,
) {
  if (!graphics) {
    return;
  }

  const { rect } = instruction;

  if (instruction.shape === BoxShape.RoundedRect) {
    graphics.roundRect(
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      instruction.cornerRadius ?? 0,
    );
  } else {
    graphics.rect(rect.x, rect.y, rect.width, rect.height);
  }

  if (instruction.fill) {
    graphics.fill(instruction.fill);
  }

  if (instruction.stroke) {
    graphics.stroke(instruction.stroke);
  }
}

function getBoxLayerState(
  detectionFrame: DetectionFrame | undefined,
): PixiBoxLayerState {
  return {
    activeDetectionCount: detectionFrame?.detections.length ?? 0,
    activeDetectionFrameIndex: detectionFrame?.frameIndex ?? null,
    activeDetectionFrameTime: detectionFrame?.mediaTime ?? null,
  };
}
