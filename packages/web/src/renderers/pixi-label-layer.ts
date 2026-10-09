import type { BufferedDetectionTimeline } from "supervision-js-core";
import type { DetectionFrame } from "supervision-js-core";
import type {
  AnnotationStyleContext,
  Detection,
  LabelBackgroundStyle,
  LabelDrawInstruction,
  LabelStyle,
  LabelTextStyle,
  Rect,
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
  Filter as PixiFilter,
  Graphics as PixiGraphics,
  Text as PixiText,
} from "pixi.js";
import type { PixiRenderedBoxFrame } from "./pixi-box-layer";

type RoundedLabelCorners = "all" | "top" | "bottom";

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
  textHeight: number;
  textWidth: number;
  instruction: LabelDrawInstruction | undefined;
}

interface LabelHitRect {
  readonly detectionIndex: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface LabelLayoutRect {
  readonly baseX: number;
  readonly baseY: number;
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

type LabelCaptureBounds = Pick<LabelLayoutRect, "height" | "width" | "x" | "y">;

export interface PixiLabelLayerOptions {
  readonly Container: new () => PixiContainer;
  readonly Graphics: new () => PixiGraphics;
  readonly Text: new (options: { text?: string; style?: unknown }) => PixiText;
  readonly detectionTimeline: BufferedDetectionTimeline;
  readonly labelStyle: LabelStyle | undefined;
  readonly getRenderedBoxes?: () => PixiRenderedBoxFrame | undefined;
  readonly resolveContextState?: (
    detection: Detection,
  ) => Partial<AnnotationStyleContext>;
}

export interface PixiLabelLayer {
  createContainer(): PixiContainer;
  drawFrame(mediaTime: number, viewportScale?: number): void;
  /** Draw a transient creation label with the same style as committed data. */
  drawCreationPreview(
    detection: Detection | null,
    mediaTime: number,
    viewportScale?: number,
    renderedBox?: Rect,
  ): void;
  updateEditingBox(id: string | number, renderedBox: Rect | undefined): void;
  setLabelStyle(labelStyle: LabelStyle | null): void;
  setBackgroundAntialiasFilter(filter: PixiFilter | null): void;
  translateDetection(id: string | number, x: number, y: number): boolean;
  getDetectionLabelBounds(id: string | number): {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  } | null;
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
  getRenderedBoxes,
  resolveContextState,
}: PixiLabelLayerOptions): PixiLabelLayer {
  const entries: PixiLabelEntry[] = [];
  let container: PixiContainer | undefined;
  let currentLabelStyle = labelStyle;
  // A versioned source can replace a frame without changing its media time or
  // frame index. Buffered frames are immutable snapshots, so retain by object.
  let lastFrame: DetectionFrame | undefined;
  let lastBoxFrame: PixiRenderedBoxFrame | undefined;
  let styleVersion = 0;
  let drawnStyleVersion = -1;
  let lastViewportScale = 0;
  let hitRects: LabelHitRect[] = [];
  let previewEntry: PixiLabelEntry | undefined;
  let previewIndex = 0;
  let backgroundFilter: PixiFilter | null = null;
  let backgroundFilters: PixiFilter[] | null = null;
  let backgroundsGrouped = false;
  const backgroundGroups: PixiContainer[] = [];
  const entriesByDetectionKey = new Map<string, PixiLabelEntry>();
  const boundsByDetectionKey = new Map<string, LabelLayoutRect>();

  const clearLayout = () => {
    hitRects = [];
    entriesByDetectionKey.clear();
    boundsByDetectionKey.clear();
  };

  const hideEntriesFrom = (startIndex: number) => {
    for (let index = startIndex; index < entries.length; index += 1) {
      entries[index]!.background.visible = false;
      entries[index]!.label.visible = false;
      entries[index]!.instruction = undefined;
    }
  };

  const createEntry = () => {
    const entry: PixiLabelEntry = {
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
      textHeight: 0,
      textWidth: 0,
      instruction: undefined,
    };
    container?.addChild(entry.background, entry.label);
    return entry;
  };

  const ensureEntry = (index: number) => {
    let entry = entries[index];

    if (!entry) {
      entry = createEntry();
      entries[index] = entry;
    }

    return entry;
  };

  const hideCreationPreview = () => {
    if (!previewEntry) return;
    previewEntry.background.visible = false;
    previewEntry.label.visible = false;
    previewEntry.instruction = undefined;
  };

  const syncBackgroundCaptures = () => {
    if (!container || (!backgroundFilter && !backgroundsGrouped)) return;
    for (const group of backgroundGroups) {
      group.removeChildren();
      group.filters = null;
    }
    container.removeChildren();
    backgroundsGrouped = backgroundFilter !== null;
    const orderedEntries = previewEntry
      ? [
          ...entries.slice(0, previewIndex),
          previewEntry,
          ...entries.slice(previewIndex),
        ]
      : entries;
    if (!backgroundFilter) {
      for (const entry of orderedEntries) {
        container.addChild(entry.background, entry.label);
      }
      return;
    }

    let groupIndex = 0;
    const run: PixiLabelEntry[] = [];
    let runBounds: LabelCaptureBounds | undefined;
    const padding =
      backgroundFilter.padding / Math.max(lastViewportScale, 1e-6);
    const flushRun = () => {
      if (run.length === 0) return;
      if (run.some((entry) => entry.background.visible)) {
        const group = (backgroundGroups[groupIndex] ??= new Container());
        groupIndex += 1;
        group.label = "label-background-aa";
        group.filters = backgroundFilters;
        container!.addChild(group);
        for (const entry of run) group.addChild(entry.background);
      } else {
        for (const entry of run) container!.addChild(entry.background);
      }
      for (const entry of run) container!.addChild(entry.label);
      run.length = 0;
      runBounds = undefined;
    };

    for (const entry of orderedEntries) {
      if (entry.background.visible || entry.label.visible) {
        const padded = resolveCaptureBounds(entry, padding);
        // Reordering a disjoint run leaves translucent overlapping chips and
        // their text in the same paint order as the original label pairs.
        if (runBounds && rectanglesOverlap(runBounds, padded)) flushRun();
        runBounds = runBounds ? unionCaptureBounds(runBounds, padded) : padded;
      }
      run.push(entry);
    }
    flushRun();
  };

  const redrawFrame = (
    frame: DetectionFrame,
    mediaTime: number,
    viewportScale: number,
    renderedBoxes: ReadonlyMap<number, Rect> | undefined,
  ) => {
    let drawnCount = 0;
    clearLayout();

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
      const hitRect = drawInstruction(
        entry,
        instruction,
        viewportScale,
        renderedBoxes?.get(detectionIndex),
      );
      const key = detectionKey(detection, detectionIndex);
      entriesByDetectionKey.set(key, entry);
      boundsByDetectionKey.set(key, {
        baseX: hitRect.x,
        baseY: hitRect.y,
        ...hitRect,
      });
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
      const boxFrame = getRenderedBoxes?.();
      const matchingBoxFrame = boxFrame?.frame === frame ? boxFrame : undefined;

      if (
        frame === lastFrame &&
        matchingBoxFrame === lastBoxFrame &&
        drawnStyleVersion === styleVersion &&
        resolvedViewportScale === lastViewportScale
      ) {
        return;
      }

      lastFrame = frame;
      lastBoxFrame = matchingBoxFrame;
      drawnStyleVersion = styleVersion;
      lastViewportScale = resolvedViewportScale;

      if (!frame) {
        clearLayout();
        hideEntriesFrom(0);
        syncBackgroundCaptures();
        return;
      }

      redrawFrame(
        frame,
        mediaTime,
        resolvedViewportScale,
        matchingBoxFrame?.rects,
      );
      syncBackgroundCaptures();
    },

    drawCreationPreview(detection, mediaTime, viewportScale, renderedBox) {
      if (!detection || !currentLabelStyle) {
        hideCreationPreview();
        syncBackgroundCaptures();
        return;
      }

      const resolvedViewportScale = viewportScale ?? 1;
      const frame: DetectionFrame = { detections: [detection], mediaTime };
      const instruction = currentLabelStyle.resolve(detection, {
        detectionIndex: 0,
        ...resolveContextState?.(detection),
        ephemeral: false,
        frame,
        isCreating: true,
        mediaTime,
        viewportScale: resolvedViewportScale,
      });

      if (!instruction) {
        hideCreationPreview();
        syncBackgroundCaptures();
        return;
      }

      if (!previewEntry) {
        previewIndex = entries.length;
        previewEntry = createEntry();
      }
      drawInstruction(
        previewEntry,
        instruction,
        resolvedViewportScale,
        renderedBox,
      );
      syncBackgroundCaptures();
    },

    updateEditingBox(id, renderedBox) {
      const key = `id:${String(id)}`;
      const entry = entriesByDetectionKey.get(key);
      const bounds = boundsByDetectionKey.get(key);
      const instruction = entry?.instruction;
      if (!entry || !bounds || !instruction?.background) return;
      const corners = resolveRoundedCorners(
        instruction.background,
        instruction.placement ?? LabelPlacement.Top,
        bounds,
        renderedBox,
        lastViewportScale,
      );
      drawBackground(
        entry,
        instruction.background,
        bounds.baseX,
        bounds.baseY,
        bounds.width,
        bounds.height,
        lastViewportScale,
        corners,
      );
      entry.background.x = bounds.x;
      entry.background.y = bounds.y;
    },

    setLabelStyle(nextLabelStyle) {
      currentLabelStyle = nextLabelStyle ?? undefined;
      styleVersion += 1;
    },

    setBackgroundAntialiasFilter(filter) {
      if (filter === backgroundFilter) return;
      backgroundFilter = filter;
      backgroundFilters = filter ? [filter] : null;
      syncBackgroundCaptures();
    },

    translateDetection(id, x, y) {
      const key = `id:${String(id)}`;
      const entry = entriesByDetectionKey.get(key);
      if (!entry) return false;
      entry.background.x = entry.backgroundBaseX + x;
      entry.background.y = entry.backgroundBaseY + y;
      entry.label.x = entry.labelBaseX + x;
      entry.label.y = entry.labelBaseY + y;
      const bounds = boundsByDetectionKey.get(key);
      if (bounds) {
        boundsByDetectionKey.set(key, {
          ...bounds,
          x: bounds.baseX + x,
          y: bounds.baseY + y,
        });
      }
      syncBackgroundCaptures();
      return true;
    },

    getDetectionLabelBounds(id) {
      const bounds = boundsByDetectionKey.get(`id:${String(id)}`);
      if (!bounds) return null;
      return {
        height: bounds.height,
        width: bounds.width,
        x: bounds.x,
        y: bounds.y,
      };
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
      for (const group of backgroundGroups) {
        group.filters = null;
        if (!group.parent) group.destroy({ children: false });
      }
      backgroundFilter = null;
      backgroundFilters = null;
      hideEntriesFrom(0);
      hideCreationPreview();
      entries.length = 0;
      previewEntry = undefined;
      clearLayout();
      container = undefined;
    },
  };
}

function drawInstruction(
  entry: PixiLabelEntry,
  instruction: LabelDrawInstruction,
  viewportScale: number,
  renderedBox?: Rect,
) {
  entry.instruction = instruction;
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
  entry.textWidth = entry.label.width;
  entry.textHeight = entry.label.height;
  const width = entry.textWidth + paddingX * 2;
  const height = entry.textHeight + paddingY * 2;
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

  const corners = resolveRoundedCorners(
    background,
    instruction.placement ?? LabelPlacement.Top,
    { x, y, width, height },
    renderedBox,
    viewportScale,
  );
  drawBackground(
    entry,
    background,
    x,
    y,
    width,
    height,
    viewportScale,
    corners,
  );
  return { height, width, x, y };
}

function resolveCaptureBounds(
  entry: PixiLabelEntry,
  padding: number,
): LabelCaptureBounds {
  const { background, label } = entry;
  const x = Math.min(
    background.visible ? background.x : Infinity,
    label.visible ? label.x : Infinity,
  );
  const y = Math.min(
    background.visible ? background.y : Infinity,
    label.visible ? label.y : Infinity,
  );
  return {
    height:
      Math.max(
        background.visible ? background.y + entry.backgroundHeight : -Infinity,
        label.visible ? label.y + entry.textHeight : -Infinity,
      ) -
      y +
      padding * 2,
    width:
      Math.max(
        background.visible ? background.x + entry.backgroundWidth : -Infinity,
        label.visible ? label.x + entry.textWidth : -Infinity,
      ) -
      x +
      padding * 2,
    x: x - padding,
    y: y - padding,
  };
}

function rectanglesOverlap(
  left: LabelCaptureBounds,
  right: LabelCaptureBounds,
) {
  return (
    left.x < right.x + right.width &&
    right.x < left.x + left.width &&
    left.y < right.y + right.height &&
    right.y < left.y + left.height
  );
}

function unionCaptureBounds(
  left: LabelCaptureBounds,
  right: LabelCaptureBounds,
): LabelCaptureBounds {
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  return {
    height: Math.max(left.y + left.height, right.y + right.height) - y,
    width: Math.max(left.x + left.width, right.x + right.width) - x,
    x,
    y,
  };
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
  corners: RoundedLabelCorners,
) {
  const graphics = entry.background;
  const backgroundKey = createBackgroundKey(background, corners);

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
  const radius = Math.min(
    (background.cornerRadius ?? 0) / viewportScale,
    width / 2,
    height / 2,
  );

  if (corners === "top" && radius > 0) {
    graphics
      .moveTo(0, height)
      .lineTo(0, radius)
      .quadraticCurveTo(0, 0, radius, 0)
      .lineTo(width - radius, 0)
      .quadraticCurveTo(width, 0, width, radius)
      .lineTo(width, height)
      .closePath();
  } else if (corners === "bottom" && radius > 0) {
    graphics
      .moveTo(0, 0)
      .lineTo(width, 0)
      .lineTo(width, height - radius)
      .quadraticCurveTo(width, height, width - radius, height)
      .lineTo(radius, height)
      .quadraticCurveTo(0, height, 0, height - radius)
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

function resolveRoundedCorners(
  background: LabelBackgroundStyle,
  placement: LabelPlacement,
  label: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
  renderedBox: Rect | undefined,
  viewportScale: number,
): RoundedLabelCorners {
  if (background.topCornersOnly !== undefined) {
    return background.topCornersOnly ? "top" : "all";
  }
  if (!renderedBox) return "all";
  const box = centerRectToTopLeftRect(renderedBox);
  const epsilon = 1e-6 / viewportScale;
  if (
    Math.min(label.x + label.width, box.x + box.width) -
      Math.max(label.x, box.x) <=
    epsilon
  ) {
    return "all";
  }
  switch (placement) {
    case LabelPlacement.Top:
      return Math.abs(label.y + label.height - box.y) <= epsilon
        ? "top"
        : "all";
    case LabelPlacement.Bottom:
      return Math.abs(label.y - box.y - box.height) <= epsilon
        ? "bottom"
        : "all";
    case LabelPlacement.InsideTop:
      return Math.abs(label.y - box.y) <= epsilon ? "bottom" : "all";
    case LabelPlacement.InsideBottom:
      return Math.abs(label.y + label.height - box.y - box.height) <= epsilon
        ? "top"
        : "all";
    case LabelPlacement.Center:
      return "all";
  }
}

function createBackgroundKey(
  background: LabelBackgroundStyle,
  corners: RoundedLabelCorners,
) {
  return [
    background.alpha,
    background.color,
    background.cornerRadius ?? 0,
    background.paddingX ?? 0,
    background.paddingY ?? 0,
    corners,
  ].join(":");
}

function detectionKey(detection: Detection, detectionIndex: number) {
  return detection.id === undefined
    ? `index:${detectionIndex}`
    : `id:${String(detection.id)}`;
}
