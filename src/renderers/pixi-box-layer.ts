import { BaseBoxStyle } from "#styles/box-style";
import {
  BoxStrokeAlignment,
  BoxShape,
  type BoxDrawInstruction,
  type BoxStrokeStyle,
  type BoxStyle,
} from "#types/box-style";
import type { BufferedDetectionTimeline } from "#types/detection-timeline";
import type { DetectionFrame } from "#types/detections";
import type { Graphics as PixiGraphics } from "pixi.js";

export interface PixiBoxLayerState {
  readonly activeDetectionFrameTime: number | null;
  readonly activeDetectionFrameIndex: number | null;
  readonly activeDetectionCount: number;
  readonly activeDetectionIndexes: readonly number[];
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
  let lastDrawnState: PixiBoxLayerState | undefined;
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
        return lastDrawnState ?? getBoxLayerState(detectionFrame, []);
      }

      isDirty = false;
      hasDrawnDetectionFrame = true;
      lastDrawnDetectionFrameTime = detectionFrameTime;
      boxGraphics?.clear();

      const activeDetectionIndexes: number[] = [];

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

          activeDetectionIndexes.push(detectionIndex);
          drawBoxInstruction(boxGraphics, instruction);
        }
      }

      lastDrawnState = getBoxLayerState(detectionFrame, activeDetectionIndexes);

      return lastDrawnState;
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
    graphics.stroke(resolvePixiStroke(instruction.stroke));
  }
}

function resolvePixiStroke(stroke: BoxStrokeStyle) {
  const pixiStroke = {
    alpha: stroke.alpha,
    color: stroke.color,
    width: stroke.width,
  };

  if (stroke.alignment === undefined) {
    return pixiStroke;
  }

  return {
    ...pixiStroke,
    alignment: resolvePixiStrokeAlignment(stroke.alignment),
  };
}

function resolvePixiStrokeAlignment(alignment: BoxStrokeAlignment | undefined) {
  switch (alignment) {
    case BoxStrokeAlignment.Inside:
      return 1;
    case BoxStrokeAlignment.Outside:
      return 0;
    case BoxStrokeAlignment.Center:
    case undefined:
      return 0.5;
  }
}

function getBoxLayerState(
  detectionFrame: DetectionFrame | undefined,
  activeDetectionIndexes: readonly number[],
): PixiBoxLayerState {
  return {
    activeDetectionCount: activeDetectionIndexes.length,
    activeDetectionIndexes,
    activeDetectionFrameIndex: detectionFrame?.frameIndex ?? null,
    activeDetectionFrameTime: detectionFrame?.mediaTime ?? null,
  };
}
