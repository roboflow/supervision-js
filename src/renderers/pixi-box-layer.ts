import { BaseBoxStyle } from "#styles/box-style";
import {
  BoxShape,
  type BoxDrawInstruction,
  type BoxStyle,
} from "#types/box-style";
import type { DetectionFrame } from "#types/detections";
import {
  copySortedDetectionFrames,
  selectDetectionFrame,
} from "#utils/detection-frames";
import type { Graphics as PixiGraphics } from "pixi.js";

export interface PixiBoxLayerState {
  readonly activeDetectionFrameTime: number | null;
  readonly activeDetectionCount: number;
}

export interface PixiBoxLayer {
  attachGraphics(graphics: PixiGraphics): void;
  drawFrame(mediaTime: number): PixiBoxLayerState;
}

export function createPixiBoxLayer(options: {
  readonly detectionFrames: readonly DetectionFrame[] | undefined;
  readonly boxStyle: BoxStyle | undefined;
}): PixiBoxLayer {
  const detectionFrames = copySortedDetectionFrames(options.detectionFrames);
  const boxStyle = options.boxStyle ?? new BaseBoxStyle();
  let boxGraphics: PixiGraphics | undefined;
  let lastDrawnDetectionFrame: DetectionFrame | undefined;
  let hasDrawnDetectionFrame = false;

  return {
    attachGraphics(graphics) {
      boxGraphics = graphics;
    },

    drawFrame(mediaTime) {
      const detectionFrame = selectDetectionFrame(detectionFrames, mediaTime);

      if (
        hasDrawnDetectionFrame &&
        detectionFrame === lastDrawnDetectionFrame
      ) {
        return getBoxLayerState(detectionFrame);
      }

      hasDrawnDetectionFrame = true;
      lastDrawnDetectionFrame = detectionFrame;
      boxGraphics?.clear();

      if (detectionFrame) {
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
    activeDetectionFrameTime: detectionFrame?.mediaTime ?? null,
  };
}
