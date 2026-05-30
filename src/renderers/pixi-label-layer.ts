import type { BufferedDetectionTimeline } from "#types/detection-timeline";
import type { DetectionFrame } from "#types/detections";
import type {
  LabelBackgroundStyle,
  LabelDrawInstruction,
  LabelStyle,
  LabelTextStyle,
} from "#types/label-style";
import type {
  Container as PixiContainer,
  Graphics as PixiGraphics,
  Text as PixiText,
} from "pixi.js";

interface PixiLabelEntry {
  readonly background: PixiGraphics;
  readonly label: PixiText;
}

export interface PixiLabelLayerOptions {
  readonly Container: new () => PixiContainer;
  readonly Graphics: new () => PixiGraphics;
  readonly Text: new (options: { text?: string; style?: unknown }) => PixiText;
  readonly detectionTimeline: BufferedDetectionTimeline;
  readonly labelStyle: LabelStyle | undefined;
}

export interface PixiLabelLayer {
  createContainer(): PixiContainer;
  drawFrame(mediaTime: number): void;
  setLabelStyle(labelStyle: LabelStyle | null): void;
  destroy(): void;
}

export function createPixiLabelLayer({
  Container,
  Graphics,
  Text,
  detectionTimeline,
  labelStyle,
}: PixiLabelLayerOptions): PixiLabelLayer {
  const entries: PixiLabelEntry[] = [];
  let container: PixiContainer | undefined;
  let currentLabelStyle = labelStyle;
  let lastFrameKey: string | undefined;
  let styleVersion = 0;
  let drawnStyleVersion = -1;

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
        label: new Text({ text: "", style: {} }),
      };
      entries[index] = entry;
      container?.addChild(entry.background, entry.label);
    }

    return entry;
  };

  const redrawFrame = (frame: DetectionFrame, mediaTime: number) => {
    let drawnCount = 0;

    if (!currentLabelStyle) {
      hideEntriesFrom(0);
      return;
    }

    for (
      let detectionIndex = 0;
      detectionIndex < frame.detections.length;
      detectionIndex += 1
    ) {
      const detection = frame.detections[detectionIndex]!;
      const instruction = currentLabelStyle.resolve(detection, {
        detectionIndex,
        frame,
        mediaTime,
      });

      if (!instruction) {
        continue;
      }

      drawInstruction(ensureEntry(drawnCount), instruction);
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

    drawFrame(mediaTime) {
      const frame = detectionTimeline.selectFrame(mediaTime);
      const frameKey = frame ? createFrameKey(frame) : undefined;

      if (frameKey === lastFrameKey && drawnStyleVersion === styleVersion) {
        return;
      }

      lastFrameKey = frameKey;
      drawnStyleVersion = styleVersion;

      if (!frame) {
        hideEntriesFrom(0);
        return;
      }

      redrawFrame(frame, mediaTime);
    },

    setLabelStyle(nextLabelStyle) {
      currentLabelStyle = nextLabelStyle ?? undefined;
      styleVersion += 1;
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
) {
  const textStyle = resolveTextStyle(instruction.textStyle);

  entry.label.text = instruction.text;
  entry.label.style = textStyle as PixiText["style"];
  entry.label.visible = true;
  entry.label.alpha = instruction.textStyle?.alpha ?? 1;

  const background = instruction.background;
  const paddingX = background?.paddingX ?? 0;
  const paddingY = background?.paddingY ?? 0;
  const width = entry.label.width + paddingX * 2;
  const height = entry.label.height + paddingY * 2;
  const x = instruction.rect.x + (instruction.offsetX ?? 0);
  const y = Math.max(
    0,
    instruction.rect.y - height - (instruction.offsetY ?? 0),
  );

  entry.label.x = x + paddingX;
  entry.label.y = y + paddingY;

  if (!background) {
    entry.background.clear();
    entry.background.visible = false;
    return;
  }

  drawBackground(entry.background, background, x, y, width, height);
}

function drawBackground(
  graphics: PixiGraphics,
  background: LabelBackgroundStyle,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  graphics.visible = true;
  graphics
    .clear()
    .roundRect(x, y, width, height, background.cornerRadius ?? 0)
    .fill({
      alpha: background.alpha,
      color: background.color,
    });
}

function resolveTextStyle(textStyle: LabelTextStyle | undefined) {
  return {
    fill: textStyle?.color ?? 0xffffff,
    fontFamily: textStyle?.fontFamily ?? "Inter, sans-serif",
    fontSize: textStyle?.fontSize ?? 13,
    fontWeight: textStyle?.fontWeight ?? "600",
  };
}

function createFrameKey(frame: DetectionFrame) {
  return `${frame.frameIndex ?? "time"}:${frame.mediaTime}`;
}
