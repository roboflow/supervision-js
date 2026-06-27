/**
 * Session-level orchestration APIs for one renderer-owned media item.
 *
 * @module Media Sessions
 */

export {
  createMediaSession,
  MediaSessionActivityKind,
  MediaSessionActivityStatus,
  MediaSessionMode,
  MediaSessionStatus,
  type MediaSession,
  type MediaSessionActivity,
  type MediaSessionAppendableDetectionOptions,
  type MediaSessionDetectionOptions,
  type MediaSessionDetectionSourceOptions,
  type MediaSessionDetectionSourcePresentation,
  type MediaSessionDetectionSyncOptions,
  type MediaSessionDetectionWriteOptions,
  type MediaSessionMedia,
  type MediaSessionMediaState,
  type MediaSessionNormalizationOptions,
  type MediaSessionNormalizationState,
  type MediaSessionOptions,
  type MediaSessionRendererOptions,
  type MediaSessionState,
  type MediaSessionStateListener,
  type MediaSessionStateUnsubscribe,
  type MediaSessionWritableDetectionOptions,
} from "supervision-js";
