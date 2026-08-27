import type {
  DetectionBufferOptions,
  DetectionFrameRetentionOptions,
} from "supervision-js-core";
import { DetectionFrameRetentionMode } from "supervision-js-core";
import type { RenderPreparationOptions } from "#types/render-preparation";
import type {
  MediaSessionAppendableDetectionOptions,
  MediaSessionMode,
  MediaSessionOptions,
} from "#types/media-session";
import { MediaSessionMode as SessionMode } from "#types/media-session";

const DEFAULT_FRAME_RATE = 30;

/**
 * The refresh interval rebuilds a window that already covers the playhead. A gap
 * the window does not reach reloads immediately whatever this says, so this only
 * decides how often covered ground is derived again, and a file's detections do
 * not change under it. Rebuilding a 10 second window every half second cost 15
 * rebuilds a second at 8x playback, each re-deriving a window overlapping the
 * one it replaced by 95%. A stream keeps the short interval below, because there
 * the source really does gain data.
 */
const FILE_DETECTION_BUFFER_DEFAULTS = {
  bufferAheadSeconds: 10,
  bufferBehindSeconds: 0.5,
  refreshIntervalSeconds: 2.5,
} satisfies DetectionBufferOptions;

const STREAM_DETECTION_BUFFER_DEFAULTS = {
  bufferAheadSeconds: 5,
  bufferBehindSeconds: 5,
  refreshIntervalSeconds: 0.25,
} satisfies DetectionBufferOptions;

/**
 * Playback waits for annotations unless a host says otherwise, so a viewer sees
 * a frame and the marks that belong to it together rather than a picture that
 * fills in afterwards. `playbackGate: false` on the session, or either gate's
 * own `enabled`, turns it off.
 */
const DETECTION_PLAYBACK_GATE_DEFAULTS = {
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

/**
 * The detection-buffer and render-preparation configuration a session created
 * with these options actually runs on.
 *
 * `createMediaSession` resolves its options through this, so a host can read
 * the numbers a session will use, and show or log them, without restating the
 * defaults itself.
 */
export function resolveMediaSessionDefaults(
  options: Pick<
    MediaSessionOptions,
    "detections" | "mode" | "playbackGate" | "renderer"
  >,
): ResolvedMediaSessionDefaults {
  const mode = options.mode ?? SessionMode.File;
  const appendableDetections =
    options.detections?.appendable ?? options.detections?.writable;
  const hasAppendableDetections =
    appendableDetections !== undefined ||
    options.detections?.sources?.some(
      (source) => source.appendable !== undefined,
    ) === true;
  const userDetectionBuffer = options.detections?.buffer;
  const frameRate = resolveFrameRate(
    userDetectionBuffer?.frameRate ?? options.detections?.sync?.frameRate,
  );
  const baseDetectionBuffer =
    mode === SessionMode.Stream
      ? STREAM_DETECTION_BUFFER_DEFAULTS
      : FILE_DETECTION_BUFFER_DEFAULTS;
  const inheritsGateLookahead =
    hasAppendableDetections || options.playbackGate === true;
  const detectionPlaybackGate =
    options.detections?.playbackGate ??
    userDetectionBuffer?.playbackGate ??
    (inheritsGateLookahead ? DETECTION_PLAYBACK_GATE_DEFAULTS : null);
  const detectionBuffer = {
    ...baseDetectionBuffer,
    ...options.detections?.sync,
    ...userDetectionBuffer,
    ...(detectionPlaybackGate
      ? {
          playbackGate: {
            ...(inheritsGateLookahead
              ? DETECTION_PLAYBACK_GATE_DEFAULTS
              : undefined),
            // The session switch is the coarse answer; a gate's own `enabled`
            // is the specific one and wins.
            ...(options.playbackGate === false
              ? { enabled: false }
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
      ...(options.playbackGate === false ? { enabled: false } : undefined),
      ...userRenderPreparation?.playbackGate,
    },
  };

  return {
    detectionBuffer,
    renderPreparation,
  };
}

export function resolveMediaSessionAppendableRetention(options: {
  readonly mode?: MediaSessionMode;
  readonly appendable?: MediaSessionAppendableDetectionOptions;
}): DetectionFrameRetentionOptions {
  const mode = options.mode ?? SessionMode.File;
  const userRetention = options.appendable?.retention;

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

export function resolveMediaSessionWritableRetention(options: {
  readonly mode?: MediaSessionMode;
  readonly writable?: MediaSessionAppendableDetectionOptions;
}): DetectionFrameRetentionOptions {
  return resolveMediaSessionAppendableRetention({
    appendable: options.writable,
    mode: options.mode,
  });
}

function resolveFrameRate(frameRate: number | undefined) {
  return frameRate && Number.isFinite(frameRate) && frameRate > 0
    ? frameRate
    : DEFAULT_FRAME_RATE;
}

function secondsToFrameCount(seconds: number, frameRate: number) {
  return Math.max(1, Math.ceil(seconds * frameRate));
}
