import { BaseBoxStyle, centerRectToTopLeftRect } from "supervision-js-core";
import {
  BoxShape,
  type BoxDrawInstruction,
  type BoxStyle,
} from "supervision-js-core";
import type { BufferedDetectionTimeline } from "supervision-js-core";
import type { DetectionFrame } from "supervision-js-core";
import type { AnnotationStyleContext, Detection } from "supervision-js-core";
import type { Graphics as PixiGraphics } from "pixi.js";
import type { Container as PixiContainer } from "pixi.js";
import { drawPixiPath, resolvePixiStroke } from "./pixi-path";

export interface PixiBoxLayerState {
  readonly activeDetectionFrameTime: number | null;
  readonly activeDetectionFrameIndex: number | null;
  readonly activeDetectionCount: number;
  readonly activeDetectionIndexes: readonly number[];
}

export interface PixiBoxLayer {
  createContainer(): PixiContainer | undefined;
  attachGraphics(graphics: PixiGraphics): void;
  drawFrame(mediaTime: number, viewportScale?: number): PixiBoxLayerState;
  setBoxStyle(boxStyle: BoxStyle | null | undefined): void;
  invalidate(): void;
  invalidateDetection(id: string | number): void;
  translateDetection(id: string | number, x: number, y: number): boolean;
}

export function createPixiBoxLayer(options: {
  readonly detectionTimeline: BufferedDetectionTimeline;
  readonly boxStyle: BoxStyle | null | undefined;
  readonly Container?: new () => PixiContainer;
  readonly Graphics?: new () => PixiGraphics;
  readonly resolveContextState?: (
    detection: Detection,
  ) => Partial<AnnotationStyleContext>;
}): PixiBoxLayer {
  let boxStyle: BoxStyle | null =
    options.boxStyle === undefined ? new BaseBoxStyle() : options.boxStyle;
  let boxGraphics: PixiGraphics | undefined;
  let lastDrawnDetectionFrameTime: number | null = null;
  let lastDrawnState: PixiBoxLayerState | undefined;
  let hasDrawnDetectionFrame = false;
  let isDirty = true;
  let lastViewportScale = 0;
  let retainedContainer: PixiContainer | undefined;
  const retainedEntries = new Map<string, PixiGraphics>();
  const invalidatedDetections = new Set<string>();

  const usingRetainedEntries = Boolean(options.Container && options.Graphics);

  return {
    createContainer() {
      if (!usingRetainedEntries) return undefined;
      retainedContainer ??= new options.Container!();
      retainedContainer.sortableChildren = true;
      return retainedContainer;
    },

    attachGraphics(graphics) {
      boxGraphics = graphics;
    },

    drawFrame(mediaTime, viewportScale = 1) {
      const detectionFrame = options.detectionTimeline.selectFrame(mediaTime);
      const detectionFrameTime = detectionFrame?.mediaTime ?? null;

      if (
        !isDirty &&
        hasDrawnDetectionFrame &&
        detectionFrameTime === lastDrawnDetectionFrameTime &&
        viewportScale === lastViewportScale
      ) {
        return lastDrawnState ?? getBoxLayerState(detectionFrame, []);
      }

      isDirty = false;
      hasDrawnDetectionFrame = true;
      lastDrawnDetectionFrameTime = detectionFrameTime;
      lastViewportScale = viewportScale;
      if (!usingRetainedEntries) boxGraphics?.clear();

      const activeDetectionIndexes: number[] = [];
      const activeKeys = new Set<string>();

      if (boxStyle && detectionFrame) {
        const orderedDetections = detectionFrame.detections
          .map((detection, detectionIndex) => ({ detection, detectionIndex }))
          .sort(
            (left, right) =>
              (left.detection.zIndex ?? left.detectionIndex) -
              (right.detection.zIndex ?? right.detectionIndex),
          );

        for (const { detectionIndex, detection } of orderedDetections) {
          const key = detectionKey(detection, detectionIndex);
          const instruction = boxStyle.resolve(detection, {
            detectionIndex,
            frame: detectionFrame,
            mediaTime,
            viewportScale,
            ...options.resolveContextState?.(detection),
          });

          if (!instruction) {
            const display = retainedEntries.get(key);
            if (display) display.visible = false;
            continue;
          }

          activeDetectionIndexes.push(detectionIndex);
          if (usingRetainedEntries) {
            activeKeys.add(key);
            const display = ensureRetainedEntry(key);
            display.visible = true;
            display.zIndex = detection.zIndex ?? detectionIndex;
            display.position?.set?.(0, 0);
            display.clear();
            drawBoxInstruction(display, instruction, viewportScale);
            invalidatedDetections.delete(key);
          } else {
            drawBoxInstruction(boxGraphics, instruction, viewportScale);
          }
        }
      }
      if (usingRetainedEntries) {
        for (const [key, display] of retainedEntries) {
          if (!activeKeys.has(key)) display.visible = false;
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

    invalidate() {
      isDirty = true;
    },

    invalidateDetection(id) {
      invalidatedDetections.add(`id:${String(id)}`);
      isDirty = true;
    },

    translateDetection(id, x, y) {
      const display = retainedEntries.get(`id:${String(id)}`);
      if (!display) return false;
      display.position?.set?.(x, y);
      return true;
    },
  };

  function ensureRetainedEntry(key: string) {
    let display = retainedEntries.get(key);
    if (!display) {
      display = new options.Graphics!();
      retainedEntries.set(key, display);
      retainedContainer?.addChild(display);
    }
    return display;
  }
}

function detectionKey(detection: Detection, detectionIndex: number) {
  return detection.id === undefined
    ? `index:${detectionIndex}`
    : `id:${String(detection.id)}`;
}

function drawBoxInstruction(
  graphics: PixiGraphics | undefined,
  instruction: BoxDrawInstruction,
  viewportScale: number,
) {
  if (!graphics) {
    return;
  }

  const { rect } = instruction;
  const { x: left, y: top } = centerRectToTopLeftRect(rect);

  if (instruction.stroke?.dash?.length) {
    if (instruction.fill) {
      graphics.rect(left, top, rect.width, rect.height);
      graphics.fill(instruction.fill);
    }

    drawPixiPath(
      graphics,
      [
        { x: left, y: top },
        { x: left + rect.width, y: top },
        { x: left + rect.width, y: top + rect.height },
        { x: left, y: top + rect.height },
      ],
      true,
      instruction.stroke,
      viewportScale,
    );
    return;
  }

  if (instruction.shape === BoxShape.RoundedRect) {
    graphics.roundRect(
      left,
      top,
      rect.width,
      rect.height,
      instruction.cornerRadius ?? 0,
    );
  } else {
    graphics.rect(left, top, rect.width, rect.height);
  }

  if (instruction.fill) {
    graphics.fill(instruction.fill);
  }

  if (instruction.stroke) {
    graphics.stroke(resolvePixiStroke(instruction.stroke, viewportScale));
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
