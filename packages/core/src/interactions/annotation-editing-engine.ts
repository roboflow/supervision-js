import {
  AnnotationGeometryKind,
  AnnotationGestureStateKind,
  AnnotationHandleKind,
  type AnnotationCreationTool,
  type AnnotationEditingEngineOptions,
  type AnnotationEditingState,
  type AnnotationHandleDefinition,
  type AnnotationPointerInput,
  type ConfiguredAnnotationEditingEngine,
} from "#types/editing";
import {
  createOrientedBoxGeometry,
  getOrientedRectangleGeometry,
} from "#utils/oriented-rectangle";
import type { Detection, Point, Rect } from "#types/detections";
import type { DetectionPickResult } from "#types/interaction";
import {
  applyAnnotationHandleDrag,
  deleteAnnotationVertex,
  getAnnotationHandles,
  offsetDetection,
} from "#interactions/annotation-handles";

const MOVE_THRESHOLD = 4;
const CLICK_CANCEL_MS = 250;
const CLICK_CANCEL_DIAGONAL = 25;
const CLOSE_ZONE_SCREEN_PX = 12;

type ActiveGesture =
  | {
      kind: "box";
      start: AnnotationPointerInput;
      current: AnnotationPointerInput;
    }
  | {
      kind: "path";
      points: Point[];
      lastTimestamp: number | null;
      press: AnnotationPointerInput | null;
    }
  | {
      kind: "freehand";
      points: Point[];
      start: AnnotationPointerInput;
      current: AnnotationPointerInput;
    }
  | {
      kind: "move";
      detection: Detection;
      start: AnnotationPointerInput;
      current: AnnotationPointerInput;
      moved: boolean;
    }
  | {
      kind: "resize";
      detection: Detection;
      handle: AnnotationHandleDefinition;
      start: AnnotationPointerInput;
      current: AnnotationPointerInput;
      moved: boolean;
    };

export function createAnnotationEditingEngine(
  options: AnnotationEditingEngineOptions = {},
): ConfiguredAnnotationEditingEngine {
  let tool: AnnotationCreationTool | null = null;
  let gesture: ActiveGesture | null = null;
  let state: AnnotationEditingState = idleState();
  const stateListeners = new Set<(state: AnnotationEditingState) => void>();
  const fastTranslateListeners = new Set<
    (id: string | number, dx: number, dy: number) => void
  >();

  return {
    getState: () => state,
    getHandles: (detection, viewportScale = scale()) =>
      getAnnotationHandles(detection, viewportScale, options),
    setModifiers(modifiers) {
      if (
        gesture?.kind !== "resize" ||
        !gesture.moved ||
        gesture.handle.kind !== AnnotationHandleKind.Rotate
      )
        return;
      const active = (gesture = {
        ...gesture,
        current: {
          ...gesture.current,
          shiftKey: modifiers.shiftKey ?? false,
          altKey: modifiers.altKey ?? false,
          ctrlKey: modifiers.ctrlKey ?? false,
          metaKey: modifiers.metaKey ?? false,
        },
      });
      setPreview(resolveHandlePreview(active, active.current), active);
    },
    setCreationTool(nextTool) {
      if (nextTool === tool) return;
      tool = nextTool;
      if (gesture) cancel();
    },
    pointerDown(input, pick = null) {
      if (isOtherPointer(input)) return;
      if (input.button !== undefined && input.button !== 0) return;
      if (tool) {
        beginCreation(input);
      } else if (pick && !pick.detection.locked && !pick.detection.mask) {
        beginMove(pick, input);
      }
    },
    pointerMove(input) {
      if (!gesture || isOtherPointer(input)) return;
      switch (gesture.kind) {
        case "box":
          gesture = { ...gesture, current: input };
          setPreview(resolveBoxPreview(gesture), gesture);
          break;
        case "move": {
          const moved =
            gesture.moved || exceedsMoveThreshold(gesture.start, input);
          const active = (gesture = { ...gesture, current: input, moved });
          if (moved) {
            const { preview, dx, dy } = resolveMovePreview(active, input);
            setPreview(preview, active);
            const nextState = state;
            const id = active.detection.id;
            if (gesture === active && id !== undefined) {
              options.onFastTranslate?.(id, dx, dy);
              for (const listener of fastTranslateListeners) {
                if (state !== nextState) break;
                listener(id, dx, dy);
              }
            }
          }
          break;
        }
        case "resize": {
          // A click on a handle is not a drag: a keypoint tapped to open its
          // menu must not snap to the pointer, so nothing previews or commits
          // until the pointer has travelled like a move gesture.
          const moved =
            gesture.moved || exceedsMoveThreshold(gesture.start, input);
          const active = (gesture = { ...gesture, current: input, moved });
          if (moved) {
            setPreview(resolveHandlePreview(active, input), active);
          }
          break;
        }
        case "path":
          setPreview(
            resolvePathPreview([...gesture.points, input.point]),
            gesture,
          );
          break;
        case "freehand": {
          const previous = gesture.points.at(-1);
          if (
            !previous ||
            previous.x !== input.point.x ||
            previous.y !== input.point.y
          ) {
            gesture.points.push(input.point);
          }
          gesture = { ...gesture, current: input };
          setPreview(resolvePathPreview(gesture.points), gesture);
          break;
        }
      }
    },
    pointerUp(input) {
      if (!gesture || isOtherPointer(input)) return;
      if (gesture.kind === "path") {
        const active = gesture;
        const press = active.press;
        if (!press) return;
        active.press = null;
        const next = installState({ ...state, pointerId: null });
        release(press.pointerId);
        notifyStateChange(next);
        return;
      }
      const active = gesture;
      const activeTool = tool;
      gesture = null;
      const next = installState(idleState());
      release(active.start.pointerId);
      if (state !== next) return;
      if (active.kind === "box") {
        const preview = resolveBoxPreview(
          { ...active, current: input },
          activeTool,
        );
        if (state !== next) return;
        const duration = input.timestamp - active.start.timestamp;
        const diagonal =
          Math.hypot(
            input.point.x - active.start.point.x,
            input.point.y - active.start.point.y,
          ) * scale();
        const rect =
          activeTool?.geometry === AnnotationGeometryKind.OrientedBox &&
          preview.orientedBox
            ? getOrientedRectangleGeometry(preview.orientedBox)
            : preview.rect;
        if (
          !rect ||
          rect.width < 1 ||
          rect.height < 1 ||
          (duration < CLICK_CANCEL_MS && diagonal <= CLICK_CANCEL_DIAGONAL) ||
          activeTool?.shouldCommit?.(
            activeTool.geometry === AnnotationGeometryKind.OrientedBox
              ? preview.orientedBox!.points
              : rect,
          ) === false
        ) {
          if (state === next) rejectCreation(next, activeTool);
          return;
        }
        if (state === next) commit(preview, null, next);
        return;
      }
      if (active.kind === "freehand") {
        const points = [...active.points, input.point];
        if (points.length < 2 || activeTool?.shouldCommit?.(points) === false) {
          if (state === next) rejectCreation(next, activeTool);
          return;
        }
        const preview = activeTool!.createDetection(points);
        if (state === next) commit(preview, null, next);
        return;
      }
      if (!active.moved) {
        notifyStateChange(next);
        return;
      }
      const preview =
        active.kind === "move"
          ? resolveMovePreview(active, input).preview
          : resolveHandlePreview(active, input);
      if (state === next) commit(preview, active.detection, next);
    },
    pointerCancel(pointerId) {
      const press = activePress();
      if (!press || isOtherPointer({ pointerId })) return;
      if (gesture?.kind !== "path") {
        cancel();
        return;
      }
      const active = gesture;
      active.press = null;
      active.lastTimestamp = null;
      const last = active.points.at(-1)!;
      const preview = resolvePathPreview([...active.points, last]);
      if (gesture !== active) return;
      const next = installState({ ...state, pointerId: null, preview });
      release(press.pointerId);
      publishPreview(next);
    },
    keyDown(key) {
      if (key === "Escape") {
        cancel();
      } else if (key === "Enter" && gesture?.kind === "path") {
        commitPath();
      }
    },
    undoCreation() {
      if (gesture?.kind !== "path") return false;
      gesture.points.pop();
      gesture.lastTimestamp = null;
      const last = gesture.points.at(-1);
      if (!last) cancel();
      else setPreview(resolvePathPreview([...gesture.points, last]), gesture);
      return true;
    },
    beginHandleDrag(detection, handle, input) {
      if (isOtherPointer(input)) return;
      if (detection.locked || detection.mask) return;
      gesture = {
        current: input,
        detection,
        handle,
        kind: "resize",
        moved: false,
        start: input,
      };
      setState(
        {
          activeDetectionId: detection.id ?? null,
          activeHandleId: handle.id,
          kind:
            handle.kind === AnnotationHandleKind.Rotate
              ? AnnotationGestureStateKind.Rotating
              : AnnotationGestureStateKind.Resizing,
          pointerId: input.pointerId ?? null,
          preview: null,
        },
        input.pointerId,
      );
    },
    deleteVertex(detection, vertexIndex) {
      const next = deleteAnnotationVertex(detection, vertexIndex);
      if (next) commit(next, detection);
      return next;
    },
    cancel,
    hasCreationTool: () => tool !== null,
    subscribe(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    subscribeFastTranslate(listener) {
      fastTranslateListeners.add(listener);
      return () => fastTranslateListeners.delete(listener);
    },
  };

  function beginCreation(input: AnnotationPointerInput) {
    if (!tool) return;
    const mode =
      tool.mode ??
      (tool.geometry === AnnotationGeometryKind.Box ||
      tool.geometry === AnnotationGeometryKind.OrientedBox
        ? "drag"
        : tool.geometry === AnnotationGeometryKind.Mask
          ? "freehand"
          : "multiClick");
    if (mode === "drag") {
      const active = (gesture = { current: input, kind: "box", start: input });
      setPreview(resolveBoxPreview(active), active, input.pointerId);
      return;
    }

    if (mode === "freehand") {
      const active = (gesture = {
        current: input,
        kind: "freehand",
        points: [input.point],
        start: input,
      });
      setPreview(resolvePathPreview([input.point]), active, input.pointerId);
      return;
    }

    if (
      tool.geometry !== AnnotationGeometryKind.Polygon &&
      tool.geometry !== AnnotationGeometryKind.Polyline &&
      tool.geometry !== AnnotationGeometryKind.Keypoints
    )
      return;
    if (gesture?.kind !== "path") {
      const active = (gesture = {
        kind: "path",
        lastTimestamp: input.timestamp,
        press: input,
        points: [input.point],
      });
      setPreview(
        resolvePathPreview([input.point, input.point]),
        active,
        input.pointerId,
      );
      return;
    }

    gesture.press = input;
    const minimum =
      tool.minVertices ??
      (tool.geometry === AnnotationGeometryKind.Polygon ? 3 : 2);
    const closeDistance =
      Math.hypot(
        input.point.x - gesture.points[0]!.x,
        input.point.y - gesture.points[0]!.y,
      ) * scale();
    const doubleClick =
      gesture.lastTimestamp !== null &&
      (input.detail !== undefined
        ? input.detail >= 2
        : input.timestamp - gesture.lastTimestamp < CLICK_CANCEL_MS);
    if (
      gesture.points.length >= minimum &&
      ((tool.geometry === AnnotationGeometryKind.Polygon &&
        closeDistance <= CLOSE_ZONE_SCREEN_PX) ||
        doubleClick)
    ) {
      commitPath();
      return;
    }
    gesture.points.push(input.point);
    gesture.lastTimestamp = input.timestamp;
    setPreview(
      resolvePathPreview([...gesture.points, input.point]),
      gesture,
      input.pointerId,
    );
  }

  function beginMove(pick: DetectionPickResult, input: AnnotationPointerInput) {
    gesture = {
      current: input,
      detection: pick.detection,
      kind: "move",
      moved: false,
      start: input,
    };
    setState(
      {
        activeDetectionId: pick.detection.id ?? null,
        activeHandleId: null,
        kind: AnnotationGestureStateKind.Moving,
        pointerId: input.pointerId ?? null,
        preview: null,
      },
      input.pointerId,
    );
  }

  function resolveBoxPreview(
    active: Extract<ActiveGesture, { kind: "box" }>,
    activeTool = tool,
  ) {
    const dimensions =
      active.current.mediaDimensions ?? active.start.mediaDimensions;
    const start = boundPoint(active.start.point, dimensions);
    const current = boundPoint(active.current.point, dimensions);
    const left = Math.min(start.x, current.x);
    const right = Math.max(start.x, current.x);
    const top = Math.min(start.y, current.y);
    const bottom = Math.max(start.y, current.y);
    const rect: Rect = {
      x: (left + right) / 2,
      y: (top + bottom) / 2,
      width: right - left,
      height: bottom - top,
    };
    if (activeTool!.geometry !== AnnotationGeometryKind.OrientedBox)
      return activeTool!.createDetection(rect);
    const corners = [
      { x: left, y: top },
      { x: right, y: top },
      { x: right, y: bottom },
      { x: left, y: bottom },
    ];
    // Keep the footprint axis-aligned while local +x follows the drag's dominant direction.
    const first =
      rect.width >= rect.height
        ? current.x < start.x
          ? 2
          : 0
        : current.y < start.y
          ? 3
          : 1;
    return activeTool!.createDetection(
      corners.map((_, index) => corners[(first + index) % 4]!),
    );
  }

  function resolveHandlePreview(
    active: Extract<ActiveGesture, { kind: "resize" }>,
    input: AnnotationPointerInput,
  ): Detection {
    const preview = applyAnnotationHandleDrag(
      active.detection,
      active.handle,
      input.point,
      input.mediaDimensions ?? active.start.mediaDimensions,
      active.start.point,
    );
    if (
      active.handle.kind !== AnnotationHandleKind.Rotate ||
      !options.resolveRotation
    )
      return preview;
    const initial =
      active.detection.orientedBox &&
      getOrientedRectangleGeometry(active.detection.orientedBox);
    const candidate =
      preview.orientedBox && getOrientedRectangleGeometry(preview.orientedBox);
    if (!initial || !candidate) return preview;
    const rotation = options.resolveRotation(candidate.rotation, {
      detection: active.detection,
      initialRotation: initial.rotation,
      input,
    });
    if (!Number.isFinite(rotation))
      throw new RangeError("resolveRotation must return finite radians");
    return {
      ...active.detection,
      orientedBox: createOrientedBoxGeometry(initial, rotation),
    };
  }

  function resolveMovePreview(
    active: Extract<ActiveGesture, { kind: "move" }>,
    input: AnnotationPointerInput,
  ) {
    let dx = input.point.x - active.start.point.x;
    let dy = input.point.y - active.start.point.y;
    let rect = active.detection.rect;
    const dimensions = input.mediaDimensions ?? active.start.mediaDimensions;
    if (rect && dimensions) {
      const width = Math.min(rect.width, dimensions.width);
      const height = Math.min(rect.height, dimensions.height);
      const x = Math.max(
        width / 2,
        Math.min(rect.x + dx, dimensions.width - width / 2),
      );
      const y = Math.max(
        height / 2,
        Math.min(rect.y + dy, dimensions.height - height / 2),
      );
      dx = x - rect.x;
      dy = y - rect.y;
      rect = { ...rect, x, y, width, height };
    }
    const preview = offsetDetection(active.detection, dx, dy);
    return {
      preview: rect && dimensions ? { ...preview, rect } : preview,
      dx,
      dy,
    };
  }

  function boundPoint(
    point: Point,
    dimensions: AnnotationPointerInput["mediaDimensions"],
  ) {
    return dimensions
      ? {
          x: Math.max(0, Math.min(point.x, dimensions.width)),
          y: Math.max(0, Math.min(point.y, dimensions.height)),
        }
      : point;
  }

  function resolvePathPreview(points: readonly Point[]) {
    return tool!.createDetection(points);
  }

  function commitPath() {
    if (!tool || gesture?.kind !== "path") return;
    const active = gesture;
    const activeTool = tool;
    const minimum =
      activeTool.minVertices ??
      (activeTool.geometry === AnnotationGeometryKind.Polygon ? 3 : 2);
    if (active.points.length < minimum) {
      cancel();
      return;
    }
    const preview = activeTool.createDetection(active.points);
    if (gesture !== active) return;
    const accepted = activeTool.shouldCommit?.(active.points) !== false;
    if (gesture !== active) return;
    if (!accepted) {
      cancel();
      return;
    }
    gesture = null;
    const next = installState(idleState());
    release(active.press?.pointerId);
    if (state === next) commit(preview, null, next);
  }

  function commit(
    detection: Detection,
    previous: Detection | null,
    next = installState(idleState()),
  ) {
    options.onCommit?.(detection, previous);
    publishPreview(next);
  }

  function setPreview(
    preview: Detection,
    active: ActiveGesture,
    pointerToCapture?: number,
  ) {
    if (gesture !== active) return;
    const next = installState({
      activeDetectionId: state.activeDetectionId,
      activeHandleId: state.activeHandleId,
      kind:
        state.kind === AnnotationGestureStateKind.Idle
          ? AnnotationGestureStateKind.Creating
          : state.kind,
      pointerId: activePress()?.pointerId ?? null,
      preview,
    });
    capture(pointerToCapture);
    publishPreview(next);
  }

  function publishPreview(next: AnnotationEditingState) {
    if (state !== next) return;
    options.onPreview?.(next.preview);
    notifyStateChange(next);
  }

  function rejectCreation(
    next: AnnotationEditingState,
    activeTool: AnnotationCreationTool | null,
  ) {
    finishCancel(next);
    if (state === next) activeTool?.onRejected?.();
  }

  function cancel() {
    const press = activePress();
    gesture = null;
    const next = installState(idleState());
    release(press?.pointerId);
    finishCancel(next);
  }

  function finishCancel(next: AnnotationEditingState) {
    if (state !== next) return;
    options.onPreview?.(null);
    if (state !== next) return;
    options.onCancel?.();
    notifyStateChange(next);
  }

  function installState(next: AnnotationEditingState) {
    state = Object.freeze(next);
    return state;
  }

  function setState(next: AnnotationEditingState, pointerToCapture?: number) {
    const installed = installState(next);
    capture(pointerToCapture);
    notifyStateChange(installed);
  }

  function notifyStateChange(next: AnnotationEditingState) {
    if (state !== next) return;
    options.onStateChange?.(next);
    for (const listener of stateListeners) {
      if (state !== next) break;
      listener(next);
    }
  }

  function activePress() {
    return gesture?.kind === "path" ? gesture.press : (gesture?.start ?? null);
  }

  function isOtherPointer(input: Pick<AnnotationPointerInput, "pointerId">) {
    const pointerId = activePress()?.pointerId;
    return (
      pointerId !== undefined &&
      input.pointerId !== undefined &&
      pointerId !== input.pointerId
    );
  }

  function scale() {
    return Math.max(options.viewportScale?.() ?? 1, Number.EPSILON);
  }

  function exceedsMoveThreshold(
    start: AnnotationPointerInput,
    input: AnnotationPointerInput,
  ) {
    return (
      Math.hypot(
        input.point.x - start.point.x,
        input.point.y - start.point.y,
      ) >=
      MOVE_THRESHOLD / scale()
    );
  }

  function capture(pointerId: number | undefined) {
    if (pointerId !== undefined) options.capturePointer?.(pointerId);
  }

  function release(pointerId: number | undefined) {
    if (pointerId !== undefined) options.releasePointer?.(pointerId);
  }
}

function idleState(): AnnotationEditingState {
  return Object.freeze({
    activeDetectionId: null,
    activeHandleId: null,
    kind: AnnotationGestureStateKind.Idle,
    pointerId: null,
    preview: null,
  });
}
