import type { PlaybackGateReach } from "supervision-js-core";
import {
  createLoadingMediaSourceState,
  createReadyMediaSourceState,
} from "#media/media-source-state";
import type { DecodedMediaSourceMetadata } from "#media/media-source";
import type { DetectionBufferState } from "supervision-js-core";
import {
  MediaRendererPlaybackState,
  MediaSourceStatus,
  type MediaFrameDiagnostics,
  type MediaFrameRenderTimings,
  type MediaRendererFit,
  type MediaRendererState,
  type MediaSourceState,
} from "#types/media-renderer";
import { toMediaSourceError } from "#media/media-errors";
import type { PresentedMediaSample } from "./media-renderer-scene";

interface MediaRendererRuntimeStateOptions {
  readonly fit: MediaRendererFit;
  readonly getPlaybackGateReach: () => PlaybackGateReach;
  readonly playbackRate: number;
  readonly getDetectionBufferState: () => DetectionBufferState;
  readonly onFrame?: (diagnostics: MediaFrameDiagnostics) => void;
  readonly onSource?: (state: MediaSourceState) => void;
  readonly onState?: (state: MediaRendererState) => void;
}

export interface MediaRendererRuntimeState {
  currentTime(): number;
  duration(): number | null;
  errorMessage(): string | null;
  isDestroyed(): boolean;
  isError(): boolean;
  isPlaybackActive(): boolean;
  isBuffering(): boolean;
  isPlaying(): boolean;
  emitSourceState(): void;
  recordMediaMetadata(metadata: DecodedMediaSourceMetadata): {
    height: number;
    width: number;
  };
  setSourceReady(metadata: DecodedMediaSourceMetadata): void;
  /** A playhead that moved. Emits, so a readout follows a seek before its
   *  frame lands. */
  recordPlayheadTime(currentTime: number): void;
  setPlaybackRate(playbackRate: number): void;
  setRendererBackend(rendererBackend: string | null): void;
  recordPresentedSample(sample: PresentedMediaSample): void;
  /** What the scene put on screen, whether on its own or on a repaint the
   *  renderer asked for. Counts a frame not counted before, so a redraw counts
   *  nothing and one media time presented twice counts twice. */
  recordPresentationUpdate(sample: PresentedMediaSample): void;
  setReady(): void;
  setLoading(): void;
  setPlaying(): void;
  setBuffering(): void;
  setPaused(): void;
  setRenderError(error: unknown): void;
  markDestroyed(): void;
  setSourceDestroyed(): void;
  snapshot(): MediaRendererState;
}

export function createMediaRendererRuntimeState(
  options: MediaRendererRuntimeStateOptions,
): MediaRendererRuntimeState {
  let playbackState: MediaRendererPlaybackState =
    MediaRendererPlaybackState.Loading;
  let sourceState = createLoadingMediaSourceState();
  let currentTime = 0;
  let playbackRate = options.playbackRate;
  let firstTimestamp = 0;
  let estimatedFrameCount: number | null = null;
  let estimatedFrameRate: number | null = null;
  let duration: number | null = null;
  let mediaHeight = 0;
  let mediaWidth = 0;
  let rendererBackend: string | null = null;
  /** Frames put on screen, not paints. */
  let presentedFrames = 0;
  let presentedFrameSerial = 0;
  let activeDetectionFrameTime: number | null = null;
  let activeDetectionFrameIndex: number | null = null;
  let activeDetectionCount = 0;
  let drawnMaskFrameTime: number | null = null;
  let maskHeldStale = false;
  let lastFrameRenderTimings: MediaFrameRenderTimings | null = null;
  let currentFrameDuration = 0;
  let destroyed = false;

  const emitSourceState = () => {
    options.onSource?.({ ...sourceState });
  };

  const setSourceState = (patch: Partial<MediaSourceState>) => {
    sourceState = {
      ...sourceState,
      ...patch,
    };
    emitSourceState();
  };

  const createStateSnapshot = (): MediaRendererState => ({
    activeDetectionCount,
    activeDetectionFrameIndex,
    activeDetectionFrameTime,
    currentTime,
    playbackRate,
    detectionBuffer: options.getDetectionBufferState(),
    drawnMaskFrameTime,
    duration,
    fit: options.fit,
    lastFrameRenderTimings,
    maskHeldStale,
    mediaHeight,
    mediaWidth,
    playbackGateReach: options.getPlaybackGateReach(),
    playbackState,
    presentedFrames,
    rendererBackend,
    source: { ...sourceState },
  });

  const createFrameDiagnostics = (
    sample: PresentedMediaSample,
  ): MediaFrameDiagnostics => ({
    activeDetectionCount,
    activeDetectionFrameIndex,
    activeDetectionFrameTime,
    currentTime,
    estimatedFrameIndex: estimateFrameIndex(
      sample.mediaTime,
      firstTimestamp,
      estimatedFrameRate,
      estimatedFrameCount,
    ),
    firstTimestamp,
    frameDuration: sample.duration ?? currentFrameDuration,
    detectionBuffer: sample.detectionBuffer,
    duration,
    expectedDisplayTime: null,
    mediaHeight,
    mediaTime: sample.mediaTime,
    mediaWidth,
    presentedFrames,
    rendererBackend,
    renderTimings: lastFrameRenderTimings,
  });

  const emitState = () => {
    options.onState?.(createStateSnapshot());
  };

  const adoptPresentedSample = (sample: PresentedMediaSample) => {
    currentTime = sample.mediaTime;
    activeDetectionFrameIndex = sample.activeDetectionFrameIndex;
    activeDetectionFrameTime = sample.activeDetectionFrameTime;
    activeDetectionCount = sample.activeDetectionCount;
    drawnMaskFrameTime = sample.drawnMaskFrameTime;
    maskHeldStale = sample.maskHeldStale;
  };

  return {
    currentTime() {
      return currentTime;
    },

    duration() {
      return duration;
    },

    errorMessage() {
      return sourceState.errorMessage;
    },

    isDestroyed() {
      return destroyed;
    },

    isError() {
      return playbackState === MediaRendererPlaybackState.Error;
    },

    isPlaybackActive() {
      return (
        playbackState === MediaRendererPlaybackState.Playing ||
        playbackState === MediaRendererPlaybackState.Buffering
      );
    },

    isBuffering() {
      return playbackState === MediaRendererPlaybackState.Buffering;
    },

    isPlaying() {
      return playbackState === MediaRendererPlaybackState.Playing;
    },

    emitSourceState,

    recordMediaMetadata(metadata) {
      mediaWidth = metadata.primaryVideoWidth;
      mediaHeight = metadata.primaryVideoHeight;
      duration = metadata.duration;
      firstTimestamp = metadata.firstTimestamp;
      estimatedFrameCount = metadata.estimatedFrameCount ?? null;
      estimatedFrameRate = metadata.estimatedFrameRate ?? null;

      return { height: mediaHeight, width: mediaWidth };
    },

    setSourceReady(metadata) {
      sourceState = createReadyMediaSourceState(metadata);
      emitSourceState();
    },

    recordPlayheadTime(nextCurrentTime) {
      if (currentTime === nextCurrentTime) {
        return;
      }

      currentTime = nextCurrentTime;
      emitState();
    },

    setPlaybackRate(nextPlaybackRate) {
      if (playbackRate === nextPlaybackRate) {
        return;
      }

      playbackRate = nextPlaybackRate;
      emitState();
    },

    setRendererBackend(nextRendererBackend) {
      rendererBackend = nextRendererBackend;
    },

    recordPresentedSample(sample) {
      currentFrameDuration = sample.duration ?? currentFrameDuration;
      presentedFrames += 1;
      presentedFrameSerial = sample.presentedFrameSerial;
      adoptPresentedSample(sample);
      lastFrameRenderTimings = sample.renderTimings ?? null;

      options.onFrame?.(createFrameDiagnostics(sample));
      emitState();
    },

    recordPresentationUpdate(sample) {
      if (sample.presentedFrameSerial !== presentedFrameSerial) {
        presentedFrames += 1;
        presentedFrameSerial = sample.presentedFrameSerial;
      }

      adoptPresentedSample(sample);
      lastFrameRenderTimings = sample.renderTimings ?? lastFrameRenderTimings;

      emitState();
    },

    setReady() {
      playbackState = MediaRendererPlaybackState.Ready;
      emitState();
    },

    setLoading() {
      playbackState = MediaRendererPlaybackState.Loading;
      emitState();
    },

    setPlaying() {
      playbackState = MediaRendererPlaybackState.Playing;
      emitState();
    },

    setBuffering() {
      playbackState = MediaRendererPlaybackState.Buffering;
      emitState();
    },

    setPaused() {
      playbackState = MediaRendererPlaybackState.Paused;
      emitState();
    },

    setRenderError(error) {
      playbackState = MediaRendererPlaybackState.Error;
      setSourceState(createMediaRenderErrorSourcePatch(error));
      emitState();
    },

    markDestroyed() {
      destroyed = true;
      playbackState = MediaRendererPlaybackState.Destroyed;
      emitState();
    },

    setSourceDestroyed() {
      setSourceState({ status: MediaSourceStatus.Destroyed });
    },

    snapshot() {
      return createStateSnapshot();
    },
  };
}

function estimateFrameIndex(
  mediaTime: number,
  firstTimestamp: number,
  estimatedFrameRate: number | null,
  estimatedFrameCount: number | null,
): number | null {
  if (estimatedFrameRate === null || estimatedFrameRate <= 0) return null;

  const index = Math.max(
    0,
    Math.round(Math.max(0, mediaTime - firstTimestamp) * estimatedFrameRate),
  );
  return estimatedFrameCount === null
    ? index
    : Math.min(index, Math.max(0, estimatedFrameCount - 1));
}

function createMediaRenderErrorSourcePatch(
  error: unknown,
): Pick<MediaSourceState, "errorKind" | "errorMessage" | "status"> {
  const mediaError = toMediaSourceError(error, "Media decode failed.");

  return {
    errorKind: mediaError.kind,
    errorMessage: mediaError.message,
    status: MediaSourceStatus.Error,
  };
}
