import type { BufferedDetectionTimeline } from "supervision-js-core";
import type { DetectionFrame } from "supervision-js-core";
import type {
  AnnotationStyleContext,
  Detection,
  LabelBackgroundStyle,
  LabelDrawInstruction,
  LabelStyle,
  LabelTextStyle,
  DetectionPickPoint,
  DetectionPickResult,
} from "supervision-js-core";
import {
  centerRectToTopLeftRect,
  DetectionPickTarget,
  LabelPlacement,
} from "supervision-js-core";
import type {
  Container as PixiContainer,
  Graphics as PixiGraphics,
  Text as PixiText,
} from "pixi.js";

interface PixiLabelEntry {
  readonly background: PixiGraphics;
  readonly label: PixiText;
  backgroundHeight: number;
  backgroundKey: string | null;
  backgroundWidth: number;
  labelAlpha: number | null;
  backgroundBaseX: number;
  backgroundBaseY: number;
  labelBaseX: number;
  labelBaseY: number;
  text: string | null;
  textStyleKey: string | null;
}

interface LabelHitRect {
  readonly detectionIndex: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PixiLabelLayerOptions {
  readonly Container: new () => PixiContainer;
  readonly Graphics: new () => PixiGraphics;
  readonly Text: new (options: { text?: string; style?: unknown }) => PixiText;
  readonly detectionTimeline: BufferedDetectionTimeline;
  readonly labelStyle: LabelStyle | undefined;
  readonly resolveContextState?: (
    detection: Detection,
  ) => Partial<AnnotationStyleContext>;
}

export interface PixiLabelLayer {
  createContainer(): PixiContainer;
  drawFrame(mediaTime: number, viewportScale?: number): void;
  setLabelStyle(labelStyle: LabelStyle | null): void;
  translateDetection(id: string | number, x: number, y: number): boolean;
  pickDetectionAtPoint(
    point: DetectionPickPoint,
    mediaTime: number,
  ): DetectionPickResult | null;
  destroy(): void;
}

export function createPixiLabelLayer({
  Container,
  Graphics,
  Text,
  detectionTimeline,
  labelStyle,
  resolveContextState,
}: PixiLabelLayerOptions): PixiLabelLayer {
  const entries: PixiLabelEntry[] = [];
  let container: PixiContainer | undefined;
  let currentLabelStyle = labelStyle;
  // A versioned source can replace a frame without changing its media time or
  // frame index. Buffered frames are immutable snapshots, so retain by object.
  let lastFrame: DetectionFrame | undefined;
  let styleVersion = 0;
  let drawnStyleVersion = -1;
  let lastViewportScale = 0;
  let hitRects: LabelHitRect[] = [];
  const entriesByDetectionKey = new Map<string, PixiLabelEntry>();

  const hideEntriesFrom = (startIndex: number) => {
    for (let index = startIndex; index < entries.length; index += 1) {
      entries[index]!.background.visible = false;
      entries[index]!.label.visible = false;
    }
  };

  const ensureEntry = (index: number) => {
    let entry = entries[index];

    if (!entry) {
      entry = {
        background: new Graphics(),
        backgroundHeight: 0,
        backgroundKey: null,
        backgroundBaseX: 0,
        backgroundBaseY: 0,
        backgroundWidth: 0,
        label: new Text({ text: "", style: {} }),
        labelAlpha: null,
        labelBaseX: 0,
        labelBaseY: 0,
        text: null,
        textStyleKey: null,
      };
      entries[index] = entry;
      container?.addChild(entry.background, entry.label);
    }

    return entry;
  };

  const redrawFrame = (
    frame: DetectionFrame,
    mediaTime: number,
    viewportScale: number,
  ) => {
    let drawnCount = 0;
    hitRects = [];
    entriesByDetectionKey.clear();

    if (!currentLabelStyle) {
      hideEntriesFrom(0);
      return;
    }

    const orderedDetections = frame.detections
      .map((detection, detectionIndex) => ({ detection, detectionIndex }))
      .sort(
        (left, right) =>
          (left.detection.zIndex ?? left.detectionIndex) -
          (right.detection.zIndex ?? right.detectionIndex),
      );

    for (const { detection, detectionIndex } of orderedDetections) {
      const instruction = currentLabelStyle.resolve(detection, {
        detectionIndex,
        frame,
        mediaTime,
        viewportScale,
        ...resolveContextState?.(detection),
      });

      if (!instruction) {
        continue;
      }

      const entry = ensureEntry(drawnCount);
      const hitRect = drawInstruction(entry, instruction, viewportScale);
      entriesByDetectionKey.set(detectionKey(detection, detectionIndex), entry);
      hitRects.push({ ...hitRect, detectionIndex });
      drawnCount += 1;
    }

    hideEntriesFrom(drawnCount);
  };

  return {
    createContainer() {
      if (!container) {
        container = new Container();
      }

      return container;
    },

    drawFrame(mediaTime, viewportScale) {
      const resolvedViewportScale = viewportScale ?? 1;
      const frame = detectionTimeline.selectFrame(mediaTime);

      if (
        frame === lastFrame &&
        drawnStyleVersion === styleVersion &&
        resolvedViewportScale === lastViewportScale
      ) {
        return;
      }

      lastFrame = frame;
      drawnStyleVersion = styleVersion;
      lastViewportScale = resolvedViewportScale;

      if (!frame) {
        hideEntriesFrom(0);
        return;
      }

      redrawFrame(frame, mediaTime, resolvedViewportScale);
    },

    setLabelStyle(nextLabelStyle) {
      currentLabelStyle = nextLabelStyle ?? undefined;
      styleVersion += 1;
    },

    translateDetection(id, x, y) {
      const entry = entriesByDetectionKey.get(`id:${String(id)}`);
      if (!entry) return false;
      entry.background.x = entry.backgroundBaseX + x;
      entry.background.y = entry.backgroundBaseY + y;
      entry.label.x = entry.labelBaseX + x;
      entry.label.y = entry.labelBaseY + y;
      return true;
    },

    pickDetectionAtPoint(point, mediaTime) {
      const frame = detectionTimeline.selectFrame(mediaTime);
      if (!frame) return null;
      const hit = [...hitRects]
        .reverse()
        .find(
          (rect) =>
            point.x >= rect.x &&
            point.x <= rect.x + rect.width &&
            point.y >= rect.y &&
            point.y <= rect.y + rect.height,
        );
      const detection =
        hit === undefined ? undefined : frame.detections[hit.detectionIndex];
      return hit && detection
        ? {
            detection,
            detectionIndex: hit.detectionIndex,
            frame,
            mediaTime,
            point,
            target: DetectionPickTarget.Label,
          }
        : null;
    },

    destroy() {
      hideEntriesFrom(0);
      entries.length = 0;
      container = undefined;
    },
  };
}

function drawInstruction(
  entry: PixiLabelEntry,
  instruction: LabelDrawInstruction,
  viewportScale: number,
) {
  const textStyle = resolveTextStyle(instruction.textStyle, viewportScale);
  const textStyleKey = createTextStyleKey(textStyle);
  const textAlpha = instruction.textStyle?.alpha ?? 1;

  if (entry.text !== instruction.text) {
    entry.label.text = instruction.text;
    entry.text = instruction.text;
  }

  if (entry.textStyleKey !== textStyleKey) {
    entry.label.style = textStyle as PixiText["style"];
    entry.textStyleKey = textStyleKey;
  }

  entry.label.visible = true;

  if (entry.labelAlpha !== textAlpha) {
    entry.label.alpha = textAlpha;
    entry.labelAlpha = textAlpha;
  }

  const background = instruction.background;
  const paddingX = (background?.paddingX ?? 0) / viewportScale;
  const paddingY = (background?.paddingY ?? 0) / viewportScale;
  const width = entry.label.width + paddingX * 2;
  const height = entry.label.height + paddingY * 2;
  const { x, y } = resolveLabelPosition(instruction, width, height);

  entry.label.x = x + paddingX;
  entry.label.y = y + paddingY;
  entry.labelBaseX = entry.label.x;
  entry.labelBaseY = entry.label.y;

  if (!background) {
    entry.background.visible = false;
    entry.backgroundKey = null;
    return { height, width, x, y };
  }

  drawBackground(entry, background, x, y, width, height, viewportScale);
  return { height, width, x, y };
}

function resolveLabelPosition(
  instruction: LabelDrawInstruction,
  width: number,
  height: number,
) {
  const { rect } = instruction;
  const offsetX = instruction.offsetX ?? 0;
  const offsetY = instruction.offsetY ?? 0;
  const { x: left, y: top } = centerRectToTopLeftRect(rect);

  switch (instruction.placement ?? LabelPlacement.Top) {
    case LabelPlacement.Bottom:
      return {
        x: left + offsetX,
        y: top + rect.height + offsetY,
      };
    case LabelPlacement.Center:
      return {
        x: rect.x - width / 2 + offsetX,
        y: rect.y - height / 2 + offsetY,
      };
    case LabelPlacement.InsideBottom:
      return {
        x: left + offsetX,
        y: Math.max(0, top + rect.height - height - offsetY),
      };
    case LabelPlacement.InsideTop:
      return {
        x: left + offsetX,
        y: top + offsetY,
      };
    case LabelPlacement.Top:
      return {
        x: left + offsetX,
        y: Math.max(0, top - height - offsetY),
      };
  }
}

function drawBackground(
  entry: PixiLabelEntry,
  background: LabelBackgroundStyle,
  x: number,
  y: number,
  width: number,
  height: number,
  viewportScale: number,
) {
  const graphics = entry.background;
  const backgroundKey = createBackgroundKey(background);

  graphics.visible = true;
  graphics.x = x;
  graphics.y = y;
  entry.backgroundBaseX = x;
  entry.backgroundBaseY = y;

  if (
    entry.backgroundKey === backgroundKey &&
    entry.backgroundWidth === width &&
    entry.backgroundHeight === height
  ) {
    return;
  }

  entry.backgroundKey = backgroundKey;
  entry.backgroundWidth = width;
  entry.backgroundHeight = height;

  graphics.clear();
  const radius = (background.cornerRadius ?? 0) / viewportScale;

  if (background.topCornersOnly && radius > 0) {
    graphics
      .moveTo(0, height)
      .lineTo(0, radius)
      .quadraticCurveTo(0, 0, radius, 0)
      .lineTo(width - radius, 0)
      .quadraticCurveTo(width, 0, width, radius)
      .lineTo(width, height)
      .closePath();
  } else {
    graphics.roundRect(0, 0, width, height, radius);
  }

  graphics.fill({
    alpha: background.alpha,
    color: background.color,
  });
}

function resolveTextStyle(
  textStyle: LabelTextStyle | undefined,
  viewportScale: number,
) {
  return {
    fill: textStyle?.color ?? 0xffffff,
    fontFamily: textStyle?.fontFamily ?? "Inter, sans-serif",
    fontSize: (textStyle?.fontSize ?? 13) / viewportScale,
    fontWeight: textStyle?.fontWeight ?? "600",
  };
}

function createTextStyleKey(textStyle: ReturnType<typeof resolveTextStyle>) {
  return [
    textStyle.fill,
    textStyle.fontFamily,
    textStyle.fontSize,
    textStyle.fontWeight,
  ].join(":");
}

function createBackgroundKey(background: LabelBackgroundStyle) {
  return [
    background.alpha,
    background.color,
    background.cornerRadius ?? 0,
    background.paddingX ?? 0,
    background.paddingY ?? 0,
    background.topCornersOnly ? 1 : 0,
  ].join(":");
}

function detectionKey(detection: Detection, detectionIndex: number) {
  return detection.id === undefined
    ? `index:${detectionIndex}`
    : `id:${String(detection.id)}`;
}
