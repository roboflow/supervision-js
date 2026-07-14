import type { Detection, DetectionFrame } from "#types/detections";
import { copySortedDetectionFrames } from "#utils/detection-frames";

export type DetectionId = string | number;
export type EditableDetection = DeepMutable<Detection>;

export enum AnnotationFrameMutationKind {
  Add = "add",
  Remove = "remove",
  Replace = "replace",
  Transact = "transact",
  Update = "update",
}

export interface AnnotationFrameMutation {
  readonly kind: AnnotationFrameMutationKind;
  readonly detectionIds: readonly DetectionId[];
  readonly previous: DetectionFrame;
  readonly current: DetectionFrame;
}

export type AnnotationFrameMutationListener = (
  mutation: AnnotationFrameMutation,
) => void;

export interface EditableAnnotationFrameSession {
  getSnapshot(): DetectionFrame;
  add(detection: Detection, index?: number): DetectionFrame;
  update(
    id: DetectionId,
    update: Partial<Detection> | ((current: Detection) => Detection),
  ): DetectionFrame;
  remove(id: DetectionId): DetectionFrame;
  replace(frame: DetectionFrame): DetectionFrame;
  transact(
    mutate: (detections: EditableDetection[]) => void,
    detectionIds?: readonly DetectionId[],
  ): DetectionFrame;
  subscribe(listener: AnnotationFrameMutationListener): () => void;
  destroy(): void;
}

export function createEditableAnnotationFrameSession(
  initialFrame: DetectionFrame,
): EditableAnnotationFrameSession {
  let snapshot = createSnapshot(initialFrame);
  let destroyed = false;
  const listeners = new Set<AnnotationFrameMutationListener>();

  assertStableIds(snapshot);

  const commit = (
    frame: DetectionFrame,
    kind: AnnotationFrameMutationKind,
    detectionIds: readonly DetectionId[],
  ) => {
    assertActive();
    const previous = snapshot;
    const current = createSnapshot(frame);
    assertStableIds(current);
    snapshot = current;

    const mutation = Object.freeze({
      current,
      detectionIds: Object.freeze([...detectionIds]),
      kind,
      previous,
    });

    for (const listener of listeners) {
      listener(mutation);
    }

    return current;
  };

  const session: EditableAnnotationFrameSession = {
    getSnapshot() {
      assertActive();
      return snapshot;
    },

    add(detection, index = snapshot.detections.length) {
      assertActive();
      const id = requireDetectionId(detection);

      if (findDetectionIndex(snapshot, id) !== -1) {
        throw new Error(`Detection id ${String(id)} already exists.`);
      }

      const detections = [...snapshot.detections];
      const insertionIndex = Math.max(0, Math.min(index, detections.length));
      detections.splice(insertionIndex, 0, detection);

      return commit(
        { ...snapshot, detections },
        AnnotationFrameMutationKind.Add,
        [id],
      );
    },

    update(id, update) {
      assertActive();
      const detectionIndex = findDetectionIndex(snapshot, id);

      if (detectionIndex === -1) {
        throw new Error(`Detection id ${String(id)} was not found.`);
      }

      const detections = [...snapshot.detections];
      const current = detections[detectionIndex]!;
      const next =
        typeof update === "function"
          ? update(current)
          : { ...current, ...update };

      if (next.id !== id) {
        throw new Error("Detection updates must preserve the stable id.");
      }

      detections[detectionIndex] = next;

      return commit(
        { ...snapshot, detections },
        AnnotationFrameMutationKind.Update,
        [id],
      );
    },

    remove(id) {
      assertActive();
      const detectionIndex = findDetectionIndex(snapshot, id);

      if (detectionIndex === -1) {
        return snapshot;
      }

      const detections = [...snapshot.detections];
      detections.splice(detectionIndex, 1);

      return commit(
        { ...snapshot, detections },
        AnnotationFrameMutationKind.Remove,
        [id],
      );
    },

    replace(frame) {
      return commit(
        frame,
        AnnotationFrameMutationKind.Replace,
        frame.detections.map(requireDetectionId),
      );
    },

    transact(mutate, detectionIds = []) {
      assertActive();
      const detections = copySortedDetectionFrames([snapshot])[0]!
        .detections as EditableDetection[];
      mutate(detections);

      return commit(
        { ...snapshot, detections },
        AnnotationFrameMutationKind.Transact,
        detectionIds,
      );
    },

    subscribe(listener) {
      assertActive();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    destroy() {
      destroyed = true;
      listeners.clear();
    },
  };

  return session;

  function assertActive() {
    if (destroyed) {
      throw new Error("Editable annotation frame session has been destroyed.");
    }
  }
}

type DeepMutable<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly [unknown, ...unknown[]]
    ? { -readonly [TKey in keyof T]: DeepMutable<T[TKey]> }
    : T extends readonly (infer TValue)[]
      ? DeepMutable<TValue>[]
      : T extends object
        ? { -readonly [TKey in keyof T]: DeepMutable<T[TKey]> }
        : T;

function findDetectionIndex(frame: DetectionFrame, id: DetectionId) {
  return frame.detections.findIndex((detection) => detection.id === id);
}

function requireDetectionId(detection: Detection): DetectionId {
  if (detection.id === undefined) {
    throw new Error("Editable annotation detections require a stable id.");
  }

  return detection.id;
}

function assertStableIds(frame: DetectionFrame) {
  const ids = new Set<DetectionId>();

  for (const detection of frame.detections) {
    const id = requireDetectionId(detection);

    if (ids.has(id)) {
      throw new Error(`Detection id ${String(id)} is duplicated.`);
    }

    ids.add(id);
  }
}

function createSnapshot(frame: DetectionFrame): DetectionFrame {
  const snapshot = copySortedDetectionFrames([frame])[0]!;
  return deepFreeze(snapshot);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);

    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
  }

  return value;
}
