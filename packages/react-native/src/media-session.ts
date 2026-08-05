/**
 * Peer-free media-session entry point (`supervision-js-react-native/media-session`).
 *
 * This contract only needs a host-provided source, processor, and renderer, so
 * it must stay loadable without Skia, worklets, or other optional native peers.
 */
export {
  MediaSessionActivityKind,
  MediaSessionActivityStatus,
  MediaSessionMode,
  MediaSessionStatus,
} from "supervision-js-core";
export type {
  DetectionFrame,
  DetectionPickOptions,
  DetectionPickResult,
  MediaRendererPresentation,
  MediaSessionActivity,
  MediaSessionLifecycleState,
  MediaTimelineMetadata,
  PlatformMediaFrame,
} from "supervision-js-core";
export { createMediaSession } from "./sessions/media-session-core";
export {
  MediaSessionError,
  type MediaSession,
  type MediaSessionErrorCode,
  type MediaSessionMediaState,
  type MediaSessionOptions,
  type MediaSessionState,
  type MediaSessionStateListener,
  type MediaSessionStateUnsubscribe,
} from "./types/media-session";
export type {
  MediaFrameProcessor,
  MediaFrameProcessorResult,
} from "./types/frame-processor";
export type {
  MediaFrameSource,
  MediaFrameSourceConsumer,
  MediaSessionCapabilities,
} from "./types/frame-source";
export type {
  MediaRendererAdapter,
  MediaRendererPrepareOptions,
  MediaSessionRendererState,
  MediaSessionRenderPreparationState,
  PreparedMediaFramePacket,
} from "./types/renderer";
