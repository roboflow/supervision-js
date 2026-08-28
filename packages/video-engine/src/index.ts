// The runtime's public contract. Everything a consumer needs to open a source,
// move the playhead, read state, and handle failure is here; nothing else is.
// Internals stay exported from their own modules for the engine's own use, so
// adding a name here is a decision to support it.
//
// Value exports are load-bearing on bundle shape: a value re-export pulls its
// whole import graph, and the cursor factory reaches the demuxer, so a consumer
// wanting one type would pull it too. Types are erased and cost nothing.
//
// Batch frame extraction has its own entry point, `analysis`, because it opens a
// source directly and reaches the demuxer without going through the engine.

export { VideoEngine } from "./video-engine";
export type { VideoEngineHandle, VideoEngineOptions } from "./video-engine";

/* ---------------------------------------------------------------- the source */
export { SourceKind } from "./types";
export type {
  BlobVideoSource,
  StreamVideoSource,
  UrlSourceReadConfig,
  UrlVideoSource,
  VideoMetadata,
  VideoSource,
} from "./types";

/* ----------------------------------------------------------- what it is doing */
export { PlaybackStatus } from "./types";
export type {
  EngineChannel,
  EngineReadySnapshot,
  PaintSeq,
  PlaybackState,
} from "./types";

/* -------------------------------------------------- presenting outside a canvas */
export type { PresentationMode } from "./types";
export type { PresentedFrame } from "./worker-protocol";
export type { PresentedFrameHandler } from "./video-engine";
export type { FrameQuality } from "./scrub-cursor";
export type { Rotation } from "./rotation";

/* ---------------------------------------------------------- naming the frames */
export { FrameTimeline } from "./frame-timeline";
export type {
  FrameId,
  FrameLanding,
  FrameTimelineData,
  TickRate,
} from "./frame-timeline";

/* ------------------------------------------------- moving the playhead, units */
export type { SeekIntent } from "./scrub-cursor";
export type { SeekTarget } from "./video-engine";
export { PLAYBACK_RATE } from "./constants";
export { asFps, asPaintSeq, asSec } from "./types";
export type { Fps, Sec } from "./types";

/* ------------------------------------------------------ how much to decode at */
export {
  cappedResolution,
  displayBoxResolution,
  nativeResolution,
  viewportResolution,
} from "./decode-resolution";
export type {
  DecodeResolutionStrategy,
  DisplayBoxResolutionOptions,
  ViewportResolutionOptions,
} from "./decode-resolution";

/* ----------------------------------------------------------- when it goes wrong */
export { VideoEngineError, VideoEngineErrorCode } from "./types";
export type { Warning, WarningSeverity } from "./diagnostics";

/* ----------------------------------------------------------------- instruments */
export type {
  DiagnosticsSnapshot,
  SourceResidencyDiagnostics,
} from "./diagnostics";
export type { SourceResidencyConfig } from "./worker-protocol";
export { DIAGNOSTICS, TRACE_RING_BOUNDS } from "./constants";
