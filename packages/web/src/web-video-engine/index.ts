/**
 * The web video engine, and the two adapters that hand what it decodes to a
 * media renderer.
 *
 * The engine's own barrel is wider than this, because its modules export for
 * one another. A name reaches an application only by being listed here, so
 * listing one is a decision to support it. Worker message shapes, mediabunny
 * pass-through configuration, and the React imperative handle stay inside.
 */
export {
  createVideoEngineMediaRendererSource,
  openVideoEngineMediaSource,
  type VideoEngineMediaSource,
  type VideoEngineMediaSourceOptions,
} from "supervision";
export {
  DIAGNOSTICS,
  FrameTimeline,
  PLAYBACK_RATE,
  PlaybackStatus,
  SourceKind,
  TRACE_RING_BOUNDS,
  VideoEngine,
  VideoEngineError,
  VideoEngineErrorCode,
  cappedResolution,
  displayBoxResolution,
  nativeResolution,
  viewportResolution,
} from "#web-video-engine";
export type {
  BlobVideoSource,
  DecodeResolutionStrategy,
  DiagnosticsSnapshot,
  DisplayBoxResolutionOptions,
  EngineChannel,
  EngineReadySnapshot,
  Fps,
  FrameId,
  FrameLanding,
  FrameQuality,
  FrameTimelineData,
  PaintSeq,
  PlaybackState,
  PresentationMode,
  PresentedFrame,
  PresentedFrameHandler,
  Rotation,
  Sec,
  SeekIntent,
  SeekTarget,
  SourceResidencyConfig,
  SourceResidencyDiagnostics,
  StreamVideoSource,
  TickRate,
  UrlVideoSource,
  VideoEngineOptions,
  VideoMetadata,
  VideoSource,
  ViewportResolutionOptions,
  Warning,
  WarningSeverity,
} from "#web-video-engine";
