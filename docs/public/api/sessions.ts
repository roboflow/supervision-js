/**
 * Session-level orchestration APIs for one renderer-owned media item.
 *
 * @module Media Sessions
 */

export {
  createMediaSession,
  resolveMediaSessionDefaults,
  MediaSessionActivityKind,
  MediaSessionActivityStatus,
  MediaSessionMode,
  MediaSessionStatus,
  type LiveMediaSession,
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
  type ResolvedMediaSessionDefaults,
} from "supervision";
