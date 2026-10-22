import {
  createDetectionPickKey,
  followDetectionPickAcrossFrames,
  haveSameDetectionPickIdentities,
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
import type { Detection } from "supervision-js-core";
import type {
  DetectionPickOptions,
  DetectionPickPoint,
  DetectionPickResult,
  DetectionSelectionOptions,
  MediaInteractionOptions,
  AnnotationEditingEngine,
  AnnotationPointerInput,
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
  | "globalpointermove"
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
  pointerCancel(pointerId: number): void;
  pointerCaptureLost(pointerId: number): void;
  pointerUpFallback(pointerId: number): void;
  destroy(): void;
}

export function createPixiInteractionLayer(options: {
  readonly Container: ContainerConstructor;
  readonly Rectangle: RectangleConstructor;
  readonly canInteract: () => boolean;
  readonly detectionTimeline: BufferedDetectionTimeline;
  readonly interaction: MediaInteractionOptions;
  readonly canPickDetection?: (detection: Detection) => boolean;
  readonly onStateChange?: (state: PixiInteractionLayerState) => void;
  readonly pickMaskDetectionAtPoint?: (
    point: DetectionPickPoint,
    mediaTime: number,
    pickOptions?: DetectionPickOptions,
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
  let displayDimensions:
    { readonly width: number; readonly height: number } | undefined;
  let currentMediaTime = 0;
  let hoveredPick: DetectionPickResult | null = null;
  let hoveredPickKey: string | null = null;
  let selectedPick: DetectionPickResult | null = null;
  let selectedPicks: DetectionPickResult[] = [];
  let marqueeStart: DetectionPickPoint | null = null;
  let marqueeRect: PixiInteractionLayerState["marqueeRect"] = null;
  let pointerPoint: DetectionPickPoint | null = null;
  let suppressedTap: AnnotationPointerInput | null = null;
  let defaultPress: {
    kind: "editing" | "marquee";
    input: AnnotationPointerInput;
  } | null = null;
  let activeFrame: DetectionFrame | undefined;
  let isDestroyed = false;
  const unsubscribeEditing = options.editingEngine?.subscribe((state) => {
    const press = defaultPress;
    if (press?.kind !== "editing") return;
    if (
      state.kind === AnnotationGestureStateKind.Idle ||
      (press.input.pointerId !== undefined &&
        state.pointerId !== press.input.pointerId)
    )
      retirePress(press);
  });

  return {
    createDisplay({ width, height }) {
      displayDimensions = { width, height };
      container = new options.Container();
      container.eventMode = "static";
      container.cursor = "default";
      container.hitArea = new options.Rectangle(0, 0, width, height);
      container.on("pointermove", handlePointerMove);
      container.on("globalpointermove", handleGlobalPointerMove);
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

      const nextPicks = selection.detectionIds
        ? [...new Set(selection.detectionIds)].flatMap((detectionId) => {
            const pick = createPickFromSelection({
              detectionId,
              mediaTime: selection.mediaTime,
              point: selection.point,
              target: selection.target,
            });
            return pick ? [pick] : [];
          })
        : [createPickFromSelection(selection)].filter(
            (pick): pick is DetectionPickResult => pick !== null,
          );

      setSelectedPicks(nextPicks);

      return nextPicks.at(-1) ?? null;
    },

    getState() {
      return createState();
    },

    cycleSelection(direction = 1) {
      const visibleDetections = activeFrame?.detections.flatMap(
        (detection, detectionIndex) =>
          canPickDetection(detection) ? [{ detection, detectionIndex }] : [],
      );
      if (!activeFrame || !visibleDetections?.length) return null;
      const currentVisibleIndex = visibleDetections.findIndex(
        ({ detectionIndex }) => detectionIndex === selectedPick?.detectionIndex,
      );
      const nextVisibleIndex =
        (currentVisibleIndex + direction + visibleDetections.length) %
        visibleDetections.length;
      const { detection, detectionIndex } =
        visibleDetections[nextVisibleIndex]!;
      const next = createPickFromSelection({
        detectionIndex,
        point: getDetectionCenter(detection),
      });
      setSelectedPick(next);
      return next;
    },

    pointerCancel,
    pointerCaptureLost(pointerId) {
      if (defaultPress) pointerCancel(pointerId);
    },
    pointerUpFallback(pointerId) {
      const press = defaultPress;
      const tap = suppressedTap;
      queueMicrotask(() => {
        if (tap && suppressedTap === tap && samePointer(tap, { pointerId }))
          suppressedTap = null;
        if (
          press &&
          defaultPress === press &&
          press.input.pointerId === pointerId
        ) {
          pointerCancel(pointerId);
        }
      });
    },
    destroy() {
      isDestroyed = true;
      unsubscribeEditing?.();
      if (defaultPress) pointerCancel(defaultPress.input.pointerId);
      suppressedTap = null;
      setHoveredPick(null);
      setSelectedPick(null);
    },
  };

  function handlePointerMove(event: PixiInteractionPointerEvent) {
    if (isOtherPressPointer(event)) return;
    if (!canHandleInteraction()) {
      setHoveredPick(null);
      return;
    }

    const editingEngine = options.editingEngine;
    // Pixi emits local and global moves inside the hit area. Marquees and
    // editing use the global route to keep moving outside.
    if (
      defaultPress?.kind === "marquee" ||
      (editingEngine &&
        editingEngine.getState().kind !== AnnotationGestureStateKind.Idle)
    ) {
      return;
    }

    pointerPoint = getPoint(event);
    updateCursor(pointerPoint);

    const hoverChanged = setHoveredPick(pickFromPointerEvent(event));
    if (!hoverChanged && editingEngine?.hasCreationTool()) {
      notifyStateChange();
    }
  }

  function handleGlobalPointerMove(event: PixiInteractionPointerEvent) {
    if (isOtherPressPointer(event)) return;
    if (defaultPress?.kind === "marquee") {
      if (!canHandleInteraction() || !marqueeStart) return;
      pointerPoint = getPoint(event);
      updateCursor(pointerPoint);
      if (
        Math.hypot(
          pointerPoint.x - marqueeStart.x,
          pointerPoint.y - marqueeStart.y,
        ) >= 4
      ) {
        marqueeRect = rectFromPoints(marqueeStart, pointerPoint);
        options.interaction.onMarqueeChange?.(marqueeRect);
        notifyStateChange();
      }
      return;
    }
    const editingEngine = options.editingEngine;
    const state = editingEngine?.getState();
    if (
      !editingEngine ||
      !state ||
      state.kind === AnnotationGestureStateKind.Idle ||
      !canHandleInteraction() ||
      isOtherEditingPointer(event)
    ) {
      return;
    }

    pointerPoint = getPoint(event);
    updateCursor(pointerPoint);
    editingEngine.pointerMove(toPointerInput(event, pointerPoint));
    notifyStateChange();
  }

  function handlePointerOut() {
    const hadPointer = pointerPoint !== null;
    pointerPoint = null;
    const hoverChanged = setHoveredPick(null);
    if (
      !hoverChanged &&
      hadPointer &&
      options.editingEngine?.hasCreationTool()
    ) {
      notifyStateChange();
    }
  }

  function handlePointerTap(event: PixiInteractionPointerEvent) {
    if (isOtherPressPointer(event) || isOtherEditingPointer(event)) return;
    if (suppressedTap && samePointer(suppressedTap, event)) {
      suppressedTap = null;
      return;
    }
    if (!canHandleInteraction()) {
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
    if (
      !canHandleInteraction() ||
      isOtherPressPointer(event) ||
      isOtherEditingPointer(event)
    )
      return;
    const point = getPoint(event);
    const input = toPointerInput(event, point);
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
        if (event.button === undefined || event.button === 0)
          suppressedTap = input;
        notifyStateChange();
        return;
      }

      // Editing gestures are primary-pointer gestures. Do not suppress a
      // browser's secondary-pointer behavior when there is no vertex-delete
      // action to perform.
      if (event.button !== undefined && event.button !== 0) {
        return;
      }

      if (
        options.interaction.multiSelect &&
        event.shiftKey &&
        pick &&
        !options.editingEngine.hasCreationTool() &&
        options.editingEngine.getState().kind ===
          AnnotationGestureStateKind.Idle
      ) {
        // Selection modifiers must run before the editing engine captures a
        // move. The following pointertap belongs to this same toggle.
        toggleSelectedPick(pick);
        suppressedTap = input;
        return;
      }

      // Keep selection owned by this layer. The editing engine deliberately
      // treats a click as a cancelled move, so it cannot establish selection
      // itself; selecting here also makes resize handles available on the next
      // gesture.
      if (pick && !handle && !options.editingEngine.hasCreationTool()) {
        setSelectedPick(pick);
      }
      const press = { kind: "editing" as const, input };
      defaultPress = press;
      if (handle && selected) {
        options.editingEngine.beginHandleDrag(selected, handle, input);
      } else {
        options.editingEngine.pointerDown(input, pick);
      }
      if (defaultPress === press) capturePress(press);
      suppressedTap = input;
      notifyStateChange();
      return;
    }

    if (options.interaction.multiSelect && !pick) {
      const press = { kind: "marquee" as const, input };
      defaultPress = press;
      marqueeStart = point;
      marqueeRect = null;
      capturePress(press);
    }
  }

  function handlePointerUp(event: PixiInteractionPointerEvent) {
    if (isOtherPressPointer(event) || isOtherEditingPointer(event)) return;
    const press = defaultPress;
    defaultPress = null;
    const completedRect = press?.kind === "marquee" ? marqueeRect : null;
    if (press?.kind === "marquee") {
      marqueeStart = null;
      marqueeRect = null;
    }
    const tap = suppressedTap;
    if (tap && samePointer(tap, event)) {
      queueMicrotask(() => {
        if (suppressedTap === tap) suppressedTap = null;
      });
    }
    const editingEngine = options.editingEngine;
    if (
      editingEngine &&
      editingEngine.getState().kind !== AnnotationGestureStateKind.Idle
    ) {
      editingEngine.pointerUp(toPointerInput(event, getPoint(event)));
      notifyStateChange();
    }
    if (press) releasePress(press);
    if (press?.kind !== "marquee" || defaultPress) return;
    if (completedRect && activeFrame) {
      suppressedTap = press?.input ?? toPointerInput(event, getPoint(event));
      const nextPicks = activeFrame.detections.flatMap(
        (detection, detectionIndex) => {
          if (!canPickDetection(detection)) return [];
          const rect = getDetectionRect(detection);
          if (
            !rect ||
            !matchesMarquee(
              rect,
              completedRect,
              options.interaction.marqueeSelectionMode,
            )
          )
            return [];
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
      setSelectedPicks(nextPicks);
    }
    options.interaction.onMarqueeChange?.(null);
    notifyStateChange();
  }

  function pointerCancel(pointerId?: number) {
    const press = defaultPress;
    if (press && !samePointer(press.input, { pointerId })) return;
    if (press) defaultPress = null;
    const tap = suppressedTap;
    if (press && tap && samePointer(tap, { pointerId })) suppressedTap = null;
    if (press?.kind === "marquee") {
      marqueeStart = null;
      marqueeRect = null;
      options.interaction.onMarqueeChange?.(null);
    }
    const engine = options.editingEngine;
    if (engine?.pointerCancel) engine.pointerCancel(pointerId);
    else if (
      engine &&
      pointerId !== undefined &&
      engine.getState().pointerId === pointerId
    ) {
      engine.cancel();
    }
    if (press) releasePress(press);
    notifyStateChange();
  }

  function samePointer(
    first: Pick<AnnotationPointerInput, "pointerId">,
    second: Pick<AnnotationPointerInput, "pointerId">,
  ) {
    return (
      first.pointerId === undefined ||
      second.pointerId === undefined ||
      first.pointerId === second.pointerId
    );
  }

  function isOtherPressPointer(event: PixiInteractionPointerEvent) {
    return defaultPress !== null && !samePointer(defaultPress.input, event);
  }

  function capturePress(press: NonNullable<typeof defaultPress>) {
    if (press.input.pointerId !== undefined)
      options.capturePointer?.(press.input.pointerId);
  }

  function retirePress(press: NonNullable<typeof defaultPress>) {
    if (defaultPress !== press) return;
    defaultPress = null;
    releasePress(press);
  }

  function releasePress(press: NonNullable<typeof defaultPress>) {
    const pointerId = press.input.pointerId;
    if (
      pointerId !== undefined &&
      defaultPress?.input.pointerId !== pointerId
    ) {
      options.releasePointer?.(pointerId);
    }
  }

  function isOtherEditingPointer(event: PixiInteractionPointerEvent) {
    const pointerId = options.editingEngine?.getState().pointerId;
    return (
      pointerId !== undefined &&
      pointerId !== null &&
      event.pointerId !== undefined &&
      event.pointerId !== pointerId
    );
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
    if (activeLabelPick && canPickDetection(activeLabelPick.detection)) {
      return activeLabelPick;
    }

    const geometryPick = pickDetectionAtPoint(activeFrame, pickPoint, {
      ...options.interaction,
      filter: (detection, detectionIndex) =>
        canPickDetection(detection) &&
        (options.interaction.filter?.(detection, detectionIndex) ?? true),
      includeMasks: options.pickMaskDetectionAtPoint === undefined,
      maskMediaDimensions: options.getMediaDimensions?.(),
      padding: pickPadding,
      viewportScale: options.getViewportScale?.() ?? 1,
    });

    const orderedMasks =
      options.interaction.preferTopmost &&
      options.interaction.maskOrder === "detection";
    if (
      geometryPick &&
      !orderedMasks &&
      (options.interaction.preferTopmost ||
        POINT_PRECISE_PICK_TARGETS.has(geometryPick.target))
    ) {
      return geometryPick;
    }

    const maskPick =
      options.interaction.maskOrder === "detection"
        ? options.pickMaskDetectionAtPoint?.(pickPoint, currentMediaTime, {
            ...options.interaction,
            filter: (detection, detectionIndex) =>
              canPickDetection(detection) &&
              (options.interaction.filter?.(detection, detectionIndex) ?? true),
          })
        : options.pickMaskDetectionAtPoint?.(pickPoint, currentMediaTime);

    const activeMaskPick = rebaseDetectionPickToFrame(
      maskPick ?? null,
      activeFrame,
    );

    if (!activeMaskPick || !canPickDetection(activeMaskPick.detection))
      return geometryPick;
    if (orderedMasks && geometryPick) {
      const maskOrder =
        activeMaskPick.detection.zIndex ?? activeMaskPick.detectionIndex;
      const geometryOrder =
        geometryPick.detection.zIndex ?? geometryPick.detectionIndex;
      if (
        geometryOrder > maskOrder ||
        (geometryOrder === maskOrder &&
          geometryPick.detectionIndex >= activeMaskPick.detectionIndex)
      )
        return geometryPick;
    }
    return activeMaskPick;
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

    if (
      !frame ||
      detectionIndex === undefined ||
      !detection ||
      !canPickDetection(detection)
    ) {
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
    const nextHoveredPick = filterPick(
      rebaseDetectionPickToFrame(hoveredPick, frame),
    );

    if (hoveredPick && !nextHoveredPick) {
      setHoveredPick(null);
    } else if (nextHoveredPick && nextHoveredPick !== hoveredPick) {
      // Hover remains pointer-owned. Refresh its frame snapshot without
      // emitting a second event-driven redraw from the normal frame path.
      hoveredPick = nextHoveredPick;
      hoveredPickKey = createDetectionPickKey(nextHoveredPick);
    }

    followSelectedPicks(frame);
  }

  function followSelectedPicks(frame: DetectionFrame | undefined) {
    // An absent frame means detection data for this time has not arrived, not
    // that the selection left the video, and a dropped selection never returns.
    if (!frame || selectedPicks.length === 0) {
      return;
    }

    const nextSelectedPicks = selectedPicks.flatMap((pick) => {
      const nextPick = filterPick(followDetectionPickAcrossFrames(pick, frame));
      return nextPick ? [nextPick] : [];
    });
    const currentKeys = selectedPicks.map(createDetectionPickKey).join("|");
    const nextKeys = nextSelectedPicks.map(createDetectionPickKey).join("|");
    const identityChanged = !haveSameDetectionPickIdentities(
      selectedPicks,
      nextSelectedPicks,
    );

    selectedPicks = nextSelectedPicks;
    selectedPick = nextSelectedPicks.at(-1) ?? null;

    if (nextKeys === currentKeys) {
      return;
    }

    // A followed pick re-bases onto every new frame, so its full pick key
    // changes at playback rate. The scene's normal frame path consumes this
    // refreshed state immediately; emitting onStateChange here would redraw
    // focus and interaction a second time. Public callbacks only report
    // identity or membership changes.
    if (identityChanged) {
      options.interaction.onSelect?.(selectedPick);
      options.interaction.onSelectionChange?.(selectedPicks);
    }
  }

  function setHoveredPick(nextPick: DetectionPickResult | null) {
    const nextKey = createDetectionPickKey(nextPick);

    if (nextKey === hoveredPickKey) {
      hoveredPick = nextPick;
      if (container && !selectedHandleAt(pointerPoint)) {
        container.cursor = nextPick
          ? hoverCursor(nextPick)
          : resolveIdleCursor();
      }
      return false;
    }

    hoveredPick = nextPick;
    hoveredPickKey = nextKey;
    if (container && !selectedHandleAt(pointerPoint)) {
      container.cursor = nextPick ? hoverCursor(nextPick) : resolveIdleCursor();
    }
    options.interaction.onHover?.(nextPick);
    notifyStateChange();
    return true;
  }

  function setSelectedPick(nextPick: DetectionPickResult | null) {
    setSelectedPicks(nextPick ? [nextPick] : []);
  }

  function setSelectedPicks(nextPicks: DetectionPickResult[]) {
    const unchanged =
      selectedPicks.length === nextPicks.length &&
      selectedPicks.every(
        (pick, index) =>
          createDetectionPickKey(pick) ===
          createDetectionPickKey(nextPicks[index]!),
      );

    selectedPicks = nextPicks;
    selectedPick = nextPicks.at(-1) ?? null;
    if (unchanged) return;

    options.interaction.onSelect?.(selectedPick);
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
    const key = createSelectionKey(pick);
    const index = selectedPicks.findIndex(
      (candidate) => createSelectionKey(candidate) === key,
    );
    setSelectedPicks(
      index >= 0
        ? selectedPicks.filter((_, candidateIndex) => candidateIndex !== index)
        : [...selectedPicks, pick],
    );
  }

  function createSelectionKey(pick: DetectionPickResult) {
    // Selection toggles the detection, regardless of whether its body, label,
    // or keypoint was hit. Keep the picker's frame/index fallback for duplicate ids.
    return createDetectionPickKey({
      ...pick,
      geometryIndex: undefined,
      target: DetectionPickTarget.Box,
    });
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
      mediaDimensions: options.getMediaDimensions?.() ?? displayDimensions,
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
      container.cursor = "move";
      return;
    }
    if (
      editingState?.kind === AnnotationGestureStateKind.Resizing &&
      selectedPick
    ) {
      // Keep the grabbed handle's cursor for the whole drag.
      const active = getAnnotationHandles(
        selectedPick.detection,
        options.getViewportScale?.() ?? 1,
      ).find((handle) => handle.id === editingState.activeHandleId);
      if (active) {
        container.cursor = active.cursor;
        return;
      }
    }
    const handle = selectedHandleAt(point);
    container.cursor =
      handle?.cursor ??
      (hoveredPick ? hoverCursor(hoveredPick) : resolveIdleCursor());
  }

  /** Editable geometry drags, so it advertises `move`; a keypoint is a point target. */
  function hoverCursor(pick: DetectionPickResult) {
    if (!options.editingEngine || pick.detection.locked || pick.detection.mask)
      return "pointer";
    return pick.target === DetectionPickTarget.Keypoint ? "pointer" : "move";
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

  function canPickDetection(detection: Detection) {
    return options.canPickDetection?.(detection) ?? true;
  }

  function filterPick(pick: DetectionPickResult | null) {
    return pick && canPickDetection(pick.detection) ? pick : null;
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

function matchesMarquee(
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
  mode: "intersects" | "contained" | undefined,
) {
  const { x: left, y: top } = centerRectToTopLeftRect(rect);
  if (mode === "contained") {
    return (
      left >= marquee.x &&
      left + rect.width <= marquee.x + marquee.width &&
      top >= marquee.y &&
      top + rect.height <= marquee.y + marquee.height
    );
  }
  return (
    left <= marquee.x + marquee.width &&
    left + rect.width >= marquee.x &&
    top <= marquee.y + marquee.height &&
    top + rect.height >= marquee.y
  );
}
