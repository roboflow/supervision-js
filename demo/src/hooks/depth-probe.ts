import { useSyncExternalStore } from "react";
import {
  readDepthAt,
  type ActiveDepthMap,
  type DepthReadout,
  type MediaRenderer,
} from "supervision";

/** The depth on screen and what it holds under the pointer. */
export interface DepthProbeSnapshot {
  readonly active: ActiveDepthMap | null;
  readonly readout: DepthReadout | null;
}

export interface DepthProbe {
  readonly getSnapshot: () => DepthProbeSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  /** Reads the depth on screen again: call it whenever the frame may have moved. */
  readonly refresh: () => void;
  readonly onPointerMove: (event: {
    readonly clientX: number;
    readonly clientY: number;
    readonly currentTarget: Element;
  }) => void;
  readonly onPointerLeave: () => void;
}

const EMPTY: DepthProbeSnapshot = { active: null, readout: null };

/**
 * The workbench's depth readout, kept outside React state so that a pointer
 * moving over the picture re-renders only what shows depth, never the whole
 * workbench. It reads nothing while nothing listens.
 */
export function createDepthProbe(
  getRenderer: () => MediaRenderer | null,
): DepthProbe {
  const listeners = new Set<() => void>();
  let pointer: { readonly x: number; readonly y: number } | null = null;
  let snapshot = EMPTY;

  const refresh = () => {
    if (listeners.size === 0) return;

    const renderer = getRenderer();
    const active = renderer?.getActiveDepth?.() ?? null;
    const readout =
      renderer && active && pointer
        ? readDepthAt(active.map, renderer.screenToMedia(pointer), {
            height: active.mediaHeight,
            width: active.mediaWidth,
          })
        : null;

    if (
      sameActiveDepth(snapshot.active, active) &&
      sameReadout(snapshot.readout, readout)
    ) {
      return;
    }

    snapshot = { active, readout };
    for (const listener of listeners) listener();
  };

  return {
    getSnapshot: () => snapshot,
    onPointerLeave() {
      pointer = null;
      refresh();
    },
    onPointerMove(event) {
      const box = event.currentTarget.getBoundingClientRect();

      pointer = { x: event.clientX - box.left, y: event.clientY - box.top };
      refresh();
    },
    refresh,
    subscribe(listener) {
      listeners.add(listener);
      refresh();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) snapshot = EMPTY;
      };
    },
  };
}

export function useDepthProbe(probe: DepthProbe): DepthProbeSnapshot {
  return useSyncExternalStore(
    probe.subscribe,
    probe.getSnapshot,
    probe.getSnapshot,
  );
}

function sameActiveDepth(
  previous: ActiveDepthMap | null,
  next: ActiveDepthMap | null,
) {
  return (
    previous === next ||
    (previous !== null &&
      next !== null &&
      previous.map === next.map &&
      previous.frameIndex === next.frameIndex &&
      previous.precision === next.precision &&
      previous.mediaWidth === next.mediaWidth &&
      previous.mediaHeight === next.mediaHeight)
  );
}

/** A readout is everything it says about one stored sample of one map. */
function sameReadout(previous: DepthReadout | null, next: DepthReadout | null) {
  return (
    previous === next ||
    (previous !== null &&
      next !== null &&
      previous.x === next.x &&
      previous.y === next.y &&
      previous.stored === next.stored &&
      previous.valid === next.valid &&
      previous.precision === next.precision &&
      previous.confidence === next.confidence)
  );
}
