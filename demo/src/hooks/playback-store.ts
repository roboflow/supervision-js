import type { MediaRendererPlaybackState } from "supervision";

export interface PlaybackSnapshot {
  readonly activeDetectionFrameTime: number | null;
  readonly currentTime: number;
  readonly duration: number | null;
  readonly playbackState: MediaRendererPlaybackState | null;
}

export interface PlaybackStore {
  getSnapshot(): PlaybackSnapshot;
  subscribe(listener: () => void): () => void;
  write(snapshot: PlaybackSnapshot): void;
}

const IDLE_SNAPSHOT: PlaybackSnapshot = {
  activeDetectionFrameTime: null,
  currentTime: 0,
  duration: null,
  playbackState: null,
};

/**
 * High-churn playback values bypass React state on purpose: a value that
 * changes on every presented frame re-renders every component between the
 * app root and the readout that shows it, and the repaint of that whole
 * subtree is what a paint trace shows as a full-viewport flash. Leaves
 * subscribe to this store directly and nothing above them re-renders.
 */
export function createPlaybackStore(): PlaybackStore {
  let snapshot = IDLE_SNAPSHOT;
  const listeners = new Set<() => void>();

  return {
    getSnapshot() {
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    write(next) {
      if (
        next.currentTime === snapshot.currentTime &&
        next.activeDetectionFrameTime === snapshot.activeDetectionFrameTime &&
        next.duration === snapshot.duration &&
        next.playbackState === snapshot.playbackState
      ) {
        return;
      }

      snapshot = next;
      for (const listener of listeners) {
        listener();
      }
    },
  };
}
