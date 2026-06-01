import type {
  DetectionBufferOptions,
  DetectionFrameRetentionOptions,
} from "#types/detection-timeline";
import { DetectionFrameRetentionMode } from "#types/detection-timeline";
import type { RenderPreparationOptions } from "#types/render-preparation";
import type {
  MediaSessionDetectionOptions,
  MediaSessionMode,
  MediaSessionRendererOptions,
  MediaSessionWritableDetectionOptions,
} from "#types/media-session";
import { MediaSessionMode as SessionMode } from "#types/media-session";

const DEFAULT_FRAME_RATE = 30;

const FILE_DETECTION_BUFFER_DEFAULTS = {
  bufferAheadSeconds: 10,
  bufferBehindSeconds: 0.5,
  refreshIntervalSeconds: 0.5,
} satisfies DetectionBufferOptions;

const STREAM_DETECTION_BUFFER_DEFAULTS = {
  bufferAheadSeconds: 5,
  bufferBehindSeconds: 5,
  refreshIntervalSeconds: 0.25,
} satisfies DetectionBufferOptions;

const WRITABLE_PREDICTION_GATE_DEFAULTS = {
  enabled: true,
  requiredAheadSeconds: 2,
};

const RENDER_PREPARATION_PLAYBACK_GATE_DEFAULTS = {
  enabled: true,
  minimumAheadSeconds: 0.25,
  requiredAheadSeconds: 1,
};

const MASK_FRAME_DEFAULTS = {
  maxPendingFrameCount: 24,
  scanIntervalSeconds: 0.1,
  scheduleBatchSize: 16,
};

const FILE_MASK_PREFETCH_SECONDS = 7;
const FILE_MASK_CACHE_SECONDS = 8;
const STREAM_MASK_PREFETCH_SECONDS = 3;
const STREAM_MASK_CACHE_SECONDS = 5;
const DEFAULT_STREAM_RETENTION_SECONDS = 300;

export interface ResolvedMediaSessionDefaults {
  readonly detectionBuffer: DetectionBufferOptions;
  readonly renderPreparation: RenderPreparationOptions;
}

export function resolveMediaSessionDefaults(options: {
  readonly detections?: MediaSessionDetectionOptions;
  readonly mode?: MediaSessionMode;
  readonly renderer?: MediaSessionRendererOptions;
}): ResolvedMediaSessionDefaults {
  const mode = options.mode ?? SessionMode.File;
  const userDetectionBuffer = options.detections?.buffer;
  const frameRate = resolveFrameRate(userDetectionBuffer?.frameRate);
  const baseDetectionBuffer =
    mode === SessionMode.Stream
      ? STREAM_DETECTION_BUFFER_DEFAULTS
      : FILE_DETECTION_BUFFER_DEFAULTS;
  const detectionPlaybackGate =
    options.detections?.playbackGate ??
    userDetectionBuffer?.playbackGate ??
    (options.detections?.writable ? WRITABLE_PREDICTION_GATE_DEFAULTS : null);
  const detectionBuffer = {
    ...baseDetectionBuffer,
    ...userDetectionBuffer,
    ...(detectionPlaybackGate
      ? {
          playbackGate: {
            ...(options.detections?.writable
              ? WRITABLE_PREDICTION_GATE_DEFAULTS
              : undefined),
            ...userDetectionBuffer?.playbackGate,
            ...options.detections?.playbackGate,
          },
        }
      : {}),
  };
  const userRenderPreparation = options.renderer?.renderPreparation;
  const maskFrameWindowSeconds =
    mode === SessionMode.Stream
      ? {
          cache: STREAM_MASK_CACHE_SECONDS,
          prefetch: STREAM_MASK_PREFETCH_SECONDS,
        }
      : {
          cache: FILE_MASK_CACHE_SECONDS,
          prefetch: FILE_MASK_PREFETCH_SECONDS,
        };
  const renderPreparation = {
    ...userRenderPreparation,
    maskFrame: {
      ...MASK_FRAME_DEFAULTS,
      maxCacheFrameCount: secondsToFrameCount(
        maskFrameWindowSeconds.cache,
        frameRate,
      ),
      prefetchFrameCount: secondsToFrameCount(
        maskFrameWindowSeconds.prefetch,
        frameRate,
      ),
      ...userRenderPreparation?.maskFrame,
    },
    playbackGate: {
      ...RENDER_PREPARATION_PLAYBACK_GATE_DEFAULTS,
      ...userRenderPreparation?.playbackGate,
    },
  };

  return {
    detectionBuffer,
    renderPreparation,
  };
}

export function resolveMediaSessionWritableRetention(options: {
  readonly mode?: MediaSessionMode;
  readonly writable?: MediaSessionWritableDetectionOptions;
}): DetectionFrameRetentionOptions {
  const mode = options.mode ?? SessionMode.File;
  const userRetention = options.writable?.retention;

  if (userRetention?.mode === DetectionFrameRetentionMode.MemoryOnly) {
    return {
      mode: DetectionFrameRetentionMode.MemoryOnly,
      windowSeconds:
        userRetention.windowSeconds ?? DEFAULT_STREAM_RETENTION_SECONDS,
    };
  }

  if (userRetention?.mode === DetectionFrameRetentionMode.PersistWindow) {
    return {
      mode: DetectionFrameRetentionMode.PersistWindow,
      windowSeconds:
        userRetention.windowSeconds ?? DEFAULT_STREAM_RETENTION_SECONDS,
    };
  }

  if (userRetention?.mode === DetectionFrameRetentionMode.PersistAll) {
    return { mode: DetectionFrameRetentionMode.PersistAll };
  }

  if (mode === SessionMode.Stream) {
    return {
      mode: DetectionFrameRetentionMode.PersistWindow,
      windowSeconds: DEFAULT_STREAM_RETENTION_SECONDS,
    };
  }

  return { mode: DetectionFrameRetentionMode.PersistAll };
}

function resolveFrameRate(frameRate: number | undefined) {
  return frameRate && Number.isFinite(frameRate) && frameRate > 0
    ? frameRate
    : DEFAULT_FRAME_RATE;
}

function secondsToFrameCount(seconds: number, frameRate: number) {
  return Math.max(1, Math.ceil(seconds * frameRate));
}
