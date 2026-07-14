import {
  AnnotationGeometryKind,
  AnnotationGestureStateKind,
  type AnnotationCreationTool,
  type AnnotationEditingEngine,
  type AnnotationEditingEngineOptions,
  type AnnotationEditingState,
  type AnnotationHandleDefinition,
  type AnnotationPointerInput,
} from "#types/editing";
import type { Detection, Point, Rect } from "#types/detections";
import type { DetectionPickResult } from "#types/interaction";
import {
  applyAnnotationHandleDrag,
  deleteAnnotationVertex,
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
      lastTimestamp: number;
      pointerId: number | null;
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
    };

export function createAnnotationEditingEngine(
  options: AnnotationEditingEngineOptions = {},
): AnnotationEditingEngine {
  let tool: AnnotationCreationTool | null = null;
  let gesture: ActiveGesture | null = null;
  let state: AnnotationEditingState = idleState();
  const stateListeners = new Set<(state: AnnotationEditingState) => void>();
  const fastTranslateListeners = new Set<
    (id: string | number, dx: number, dy: number) => void
  >();

  return {
    getState: () => state,
    setCreationTool(nextTool) {
      if (gesture) cancel();
      tool = nextTool;
    },
    pointerDown(input, pick = null) {
      if (input.button !== undefined && input.button !== 0) return;
      if (tool) {
        beginCreation(input);
      } else if (pick && !pick.detection.locked) {
        beginMove(pick, input);
      }
    },
    pointerMove(input) {
      if (!gesture) return;
      switch (gesture.kind) {
        case "box":
          gesture = { ...gesture, current: input };
          setPreview(resolveBoxPreview(gesture));
          break;
        case "move": {
          const dx = input.point.x - gesture.start.point.x;
          const dy = input.point.y - gesture.start.point.y;
          const moved =
            gesture.moved || Math.hypot(dx, dy) >= MOVE_THRESHOLD / scale();
          gesture = { ...gesture, current: input, moved };
          if (moved) {
            const preview = offsetDetection(gesture.detection, dx, dy);
            setPreview(preview);
            if (gesture.detection.id !== undefined) {
              options.onFastTranslate?.(gesture.detection.id, dx, dy);
              for (const listener of fastTranslateListeners) {
                listener(gesture.detection.id, dx, dy);
              }
            }
          }
          break;
        }
        case "resize":
          gesture = { ...gesture, current: input };
          setPreview(
            applyAnnotationHandleDrag(
              gesture.detection,
              gesture.handle,
              input.point,
            ),
          );
          break;
        case "path":
          setPreview(resolvePathPreview([...gesture.points, input.point]));
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
          setPreview(resolvePathPreview(gesture.points));
          break;
        }
      }
    },
    pointerUp(input) {
      if (!gesture) return;
      if (gesture.kind === "path") return;
      const active = gesture;
      gesture = null;
      release(active.start.pointerId);
      if (active.kind === "box") {
        const preview = resolveBoxPreview({ ...active, current: input });
        const duration = input.timestamp - active.start.timestamp;
        const diagonal =
          Math.hypot(
            input.point.x - active.start.point.x,
            input.point.y - active.start.point.y,
          ) * scale();
        const rect = preview.rect;
        if (
          !rect ||
          rect.width < 1 ||
          rect.height < 1 ||
          (duration < CLICK_CANCEL_MS && diagonal <= CLICK_CANCEL_DIAGONAL)
        ) {
          cancel();
          return;
        }
        if (tool?.shouldCommit?.(rect) === false) {
          cancel();
          return;
        }
        commit(preview, null);
        return;
      }
      if (active.kind === "freehand") {
        const points = [...active.points, input.point];
        if (points.length < 2 || tool?.shouldCommit?.(points) === false) {
          cancel();
          return;
        }
        commit(tool!.createDetection(points), null);
        return;
      }
      if (active.kind === "move") {
        if (!active.moved) {
          setState(idleState());
          return;
        }
        const preview = offsetDetection(
          active.detection,
          input.point.x - active.start.point.x,
          input.point.y - active.start.point.y,
        );
        commit(preview, active.detection);
        return;
      }
      const preview = applyAnnotationHandleDrag(
        active.detection,
        active.handle,
        input.point,
      );
      commit(preview, active.detection);
    },
    keyDown(key) {
      if (key === "Escape") {
        cancel();
      } else if (key === "Enter" && gesture?.kind === "path") {
        commitPath();
      }
    },
    beginHandleDrag(detection, handle, input) {
      if (detection.locked) return;
      capture(input.pointerId);
      gesture = {
        current: input,
        detection,
        handle,
        kind: "resize",
        start: input,
      };
      setState({
        activeDetectionId: detection.id ?? null,
        activeHandleId: handle.id,
        kind: AnnotationGestureStateKind.Resizing,
        pointerId: input.pointerId ?? null,
        preview: detection,
      });
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
      (tool.geometry === AnnotationGeometryKind.Box
        ? "drag"
        : tool.geometry === AnnotationGeometryKind.Mask
          ? "freehand"
          : "multiClick");
    if (mode === "drag") {
      capture(input.pointerId);
      gesture = { current: input, kind: "box", start: input };
      const preview = resolveBoxPreview(gesture);
      options.onPreview?.(preview);
      setState({
        activeDetectionId: null,
        activeHandleId: null,
        kind: AnnotationGestureStateKind.Creating,
        pointerId: input.pointerId ?? null,
        preview,
      });
      return;
    }

    if (mode === "freehand") {
      capture(input.pointerId);
      gesture = {
        current: input,
        kind: "freehand",
        points: [input.point],
        start: input,
      };
      setPreview(resolvePathPreview([input.point]));
      return;
    }

    if (
      tool.geometry !== AnnotationGeometryKind.Polygon &&
      tool.geometry !== AnnotationGeometryKind.Polyline &&
      tool.geometry !== AnnotationGeometryKind.Keypoints
    )
      return;
    if (gesture?.kind !== "path") {
      capture(input.pointerId);
      gesture = {
        kind: "path",
        lastTimestamp: input.timestamp,
        pointerId: input.pointerId ?? null,
        points: [input.point],
      };
      setPreview(resolvePathPreview([input.point, input.point]));
      return;
    }

    const minimum =
      tool.minVertices ??
      (tool.geometry === AnnotationGeometryKind.Polygon ? 3 : 2);
    const closeDistance =
      Math.hypot(
        input.point.x - gesture.points[0]!.x,
        input.point.y - gesture.points[0]!.y,
      ) * scale();
    const doubleClick =
      input.detail !== undefined
        ? input.detail >= 2
        : input.timestamp - gesture.lastTimestamp < CLICK_CANCEL_MS;
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
    setPreview(resolvePathPreview([...gesture.points, input.point]));
  }

  function beginMove(pick: DetectionPickResult, input: AnnotationPointerInput) {
    capture(input.pointerId);
    gesture = {
      current: input,
      detection: pick.detection,
      kind: "move",
      moved: false,
      start: input,
    };
    setState({
      activeDetectionId: pick.detection.id ?? null,
      activeHandleId: null,
      kind: AnnotationGestureStateKind.Moving,
      pointerId: input.pointerId ?? null,
      preview: null,
    });
  }

  function resolveBoxPreview(active: Extract<ActiveGesture, { kind: "box" }>) {
    const left = Math.min(active.start.point.x, active.current.point.x);
    const right = Math.max(active.start.point.x, active.current.point.x);
    const top = Math.min(active.start.point.y, active.current.point.y);
    const bottom = Math.max(active.start.point.y, active.current.point.y);
    const rect: Rect = {
      x: (left + right) / 2,
      y: (top + bottom) / 2,
      width: right - left,
      height: bottom - top,
    };
    return tool!.createDetection(rect);
  }

  function resolvePathPreview(points: readonly Point[]) {
    return tool!.createDetection(points);
  }

  function commitPath() {
    if (!tool || gesture?.kind !== "path") return;
    const minimum =
      tool.minVertices ??
      (tool.geometry === AnnotationGeometryKind.Polygon ? 3 : 2);
    if (gesture.points.length < minimum) {
      cancel();
      return;
    }
    const preview = tool.createDetection(gesture.points);
    if (tool.shouldCommit?.(gesture.points) === false) {
      cancel();
      return;
    }
    release(gesture.pointerId ?? undefined);
    gesture = null;
    commit(preview, null);
  }

  function commit(detection: Detection, previous: Detection | null) {
    options.onCommit?.(detection, previous);
    options.onPreview?.(null);
    setState(idleState());
  }

  function setPreview(preview: Detection) {
    options.onPreview?.(preview);
    setState({
      activeDetectionId: state.activeDetectionId,
      activeHandleId: state.activeHandleId,
      kind:
        state.kind === AnnotationGestureStateKind.Idle
          ? AnnotationGestureStateKind.Creating
          : state.kind,
      pointerId:
        state.pointerId ??
        (gesture && "pointerId" in gesture
          ? (gesture.pointerId ?? null)
          : null),
      preview,
    });
  }

  function cancel() {
    const pointerId =
      gesture && "start" in gesture
        ? gesture.start.pointerId
        : gesture?.kind === "path"
          ? (gesture.pointerId ?? undefined)
          : undefined;
    release(pointerId);
    gesture = null;
    options.onPreview?.(null);
    options.onCancel?.();
    setState(idleState());
  }

  function setState(next: AnnotationEditingState) {
    state = Object.freeze(next);
    options.onStateChange?.(state);
    for (const listener of stateListeners) listener(state);
  }

  function scale() {
    return Math.max(options.viewportScale?.() ?? 1, Number.EPSILON);
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
