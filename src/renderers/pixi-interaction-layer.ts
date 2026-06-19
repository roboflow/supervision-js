import {
  createDetectionPickKey,
  pickDetectionAtPoint,
} from "#interactions/detection-picker";
import type { BufferedDetectionTimeline } from "#types/detection-timeline";
import type { DetectionFrame } from "#types/detections";
import type {
  DetectionPickPoint,
  DetectionPickResult,
  DetectionSelectionOptions,
  MediaInteractionOptions,
} from "#types/interaction";
import { DetectionPickTarget, MediaInteractionMode } from "#types/interaction";

const DEFAULT_PICK_PADDING = 4;

type ContainerConstructor = new () => PixiInteractionContainer;
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
  setSelectedDetection(
    selection: DetectionSelectionOptions | null,
  ): DetectionPickResult | null;
  getState(): PixiInteractionLayerState;
  destroy(): void;
}

export function createPixiInteractionLayer(options: {
  readonly Container: ContainerConstructor;
  readonly Rectangle: RectangleConstructor;
  readonly canInteract: () => boolean;
  readonly detectionTimeline: BufferedDetectionTimeline;
  readonly interaction: MediaInteractionOptions;
  readonly onStateChange?: (state: PixiInteractionLayerState) => void;
  readonly pickMaskDetectionAtPoint?: (
    point: DetectionPickPoint,
    mediaTime: number,
  ) => DetectionPickResult | null;
}): PixiInteractionLayer {
  const mode = options.interaction.mode ?? MediaInteractionMode.PausedOnly;
  const pickPadding = options.interaction.padding ?? DEFAULT_PICK_PADDING;
  let container: PixiInteractionContainer | undefined;
  let currentMediaTime = 0;
  let hoveredPick: DetectionPickResult | null = null;
  let hoveredPickKey: string | null = null;
  let selectedPick: DetectionPickResult | null = null;
  let selectedPickKey: string | null = null;
  let activeFrame: DetectionFrame | undefined;
  let isDestroyed = false;

  return {
    createDisplay({ width, height }) {
      container = new options.Container();
      container.eventMode = "static";
      container.cursor = "default";
      container.hitArea = new options.Rectangle(0, 0, width, height);
      container.on("pointermove", handlePointerMove);
      container.on("pointerout", handlePointerOut);
      container.on("pointertap", handlePointerTap);

      return container;
    },

    drawFrame(mediaTime) {
      currentMediaTime = mediaTime;
      activeFrame = options.detectionTimeline.selectFrame(mediaTime);

      if (!canHandleInteraction()) {
        setHoveredPick(null);
        setSelectedPick(null);
      } else {
        clearStalePicks(activeFrame);
      }
    },

    setSelectedDetection(selection) {
      if (selection === null) {
        setSelectedPick(null);
        return null;
      }

      if (!canHandleInteraction()) {
        setSelectedPick(null);
        return null;
      }

      const nextPick = createPickFromSelection(selection);

      setSelectedPick(nextPick);

      return nextPick;
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
    const pickPoint = { x: point.x, y: point.y };

    const maskPick = options.pickMaskDetectionAtPoint?.(
      pickPoint,
      currentMediaTime,
    );

    if (maskPick && maskPick.frame === activeFrame) {
      return maskPick;
    }

    return pickDetectionAtPoint(activeFrame, pickPoint, {
      padding: pickPadding,
    });
  }

  function createPickFromSelection(
    selection: DetectionSelectionOptions,
  ): DetectionPickResult | null {
    const frame =
      selection.mediaTime === undefined
        ? activeFrame
        : options.detectionTimeline.selectFrame(selection.mediaTime);
    const detection = frame?.detections[selection.detectionIndex];

    if (!frame || !detection) {
      return null;
    }

    return {
      detection,
      detectionIndex: selection.detectionIndex,
      frame,
      mediaTime: frame.mediaTime,
      point: selection.point ?? getDetectionCenter(detection),
      target:
        selection.target ??
        (detection.mask ? DetectionPickTarget.Mask : DetectionPickTarget.Box),
    };
  }

  function clearStalePicks(frame: DetectionFrame | undefined) {
    if (hoveredPick && hoveredPick.frame !== frame) {
      setHoveredPick(null);
    }

    if (selectedPick && selectedPick.frame !== frame) {
      setSelectedPick(null);
    }
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
    notifyStateChange();
  }

  function setSelectedPick(nextPick: DetectionPickResult | null) {
    const nextKey = createDetectionPickKey(nextPick);

    if (nextKey === selectedPickKey) {
      return;
    }

    selectedPick = nextPick;
    selectedPickKey = nextKey;
    options.interaction.onSelect?.(nextPick);
    notifyStateChange();
  }

  function notifyStateChange() {
    options.onStateChange?.({
      hoveredPick,
      selectedPick,
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

function getDetectionCenter(
  detection: DetectionPickResult["detection"],
): DetectionPickPoint {
  if (!detection.rect) {
    return { x: 0, y: 0 };
  }

  return {
    x: detection.rect.x + detection.rect.width / 2,
    y: detection.rect.y + detection.rect.height / 2,
  };
}
