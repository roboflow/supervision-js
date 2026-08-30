/**
 * The web video engine that decodes and presents video files, available from
 * the `supervision/web-video-engine` entrypoint.
 *
 * The engine owns the playhead and announces every frame it puts on screen. A
 * media session reaches it through the two adapters here, which load it the
 * moment one of them opens a source, so an application that only ever renders
 * still images never downloads it.
 *
 * @module Video Engine
 */

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
  createVideoEngineMediaRendererSource,
  displayBoxResolution,
  nativeResolution,
  openVideoEngineMediaSource,
  viewportResolution,
  type BlobVideoSource,
  type DecodeResolutionStrategy,
  type DiagnosticsSnapshot,
  type DisplayBoxResolutionOptions,
  type EngineChannel,
  type EngineReadySnapshot,
  type Fps,
  type FrameId,
  type FrameLanding,
  type FrameQuality,
  type FrameTimelineData,
  type PaintSeq,
  type PlaybackState,
  type PresentationMode,
  type PresentedFrame,
  type PresentedFrameHandler,
  type Rotation,
  type Sec,
  type SeekIntent,
  type SeekTarget,
  type SourceResidencyConfig,
  type SourceResidencyDiagnostics,
  type StreamVideoSource,
  type TickRate,
  type UrlVideoSource,
  type VideoEngineMediaSource,
  type VideoEngineMediaSourceOptions,
  type VideoEngineOptions,
  type VideoMetadata,
  type VideoSource,
  type ViewportResolutionOptions,
  type Warning,
  type WarningSeverity,
} from "supervision/web-video-engine";
