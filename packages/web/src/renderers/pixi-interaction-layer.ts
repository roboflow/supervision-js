import {
  createDetectionPickKey,
  followDetectionPickAcrossFrames,
  pickDetectionAtPoint,
  rebaseDetectionPickToFrame,
  getDetectionRect,
  getAnnotationHandles,
  pickAnnotationHandle,
  AnnotationGestureStateKind,
  AnnotationHandleKind,
  centerRectToTopLeftRect,
} from "supervision-js-core";
import type { BufferedDetectionTimeline } from "supervision-js-core";
import type { DetectionFrame } from "supervision-js-core";
import type {
  DetectionPickPoint,
  DetectionPickResult,
  DetectionSelectionOptions,
  MediaInteractionOptions,
  AnnotationEditingEngine,
} from "supervision-js-core";
import { DetectionPickTarget, MediaInteractionMode } from "supervision-js-core";

const DEFAULT_PICK_PADDING = 4;
const POINT_PRECISE_PICK_TARGETS = new Set([
  DetectionPickTarget.Keypoint,
  DetectionPickTarget.Edge,
  DetectionPickTarget.Polyline,
]);

type ContainerConstructor = new () => PixiInteractionContainer;
type RectangleConstructor = new (
  x: number,
  y: number,
  width: number,
  height: number,
) => unknown;

type InteractionEventName =
  | "pointermove"
  | "pointerout"
  | "pointertap"
  | "pointerdown"
  | "pointerup"
  | "pointerupoutside";

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
  readonly shiftKey?: boolean;
  readonly pointerId?: number;
  readonly button?: number;
  readonly detail?: number;
  readonly timeStamp?: number;
};

export interface PixiInteractionLayerState {
  readonly hoveredPick: DetectionPickResult | null;
  readonly selectedPick: DetectionPickResult | null;
  readonly selectedPicks: readonly DetectionPickResult[];
  readonly marqueeRect: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  } | null;
  readonly pointerPoint: DetectionPickPoint | null;
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
  cycleSelection(direction?: 1 | -1): DetectionPickResult | null;
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
  readonly pickLabelDetectionAtPoint?: (
    point: DetectionPickPoint,
    mediaTime: number,
  ) => DetectionPickResult | null;
  readonly editingEngine?: AnnotationEditingEngine;
  readonly getViewportScale?: () => number;
  readonly getMediaDimensions?: () => {
    readonly width: number;
    readonly height: number;
  };
  readonly capturePointer?: (pointerId: number) => void;
  readonly releasePointer?: (pointerId: number) => void;
}): PixiInteractionLayer {
  const mode = options.interaction.mode ?? MediaInteractionMode.PausedOnly;
  const pickPadding = options.interaction.padding ?? DEFAULT_PICK_PADDING;
  let container: PixiInteractionContainer | undefined;
  let currentMediaTime = 0;
  let hoveredPick: DetectionPickResult | null = null;
  let hoveredPickKey: string | null = null;
  let selectedPick: DetectionPickResult | null = null;
  let selectedPickKey: string | null = null;
  let selectedPicks: DetectionPickResult[] = [];
  let marqueeStart: DetectionPickPoint | null = null;
  let marqueeRect: PixiInteractionLayerState["marqueeRect"] = null;
  let didDragMarquee = false;
  let pointerPoint: DetectionPickPoint | null = null;
  let suppressNextTap = false;
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
      container.on("pointerdown", handlePointerDown);
      container.on("pointerup", handlePointerUp);
      container.on("pointerupoutside", handlePointerUp);

      return container;
    },

    drawFrame(mediaTime) {
      currentMediaTime = mediaTime;
      activeFrame = options.detectionTimeline.selectFrame(mediaTime);

      if (canHandleInteraction()) {
        clearStalePicks(activeFrame);
        return;
      }

      pointerPoint = null;
      marqueeRect = null;
      setHoveredPick(null);

      if (isDestroyed || mode === MediaInteractionMode.Disabled) {
        setSelectedPick(null);
        return;
      }

      // Paused-only interaction gates new picks during playback, but an
      // existing selection keeps following its detection so selection-driven
      // presentation such as focus survives frame advances.
      followSelectedPicks(activeFrame);
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
      return createState();
    },

    cycleSelection(direction = 1) {
      if (!activeFrame?.detections.length) return null;
      const currentIndex =
        selectedPick?.detectionIndex ?? (direction > 0 ? -1 : 0);
      const nextIndex =
        (currentIndex + direction + activeFrame.detections.length) %
        activeFrame.detections.length;
      const detection = activeFrame.detections[nextIndex]!;
      const next = createPickFromSelection({
        detectionIndex: nextIndex,
        point: getDetectionCenter(detection),
      });
      setSelectedPick(next);
      return next;
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

    pointerPoint = getPoint(event);
    updateCursor(pointerPoint);
    const editingEngine = options.editingEngine;
    if (
      editingEngine &&
      editingEngine.getState().kind !== AnnotationGestureStateKind.Idle
    ) {
      editingEngine.pointerMove(toPointerInput(event, pointerPoint));
      notifyStateChange();
      return;
    }

    if (marqueeStart) {
      const point = getPoint(event);
      if (Math.hypot(point.x - marqueeStart.x, point.y - marqueeStart.y) >= 4) {
        didDragMarquee = true;
        marqueeRect = rectFromPoints(marqueeStart, point);
        options.interaction.onMarqueeChange?.(marqueeRect);
        notifyStateChange();
      }
      return;
    }
    setHoveredPick(pickFromPointerEvent(event));
  }

  function handlePointerOut() {
    pointerPoint = null;
    setHoveredPick(null);
  }

  function handlePointerTap(event: PixiInteractionPointerEvent) {
    if (!canHandleInteraction()) {
      return;
    }

    if (suppressNextTap) {
      suppressNextTap = false;
      return;
    }

    if (didDragMarquee) {
      didDragMarquee = false;
      return;
    }
    const pick = pickFromPointerEvent(event);
    if (options.interaction.multiSelect && event.shiftKey) {
      toggleSelectedPick(pick);
    } else {
      setSelectedPick(pick);
    }
  }

  function handlePointerDown(event: PixiInteractionPointerEvent) {
    if (!canHandleInteraction()) return;
    const point = getPoint(event);
    pointerPoint = point;
    const pick = pickFromPointerEvent(event);
    const selected = selectedPick?.detection;
    const handle = selected
      ? pickAnnotationHandle(
          getAnnotationHandles(selected, options.getViewportScale?.() ?? 1),
          point,
        )
      : undefined;

    if (
      options.editingEngine &&
      (handle || pick || options.editingEngine.hasCreationTool())
    ) {
      if (
        handle?.kind === AnnotationHandleKind.Vertex &&
        handle.geometryIndex !== undefined &&
        selected &&
        (event.button === 2 || event.shiftKey)
      ) {
        options.editingEngine.deleteVertex(selected, handle.geometryIndex);
        suppressNextTap = event.button === undefined || event.button === 0;
        notifyStateChange();
        return;
      }

      // Editing gestures are primary-pointer gestures. Do not suppress a
      // browser's secondary-pointer behavior when there is no vertex-delete
      // action to perform.
      if (event.button !== undefined && event.button !== 0) {
        return;
      }

      // Keep selection owned by this layer. The editing engine deliberately
      // treats a click as a cancelled move, so it cannot establish selection
      // itself; selecting here also makes resize handles available on the next
      // gesture.
      if (pick && !handle && !options.editingEngine.hasCreationTool()) {
        setSelectedPick(pick);
      }
      if (event.pointerId !== undefined) {
        options.capturePointer?.(event.pointerId);
      }
      const input = toPointerInput(event, point);
      if (handle && selected) {
        options.editingEngine.beginHandleDrag(selected, handle, input);
      } else {
        options.editingEngine.pointerDown(input, pick);
      }
      suppressNextTap = true;
      notifyStateChange();
      return;
    }

    if (options.interaction.multiSelect && !pick) {
      marqueeStart = getPoint(event);
      didDragMarquee = false;
    }
  }

  function handlePointerUp(event: PixiInteractionPointerEvent) {
    const editingEngine = options.editingEngine;
    if (
      editingEngine &&
      editingEngine.getState().kind !== AnnotationGestureStateKind.Idle
    ) {
      editingEngine.pointerUp(toPointerInput(event, getPoint(event)));
      if (event.pointerId !== undefined) {
        options.releasePointer?.(event.pointerId);
      }
      notifyStateChange();
    }
    if (!marqueeStart) return;
    if (didDragMarquee && marqueeRect && activeFrame) {
      selectedPicks = activeFrame.detections.flatMap(
        (detection, detectionIndex) => {
          const rect = getDetectionRect(detection);
          if (!rect || !intersects(rect, marqueeRect!)) return [];
          return [
            {
              detection,
              detectionIndex,
              frame: activeFrame!,
              mediaTime: activeFrame!.mediaTime,
              point: getDetectionCenter(detection),
              target: detection.mask
                ? DetectionPickTarget.Mask
                : detection.polygon
                  ? DetectionPickTarget.Polygon
                  : DetectionPickTarget.Box,
            },
          ];
        },
      );
      selectedPick = selectedPicks.at(-1) ?? null;
      selectedPickKey = createDetectionPickKey(selectedPick);
      options.interaction.onSelect?.(selectedPick);
      options.interaction.onSelectionChange?.(selectedPicks);
    }
    marqueeStart = null;
    marqueeRect = null;
    options.interaction.onMarqueeChange?.(null);
    notifyStateChange();
  }

  function pickFromPointerEvent(event: PixiInteractionPointerEvent) {
    if (!container) {
      return null;
    }

    const point = getPoint(event);
    const pickPoint = { x: point.x, y: point.y };

    const labelPick = options.pickLabelDetectionAtPoint?.(
      pickPoint,
      currentMediaTime,
    );
    const activeLabelPick = rebaseDetectionPickToFrame(
      labelPick ?? null,
      activeFrame,
    );
    if (activeLabelPick) return activeLabelPick;

    const geometryPick = pickDetectionAtPoint(activeFrame, pickPoint, {
      ...options.interaction,
      includeMasks: options.pickMaskDetectionAtPoint === undefined,
      maskMediaDimensions: options.getMediaDimensions?.(),
      padding: pickPadding,
    });

    if (geometryPick && POINT_PRECISE_PICK_TARGETS.has(geometryPick.target)) {
      return geometryPick;
    }

    const maskPick = options.pickMaskDetectionAtPoint?.(
      pickPoint,
      currentMediaTime,
    );

    const activeMaskPick = rebaseDetectionPickToFrame(
      maskPick ?? null,
      activeFrame,
    );

    return activeMaskPick ?? geometryPick;
  }

  function createPickFromSelection(
    selection: DetectionSelectionOptions,
  ): DetectionPickResult | null {
    const frame =
      selection.mediaTime === undefined
        ? activeFrame
        : options.detectionTimeline.selectFrame(selection.mediaTime);
    const detectionIndex =
      selection.detectionId === undefined
        ? selection.detectionIndex
        : frame?.detections.findIndex(
            (detection) => detection.id === selection.detectionId,
          );
    const detection =
      detectionIndex === undefined || detectionIndex < 0
        ? undefined
        : frame?.detections[detectionIndex];

    if (!frame || detectionIndex === undefined || !detection) {
      return null;
    }

    return {
      detection,
      detectionIndex,
      frame,
      mediaTime: frame.mediaTime,
      point: selection.point ?? getDetectionCenter(detection),
      target:
        selection.target ??
        (detection.mask ? DetectionPickTarget.Mask : DetectionPickTarget.Box),
    };
  }

  function clearStalePicks(frame: DetectionFrame | undefined) {
    // Hover stays bound to the pointer, so it keeps a per-frame lifetime.
    const nextHoveredPick = rebaseDetectionPickToFrame(hoveredPick, frame);

    if (hoveredPick && !nextHoveredPick) {
      setHoveredPick(null);
    } else if (nextHoveredPick && nextHoveredPick !== hoveredPick) {
      setHoveredPick(nextHoveredPick);
    }

    followSelectedPicks(frame);
  }

  function followSelectedPicks(frame: DetectionFrame | undefined) {
    if (selectedPicks.length === 0) {
      return;
    }

    const nextSelectedPicks = selectedPicks.flatMap((pick) => {
      const nextPick = followDetectionPickAcrossFrames(pick, frame);
      return nextPick ? [nextPick] : [];
    });
    const currentKeys = selectedPicks.map(createDetectionPickKey).join("|");
    const nextKeys = nextSelectedPicks.map(createDetectionPickKey).join("|");
    const identityChanged =
      selectionIdentityKey(selectedPicks) !==
      selectionIdentityKey(nextSelectedPicks);

    selectedPicks = nextSelectedPicks;
    selectedPick = nextSelectedPicks.at(-1) ?? null;

    if (nextKeys === currentKeys) {
      return;
    }

    selectedPickKey = createDetectionPickKey(selectedPick);
    // A followed pick re-bases onto every new frame, so its full pick key
    // changes at playback rate. That per-frame refresh stays internal via
    // onStateChange; the public selection callbacks only report identity or
    // membership changes.
    if (identityChanged) {
      options.interaction.onSelect?.(selectedPick);
      options.interaction.onSelectionChange?.(selectedPicks);
    }

    notifyStateChange();
  }

  /**
   * Frame-independent identity of a selection: which detections are selected,
   * regardless of which frame snapshot currently backs their picks.
   */
  function selectionIdentityKey(picks: readonly DetectionPickResult[]) {
    return picks
      .map((pick) =>
        pick.detection.id === undefined
          ? `index:${pick.detectionIndex}`
          : `id:${String(pick.detection.id)}`,
      )
      .join("|");
  }

  function setHoveredPick(nextPick: DetectionPickResult | null) {
    const nextKey = createDetectionPickKey(nextPick);

    if (nextKey === hoveredPickKey) {
      hoveredPick = nextPick;
      if (container) {
        if (!selectedHandleAt(pointerPoint)) {
          container.cursor = nextPick ? "pointer" : resolveIdleCursor();
        }
      }
      return;
    }

    hoveredPick = nextPick;
    hoveredPickKey = nextKey;
    if (container) {
      if (!selectedHandleAt(pointerPoint)) {
        container.cursor = nextPick ? "pointer" : resolveIdleCursor();
      }
    }
    options.interaction.onHover?.(nextPick);
    notifyStateChange();
  }

  function setSelectedPick(nextPick: DetectionPickResult | null) {
    const nextKey = createDetectionPickKey(nextPick);

    if (nextKey === selectedPickKey) {
      selectedPick = nextPick;
      return;
    }

    selectedPick = nextPick;
    selectedPicks = nextPick ? [nextPick] : [];
    selectedPickKey = nextKey;
    options.interaction.onSelect?.(nextPick);
    options.interaction.onSelectionChange?.(selectedPicks);
    notifyStateChange();
  }

  function notifyStateChange() {
    options.onStateChange?.(createState());
  }

  function createState(): PixiInteractionLayerState {
    const result = { hoveredPick, selectedPick } as PixiInteractionLayerState;
    Object.defineProperties(result, {
      marqueeRect: { enumerable: false, value: marqueeRect },
      pointerPoint: { enumerable: false, value: pointerPoint },
      selectedPicks: { enumerable: false, value: selectedPicks },
    });
    return result;
  }

  function toggleSelectedPick(pick: DetectionPickResult | null) {
    if (!pick) return;
    const key = createDetectionPickKey(pick);
    const index = selectedPicks.findIndex(
      (candidate) => createDetectionPickKey(candidate) === key,
    );
    selectedPicks =
      index >= 0
        ? selectedPicks.filter((_, candidateIndex) => candidateIndex !== index)
        : [...selectedPicks, pick];
    selectedPick = selectedPicks.at(-1) ?? null;
    selectedPickKey = createDetectionPickKey(selectedPick);
    options.interaction.onSelect?.(selectedPick);
    options.interaction.onSelectionChange?.(selectedPicks);
    notifyStateChange();
  }

  function getPoint(event: PixiInteractionPointerEvent) {
    if (!container) return { x: 0, y: 0 };
    const point = event.getLocalPosition(container);
    return { x: point.x, y: point.y };
  }

  function toPointerInput(
    event: PixiInteractionPointerEvent,
    point: DetectionPickPoint,
  ) {
    return {
      button: event.button,
      detail: event.detail,
      point,
      pointerId: event.pointerId,
      shiftKey: event.shiftKey,
      timestamp: event.timeStamp ?? Date.now(),
    };
  }

  function selectedHandleAt(point: DetectionPickPoint | null) {
    if (!point || !selectedPick) return undefined;
    return pickAnnotationHandle(
      getAnnotationHandles(
        selectedPick.detection,
        options.getViewportScale?.() ?? 1,
      ),
      point,
    );
  }

  function updateCursor(point: DetectionPickPoint) {
    if (!container) return;
    const editingState = options.editingEngine?.getState();
    if (editingState?.kind === AnnotationGestureStateKind.Moving) {
      container.cursor = "grabbing";
      return;
    }
    const handle = selectedHandleAt(point);
    container.cursor =
      handle?.cursor ?? (hoveredPick ? "pointer" : resolveIdleCursor());
  }

  function resolveIdleCursor() {
    return options.editingEngine?.hasCreationTool() ? "crosshair" : "default";
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
  const rect = getDetectionRect(detection);
  if (!rect) {
    return { x: 0, y: 0 };
  }

  return {
    x: rect.x,
    y: rect.y,
  };
}

function rectFromPoints(start: DetectionPickPoint, end: DetectionPickPoint) {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  return {
    x,
    y,
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

function intersects(
  rect: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
  marquee: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
) {
  const { x: left, y: top } = centerRectToTopLeftRect(rect);
  return (
    left <= marquee.x + marquee.width &&
    left + rect.width >= marquee.x &&
    top <= marquee.y + marquee.height &&
    top + rect.height >= marquee.y
  );
}
