import {
  createLoadingMediaSourceState,
  createReadyMediaSourceState,
} from "#media/media-source-state";
import type { DecodedMediaSourceMetadata } from "#media/media-source";
import {
  MediaRendererPlaybackState,
  MediaSourceStatus,
  type MediaFrameDiagnostics,
  type MediaRendererFit,
  type MediaRendererState,
  type MediaSourceState,
} from "#types/media-renderer";
import type { PresentedMediaSample } from "./media-renderer-scene";

interface MediaRendererRuntimeStateOptions {
  readonly fit: MediaRendererFit;
  readonly onFrame?: (diagnostics: MediaFrameDiagnostics) => void;
  readonly onSource?: (state: MediaSourceState) => void;
}

export interface MediaRendererRuntimeState {
  currentTime(): number;
  duration(): number | null;
  errorMessage(): string | null;
  isDestroyed(): boolean;
  isError(): boolean;
  isPlaying(): boolean;
  emitSourceState(): void;
  recordMediaMetadata(metadata: DecodedMediaSourceMetadata): {
    height: number;
    width: number;
  };
  setSourceReady(metadata: DecodedMediaSourceMetadata): void;
  setCurrentTime(currentTime: number): void;
  recordPresentedSample(sample: PresentedMediaSample): void;
  setReady(): void;
  setPlaying(): void;
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
  let presentedFrames = 0;
  let activeDetectionFrameTime: number | null = null;
  let activeDetectionCount = 0;
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
    activeDetectionFrameTime,
    currentTime,
    duration,
    fit: options.fit,
    mediaHeight,
    mediaWidth,
    playbackState,
    presentedFrames,
    source: { ...sourceState },
  });

  const createFrameDiagnostics = (
    sample: PresentedMediaSample,
  ): MediaFrameDiagnostics => ({
    activeDetectionCount,
    activeDetectionFrameTime,
    currentTime,
    duration,
    expectedDisplayTime: null,
    mediaHeight,
    mediaTime: sample.mediaTime,
    mediaWidth,
    presentedFrames,
  });

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

    recordPresentedSample(sample) {
      currentTime = sample.mediaTime;
      presentedFrames += 1;
      activeDetectionFrameTime = sample.activeDetectionFrameTime;
      activeDetectionCount = sample.activeDetectionCount;

      options.onFrame?.(createFrameDiagnostics(sample));
    },

    setReady() {
      playbackState = MediaRendererPlaybackState.Ready;
    },

    setPlaying() {
      playbackState = MediaRendererPlaybackState.Playing;
    },

    setPaused() {
      playbackState = MediaRendererPlaybackState.Paused;
    },

    setRenderError(error) {
      playbackState = MediaRendererPlaybackState.Error;
      setSourceState(createMediaRenderErrorSourcePatch(error));
    },

    markDestroyed() {
      destroyed = true;
      playbackState = MediaRendererPlaybackState.Destroyed;
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
