import {
  DetectionBufferStatus,
  type BufferedDetectionTimeline,
  type DetectionBufferOptions,
  type DetectionBufferState,
  type DetectionFrameSource,
} from "#types/detection-timeline";
import type { DetectionFrame } from "#types/detections";
import {
  copySortedDetectionFrames,
  selectDetectionFrame,
} from "#utils/detection-frames";

const DEFAULT_BUFFER_AHEAD_SECONDS = 5;
const DEFAULT_BUFFER_BEHIND_SECONDS = 0.5;

export function createBufferedDetectionTimeline(
  options: {
    readonly source: DetectionFrameSource;
  } & DetectionBufferOptions,
): BufferedDetectionTimeline {
  const bufferAheadSeconds =
    options.bufferAheadSeconds ?? DEFAULT_BUFFER_AHEAD_SECONDS;
  const bufferBehindSeconds =
    options.bufferBehindSeconds ?? DEFAULT_BUFFER_BEHIND_SECONDS;

  let buffer: DetectionFrame[] = [];
  let state = createIdleDetectionBufferState();
  let destroyed = false;
  let loadId = 0;
  let inFlight:
    | {
        readonly id: number;
        readonly startTime: number;
        readonly endTime: number;
        readonly promise: Promise<void>;
      }
    | undefined;

  const loadWindow = (mediaTime: number) => {
    const startTime = Math.max(0, mediaTime - bufferBehindSeconds);
    const endTime = Math.max(startTime, mediaTime + bufferAheadSeconds);

    if (
      inFlight &&
      rangeContains(inFlight.startTime, inFlight.endTime, startTime, endTime)
    ) {
      return inFlight.promise;
    }

    const currentLoadId = loadId + 1;

    loadId = currentLoadId;
    state = {
      ...state,
      errorMessage: null,
      requestedEndTime: endTime,
      requestedStartTime: startTime,
      status: DetectionBufferStatus.Loading,
    };

    const promise = options.source
      .loadFrames(startTime, endTime)
      .then((frames) => {
        if (destroyed || currentLoadId !== loadId) {
          return;
        }

        buffer = copySortedDetectionFrames(frames);
        state = {
          bufferEndTime: endTime,
          bufferStartTime: startTime,
          detectionCount: countDetections(buffer),
          errorMessage: null,
          frameCount: buffer.length,
          requestedEndTime: endTime,
          requestedStartTime: startTime,
          status: DetectionBufferStatus.Ready,
        };
      })
      .catch((error: unknown) => {
        if (!destroyed && currentLoadId === loadId) {
          state = {
            ...state,
            errorMessage: getErrorMessage(error),
            status: DetectionBufferStatus.Error,
          };
        }

        throw error;
      })
      .finally(() => {
        if (inFlight?.id === currentLoadId) {
          inFlight = undefined;
        }
      });

    inFlight = {
      endTime,
      id: currentLoadId,
      promise,
      startTime,
    };

    return promise;
  };

  const isBuffered = (mediaTime: number) =>
    state.bufferStartTime !== null &&
    state.bufferEndTime !== null &&
    mediaTime >= state.bufferStartTime &&
    mediaTime <= state.bufferEndTime;

  const shouldPrefetch = (mediaTime: number) => {
    if (!isBuffered(mediaTime)) {
      return true;
    }

    if (state.bufferEndTime === null || bufferAheadSeconds <= 0) {
      return false;
    }

    return mediaTime + bufferAheadSeconds / 2 >= state.bufferEndTime;
  };

  return {
    async prepare(mediaTime) {
      if (destroyed || isBuffered(mediaTime)) {
        return;
      }

      await loadWindow(mediaTime);
    },

    prefetch(mediaTime) {
      if (destroyed || !shouldPrefetch(mediaTime)) {
        return;
      }

      void loadWindow(mediaTime).catch(() => undefined);
    },

    selectFrame(mediaTime) {
      if (!isBuffered(mediaTime)) {
        return undefined;
      }

      return selectDetectionFrame(buffer, mediaTime);
    },

    getState() {
      return { ...state };
    },

    destroy() {
      if (destroyed) {
        return;
      }

      destroyed = true;
      buffer = [];
      state = {
        ...state,
        bufferEndTime: null,
        bufferStartTime: null,
        detectionCount: 0,
        frameCount: 0,
        status: DetectionBufferStatus.Destroyed,
      };
      options.source.destroy?.();
    },
  };
}

export function createIdleDetectionBufferState(): DetectionBufferState {
  return {
    bufferEndTime: null,
    bufferStartTime: null,
    detectionCount: 0,
    errorMessage: null,
    frameCount: 0,
    requestedEndTime: null,
    requestedStartTime: null,
    status: DetectionBufferStatus.Idle,
  };
}

function rangeContains(
  outerStart: number,
  outerEnd: number,
  innerStart: number,
  innerEnd: number,
) {
  return outerStart <= innerStart && innerEnd <= outerEnd;
}

function countDetections(frames: readonly DetectionFrame[]) {
  return frames.reduce((total, frame) => total + frame.detections.length, 0);
}

function getErrorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Detection buffer load failed.";
}
