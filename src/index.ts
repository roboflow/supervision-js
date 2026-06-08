// Advanced detection sources and storage.
export { createArrayDetectionFrameSource } from "#detections/array-detection-frame-source";
export { createBrowserColdDetectionFrameStore } from "#detections/browser-cold-detection-frame-store";
export { createBufferedDetectionTimeline } from "#detections/buffered-detection-timeline";
export { createChunkedDetectionFrameSource } from "#detections/chunked-detection-frame-source";
export { createColdDetectionFrameSource } from "#detections/cold-detection-frame-source";
export { createMemoryColdDetectionFrameStore } from "#detections/memory-cold-detection-frame-store";
export { createWritableDetectionFrameSource } from "#detections/writable-detection-frame-source";

// Interaction and picking.
export { pickDetectionAtPoint } from "#interactions/detection-picker";

// Media preparation.
export {
  normalizeMedia,
  normalizeMediaProgressively,
} from "#media/media-normalization";
export {
  prepareMedia,
  prepareMediaProgressively,
  MediaPreparationError,
} from "#media/media-preparation";
export { probeMedia } from "#media/media-probe";

// Advanced media-source contracts.
export type {
  DecodedMediaSource,
  DecodedMediaSourceMetadata,
  DecodedVideoSample,
  DecodedVideoSampleSink,
  DisposableMediaInput,
} from "#media/media-source";

// Renderer and session primitives.
export { createMediaRenderer } from "#renderers/media-renderer";
export { createMediaSession } from "#sessions/media-session";

// Presentation styles.
export { BaseBoxStyle, RoundedBoxStyle } from "#styles/box-style";
export type {
  BaseBoxStyleOptions,
  RoundedBoxStyleOptions,
} from "#styles/box-style";
export { BaseLabelStyle } from "#styles/label-style";
export type { BaseLabelStyleOptions } from "#styles/label-style";
export { BaseMaskStyle } from "#styles/mask-style";
export type { BaseMaskStyleOptions } from "#styles/mask-style";
export { BoxShape } from "#types/box-style";
export type {
  BoxDrawInstruction,
  BoxFillStyle,
  BoxStrokeStyle,
  BoxStyle,
  BoxStyleContext,
} from "#types/box-style";
export type {
  LabelBackgroundStyle,
  LabelDrawInstruction,
  LabelStyle,
  LabelStyleContext,
  LabelTextStyle,
} from "#types/label-style";
export type {
  DetectionStylePredicate,
  DetectionStyleValue,
} from "#types/style";
export type {
  MaskDrawInstruction,
  MaskStrokeStyle,
  MaskStyle,
  MaskStyleContext,
} from "#types/mask-style";
export type {
  MediaPreparationOptions,
  PreparedMedia,
  ProgressivePreparedMedia,
} from "#types/media-preparation";
export {
  DetectionBufferStatus,
  DetectionFrameRetentionMode,
  DetectionFrameSelectionMode,
  type BufferedDetectionTimeline,
  type ColdDetectionFrameStore,
  type ColdDetectionFrameStoreLoadOptions,
  type ColdDetectionFrameStoreWriteOptions,
  type ColdDetectionFrameStoreWriteSummary,
  type ChunkedDetectionFrameSourceOptions,
  type DetectionBufferOptions,
  type DetectionBufferPrepareOptions,
  type DetectionBufferState,
  type DetectionFrameChunk,
  type DetectionFrameChunkDescriptor,
  type DetectionFrameChunkFetch,
  type DetectionFrameChunkManifest,
  type DetectionFrameRetentionOptions,
  type DetectionFrameSelectionOptions,
  type DetectionFrameSource,
  type DetectionFrameSourceVersionRange,
  type DetectionPlaybackGateOptions,
  type DetectionTimelineContext,
  type WritableDetectionFrameSource,
} from "#types/detection-timeline";
export {
  DetectionMaskEncoding,
  type CompressedRleDetectionMask,
  type Detection,
  type DetectionFrame,
  type DetectionMask,
  type Rect,
} from "#types/detections";
export {
  DetectionPickTarget,
  MediaInteractionMode,
  type DetectionPickOptions,
  type DetectionPickPoint,
  type DetectionPickResult,
  type MediaInteractionOptions,
} from "#types/interaction";
export {
  MediaNormalizationAudioCodec,
  MediaNormalizationContainer,
  MediaNormalizationFit,
  MediaNormalizationVideoCodec,
  MediaProbeIssueCode,
  MediaProbeStatus,
  type MediaNormalizationAudioOptions,
  type MediaNormalizationInputMetadata,
  type MediaNormalizationOptions,
  type MediaNormalizationOutputProgress,
  type MediaNormalizationProgress,
  type MediaNormalizationVideoOptions,
  type MediaProbeIssue,
  type MediaProbeOptions,
  type MediaProbeResult,
  type MediaProbeTargetProfile,
  type MediaProbeVideoTrack,
  type NormalizedMedia,
  type ProgressiveNormalizedMedia,
} from "#types/media-normalization";
export {
  type MediaSession,
  MediaSessionActivityKind,
  MediaSessionActivityStatus,
  MediaSessionMode,
  MediaSessionStatus,
  type MediaSessionActivity,
  type MediaSessionAppendableDetectionOptions,
  type MediaSessionDetectionOptions,
  type MediaSessionDetectionSyncOptions,
  type MediaSessionMedia,
  type MediaSessionMediaState,
  type MediaSessionNormalizationState,
  type MediaSessionNormalizationOptions,
  type MediaSessionOptions,
  type MediaSessionRendererOptions,
  type MediaSessionState,
  type MediaSessionStateListener,
  type MediaSessionStateUnsubscribe,
  type MediaSessionWritableDetectionOptions,
} from "#types/media-session";
export {
  MediaRendererFit,
  MediaRendererPlaybackState,
  MediaSourceStatus,
  type MediaRendererDiagnosticsOptions,
  type MediaFrameDiagnostics,
  type MediaFrameRenderTimings,
  type MediaRenderer,
  type MediaRendererOptions,
  type MediaRendererPresentation,
  type MediaRendererSource,
  type MediaRendererState,
  type MediaSourceState,
} from "#types/media-renderer";
export {
  RenderPreparationArtifactFrameStatus,
  RenderPreparationArtifactKind,
  RenderPreparationExecutionMode,
  RenderPreparationMode,
  RenderPreparationWorkerStatus,
  type RenderPreparationActiveFrameDiagnostics,
  type RenderPreparationArtifactDiagnostics,
  type RenderPreparationArtifactWindowDiagnostics,
  type RenderPreparationDiagnostics,
  type RenderPreparationMaskFrameOptions,
  type RenderPreparationOptions,
  type RenderPreparationPlaybackGateOptions,
  type RenderPreparationWorkerFactory,
} from "#types/render-preparation";
