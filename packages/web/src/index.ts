// Advanced detection sources and storage.
export { createArrayDetectionFrameSource } from "supervision-js-core";
export { createBrowserColdDetectionFrameStore } from "#detections/browser-cold-detection-frame-store";
export { createBufferedDetectionTimeline } from "supervision-js-core";
export { createChunkedDetectionFrameSource } from "#detections/chunked-detection-frame-source";
export { createColdDetectionFrameSource } from "supervision-js-core";
export { createCompositeDetectionFrameSource } from "supervision-js-core";
export { createMemoryColdDetectionFrameStore } from "supervision-js-core";
export { createWritableDetectionFrameSource } from "supervision-js-core";

// Interaction and picking.
export { pickDetectionAtPoint } from "supervision-js-core";

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
export { BaseBoxStyle } from "supervision-js-core";
export type { BaseBoxStyleOptions } from "supervision-js-core";
export { BaseFocusStyle } from "supervision-js-core";
export type { BaseFocusStyleOptions } from "supervision-js-core";
export { BaseInteractionStyle } from "supervision-js-core";
export type { BaseInteractionStyleOptions } from "supervision-js-core";
export { BaseLabelStyle } from "supervision-js-core";
export type { BaseLabelStyleOptions } from "supervision-js-core";
export { BaseMaskStyle } from "supervision-js-core";
export type { BaseMaskStyleOptions } from "supervision-js-core";
export { BoxShape, BoxStrokeAlignment } from "supervision-js-core";
export type {
  BoxDrawInstruction,
  BoxFillStyle,
  BoxStrokeStyle,
  BoxStyle,
  BoxStyleContext,
} from "supervision-js-core";
export type {
  FocusDrawInstruction,
  FocusFallbackStyle,
  FocusFillStyle,
  FocusStyle,
  FocusStyleContext,
  FocusStyleValue,
} from "supervision-js-core";
export { FocusTargetMode } from "supervision-js-core";
export type {
  LabelBackgroundStyle,
  LabelDrawInstruction,
  LabelOffsetStyle,
  LabelStyle,
  LabelStyleContext,
  LabelTextStyle,
} from "supervision-js-core";
export { LabelPlacement } from "supervision-js-core";
export type {
  DetectionStylePredicate,
  DetectionStyleValue,
} from "supervision-js-core";
export type {
  MaskDrawInstruction,
  MaskStrokeStyle,
  MaskStrokeStyleOptions,
  MaskStyle,
  MaskStyleContext,
} from "supervision-js-core";
export { MaskRenderMode } from "supervision-js-core";
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
  type CompositeDetectionFrameSourceEntry,
  type CompositeDetectionFrameSourceOptions,
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
} from "supervision-js-core";
export {
  DetectionMaskEncoding,
  type CompressedRleDetectionMask,
  type Detection,
  type DetectionFrame,
  type DetectionMask,
  type Rect,
} from "supervision-js-core";
export {
  DetectionPickTarget,
  MediaInteractionMode,
  type DetectionPickOptions,
  type DetectionPickPoint,
  type DetectionPickResult,
  type DetectionSelectionOptions,
  type MediaInteractionOptions,
} from "supervision-js-core";
export {
  DetectionInteractionState,
  type InteractionPresentation,
  type InteractionStyle,
  type InteractionStyleContext,
} from "supervision-js-core";
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
  type MediaSessionDetectionSourceOptions,
  type MediaSessionDetectionSourcePresentation,
  type MediaSessionDetectionSyncOptions,
  type MediaSessionDetectionWriteOptions,
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
  type MediaRendererQuality,
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
