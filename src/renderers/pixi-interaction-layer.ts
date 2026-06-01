import {
  createDetectionPickKey,
  pickDetectionAtPoint,
} from "#interactions/detection-picker";
import type { BufferedDetectionTimeline } from "#types/detection-timeline";
import type {
  DetectionPickPoint,
  DetectionPickResult,
  MediaInteractionOptions,
} from "#types/interaction";
import { MediaInteractionMode } from "#types/interaction";

const DEFAULT_PICK_PADDING = 4;
const HOVER_STROKE_COLOR = 0x67e8f9;
const SELECTED_STROKE_COLOR = 0xfde047;

type ContainerConstructor = new () => PixiInteractionContainer;
type GraphicsConstructor = new () => PixiInteractionGraphics;
type RectangleConstructor = new (
  x: number,
  y: number,
  width: number,
  height: number,
) => unknown;

type InteractionEventName = "pointermove" | "pointerout" | "pointertap";

type PixiInteractionContainer = {
  cursor?: string;
  eventMode?: string;
  hitArea?: unknown;
  addChild(...children: unknown[]): unknown;
  on(
    eventName: InteractionEventName,
    handler: (event: PixiInteractionPointerEvent) => void,
  ): unknown;
};

type PixiInteractionGraphics = {
  clear(): PixiInteractionGraphics;
  fill(options: { readonly alpha: number; readonly color: number }): unknown;
  rect(
    x: number,
    y: number,
    width: number,
    height: number,
  ): PixiInteractionGraphics;
  stroke(options: {
    readonly alpha: number;
    readonly color: number;
    readonly width: number;
  }): unknown;
};

type PixiInteractionPointerEvent = {
  getLocalPosition(container: PixiInteractionContainer): DetectionPickPoint;
};

export interface PixiInteractionLayerState {
  readonly hoveredPick: DetectionPickResult | null;
  readonly selectedPick: DetectionPickResult | null;
}

export interface PixiInteractionLayer {
  createDisplay(dimensions: {
    readonly width: number;
    readonly height: number;
  }): PixiInteractionContainer;
  drawFrame(mediaTime: number): void;
  getState(): PixiInteractionLayerState;
  destroy(): void;
}

export function createPixiInteractionLayer(options: {
  readonly Container: ContainerConstructor;
  readonly Graphics: GraphicsConstructor;
  readonly Rectangle: RectangleConstructor;
  readonly canInteract: () => boolean;
  readonly detectionTimeline: BufferedDetectionTimeline;
  readonly interaction: MediaInteractionOptions;
}): PixiInteractionLayer {
  const mode = options.interaction.mode ?? MediaInteractionMode.PausedOnly;
  const pickPadding = options.interaction.padding ?? DEFAULT_PICK_PADDING;
  let container: PixiInteractionContainer | undefined;
  let highlightGraphics: PixiInteractionGraphics | undefined;
  let currentMediaTime = 0;
  let hoveredPick: DetectionPickResult | null = null;
  let hoveredPickKey: string | null = null;
  let selectedPick: DetectionPickResult | null = null;
  let selectedPickKey: string | null = null;
  let isDestroyed = false;

  return {
    createDisplay({ width, height }) {
      container = new options.Container();
      highlightGraphics = new options.Graphics();
      container.eventMode = "static";
      container.cursor = "default";
      container.hitArea = new options.Rectangle(0, 0, width, height);
      container.addChild(highlightGraphics);
      container.on("pointermove", handlePointerMove);
      container.on("pointerout", handlePointerOut);
      container.on("pointertap", handlePointerTap);

      return container;
    },

    drawFrame(mediaTime) {
      currentMediaTime = mediaTime;

      if (!canHandleInteraction()) {
        setHoveredPick(null);
        setSelectedPick(null);
      }

      redrawHighlights();
    },

    getState() {
      return {
        hoveredPick,
        selectedPick,
      };
    },

    destroy() {
      isDestroyed = true;
      setHoveredPick(null);
      setSelectedPick(null);
      highlightGraphics?.clear();
    },
  };

  function handlePointerMove(event: PixiInteractionPointerEvent) {
    if (!canHandleInteraction()) {
      setHoveredPick(null);
      return;
    }

    setHoveredPick(pickFromPointerEvent(event));
  }

  function handlePointerOut() {
    setHoveredPick(null);
  }

  function handlePointerTap(event: PixiInteractionPointerEvent) {
    if (!canHandleInteraction()) {
      return;
    }

    setSelectedPick(pickFromPointerEvent(event));
  }

  function pickFromPointerEvent(event: PixiInteractionPointerEvent) {
    if (!container) {
      return null;
    }

    const point = event.getLocalPosition(container) as DetectionPickPoint;

    return pickDetectionAtPoint(
      options.detectionTimeline.selectFrame(currentMediaTime),
      { x: point.x, y: point.y },
      { padding: pickPadding },
    );
  }

  function setHoveredPick(nextPick: DetectionPickResult | null) {
    const nextKey = createDetectionPickKey(nextPick);

    if (nextKey === hoveredPickKey) {
      return;
    }

    hoveredPick = nextPick;
    hoveredPickKey = nextKey;
    if (container) {
      container.cursor = nextPick ? "pointer" : "default";
    }
    options.interaction.onHover?.(nextPick);
    redrawHighlights();
  }

  function setSelectedPick(nextPick: DetectionPickResult | null) {
    const nextKey = createDetectionPickKey(nextPick);

    if (nextKey === selectedPickKey) {
      return;
    }

    selectedPick = nextPick;
    selectedPickKey = nextKey;
    options.interaction.onSelect?.(nextPick);
    redrawHighlights();
  }

  function redrawHighlights() {
    if (!highlightGraphics) {
      return;
    }

    highlightGraphics.clear();

    if (!hoveredPick && !selectedPick) {
      return;
    }

    const activeFrame = options.detectionTimeline.selectFrame(currentMediaTime);

    drawPickHighlight(selectedPick, selectedPickKey, activeFrame, {
      alpha: 0.18,
      strokeAlpha: 1,
      strokeColor: SELECTED_STROKE_COLOR,
      strokeWidth: 4,
    });
    drawPickHighlight(hoveredPick, hoveredPickKey, activeFrame, {
      alpha: 0.1,
      strokeAlpha: 0.95,
      strokeColor: HOVER_STROKE_COLOR,
      strokeWidth: 3,
    });
  }

  function drawPickHighlight(
    pick: DetectionPickResult | null,
    pickKey: string | null,
    activeFrame: ReturnType<BufferedDetectionTimeline["selectFrame"]>,
    style: {
      readonly alpha: number;
      readonly strokeAlpha: number;
      readonly strokeColor: number;
      readonly strokeWidth: number;
    },
  ) {
    if (
      !highlightGraphics ||
      !pick ||
      !pick.detection.rect ||
      createDetectionPickKey(pick) !== pickKey ||
      activeFrame !== pick.frame
    ) {
      return;
    }

    const rect = pick.detection.rect;

    highlightGraphics.rect(rect.x, rect.y, rect.width, rect.height).fill({
      alpha: style.alpha,
      color: style.strokeColor,
    });
    highlightGraphics.stroke({
      alpha: style.strokeAlpha,
      color: style.strokeColor,
      width: style.strokeWidth,
    });
  }

  function canHandleInteraction() {
    if (isDestroyed || mode === MediaInteractionMode.Disabled) {
      return false;
    }

    if (mode === MediaInteractionMode.Always) {
      return true;
    }

    return options.canInteract();
  }
}
