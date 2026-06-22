import {
  createLoadingMediaSourceState,
  createReadyMediaSourceState,
} from "#media/media-source-state";
import type { DecodedMediaSourceMetadata } from "#media/media-source";
import type { DetectionBufferState } from "#types/detection-timeline";
import {
  MediaRendererPlaybackState,
  MediaSourceStatus,
  type MediaFrameDiagnostics,
  type MediaFrameRenderTimings,
  type MediaRendererFit,
  type MediaRendererState,
  type MediaSourceState,
} from "#types/media-renderer";
import type { PresentedMediaSample } from "./media-renderer-scene";

interface MediaRendererRuntimeStateOptions {
  readonly fit: MediaRendererFit;
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
  setCurrentTime(currentTime: number): void;
  setRendererBackend(rendererBackend: string | null): void;
  recordPresentedSample(sample: PresentedMediaSample): void;
  recordPresentationUpdate(sample: PresentedMediaSample): void;
  setReady(): void;
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
  let duration: number | null = null;
  let mediaHeight = 0;
  let mediaWidth = 0;
  let rendererBackend: string | null = null;
  let presentedFrames = 0;
  let activeDetectionFrameTime: number | null = null;
  let activeDetectionFrameIndex: number | null = null;
  let activeDetectionCount = 0;
  let lastFrameRenderTimings: MediaFrameRenderTimings | null = null;
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
    detectionBuffer: options.getDetectionBufferState(),
    duration,
    fit: options.fit,
    lastFrameRenderTimings,
    mediaHeight,
    mediaWidth,
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

      return { height: mediaHeight, width: mediaWidth };
    },

    setSourceReady(metadata) {
      sourceState = createReadyMediaSourceState(metadata);
      emitSourceState();
    },

    setCurrentTime(nextCurrentTime) {
      currentTime = nextCurrentTime;
    },

    setRendererBackend(nextRendererBackend) {
      rendererBackend = nextRendererBackend;
    },

    recordPresentedSample(sample) {
      currentTime = sample.mediaTime;
      presentedFrames += 1;
      activeDetectionFrameIndex = sample.activeDetectionFrameIndex;
      activeDetectionFrameTime = sample.activeDetectionFrameTime;
      activeDetectionCount = sample.activeDetectionCount;
      lastFrameRenderTimings = sample.renderTimings ?? null;

      options.onFrame?.(createFrameDiagnostics(sample));
      emitState();
    },

    recordPresentationUpdate(sample) {
      currentTime = sample.mediaTime;
      activeDetectionFrameIndex = sample.activeDetectionFrameIndex;
      activeDetectionFrameTime = sample.activeDetectionFrameTime;
      activeDetectionCount = sample.activeDetectionCount;
      lastFrameRenderTimings = sample.renderTimings ?? lastFrameRenderTimings;

      emitState();
    },

    setReady() {
      playbackState = MediaRendererPlaybackState.Ready;
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

function createMediaRenderErrorSourcePatch(
  error: unknown,
): Pick<MediaSourceState, "errorMessage" | "status"> {
  return {
    errorMessage:
      error instanceof Error ? error.message : "Media decode failed.",
    status: MediaSourceStatus.Error,
  };
}
