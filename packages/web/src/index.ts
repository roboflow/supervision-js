// Advanced detection sources and storage.
export { createArrayDetectionFrameSource } from "supervision-js-core";
export { createBrowserColdDetectionFrameStore } from "#detections/browser-cold-detection-frame-store";
export { createBufferedDetectionTimeline } from "supervision-js-core";
export { createChunkedDetectionFrameSource } from "#detections/chunked-detection-frame-source";
export { createColdDetectionFrameSource } from "supervision-js-core";
export { createCompositeDetectionFrameSource } from "supervision-js-core";
export { createMemoryColdDetectionFrameStore } from "supervision-js-core";
export { createProjectedDetectionFrameSource } from "supervision-js-core";
export { createWritableDetectionFrameSource } from "supervision-js-core";
export {
  projectDetectionFrame,
  projectDetectionFrames,
} from "supervision-js-core";
export {
  createByteTrackTracker,
  createCBIoUTracker,
  createOCSortTracker,
  createSortTracker,
  detectionPostProcessors,
  projectDetectionFrameForTracking,
  TrackingGeometry,
  type ByteTrackTracker,
  type ByteTrackTrackerUpdate,
  type ByteTrackTrackingDetectionPostProcessor,
  type ByteTrackTrackingOptions,
  type CBIoUTracker,
  type CBIoUTrackerUpdate,
  type CBIoUTrackingDetectionPostProcessor,
  type CBIoUTrackingOptions,
  type DetectionPostProcessor,
  type DetectionPostProcessorFactory,
  type OCSortTracker,
  type OCSortTrackerUpdate,
  type OCSortTrackingDetectionPostProcessor,
  type OCSortTrackingOptions,
  type SortTracker,
  type SortTrackerUpdate,
  type SortTrackingOptions,
  type TrackingAssignment,
  type TrackingDetectionPostProcessor,
  type TrackingProjection,
  type TrackingTracker,
} from "supervision-js-core";
export { createDetectionPostProcessingPipeline } from "#post-processing/detection-post-processing-pipeline";
export { createDefaultDetectionPostProcessingWorkerFactory } from "#post-processing/default-tracking-worker";
export {
  DetectionPostProcessingMode,
  type DetectionPostProcessingAppendResult,
  type DetectionPostProcessingDiagnostics,
  type DetectionPostProcessingPipeline,
  type DetectionPostProcessingPipelineOptions,
  type DetectionPostProcessingWorkerFactory,
} from "#types/detection-post-processing";

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
export type {
  PresentedFrameChannel,
  PresentedFrameChannelSignal,
  PresentedFrameChannelStatus,
  PresentedFrameId,
  PresentedFramePlayhead,
  PresentedFrameSeekIntent,
  PresentedFrameSource,
  PresentedVideoFrame,
} from "#renderers/presented-frame-channel";
export {
  createImageUrlMediaSource,
  createStaticImageMediaSource,
  type HostFrameSource,
  type StaticImageSource,
} from "#media/static-image-media-source";
export {
  createMediaStreamRendererSource,
  type MediaStreamPresentedFrame,
  type MediaStreamRendererSourceOptions,
} from "#media/media-stream-media-source";
export {
  MediaSourceError,
  getMediaErrorKind,
  isMediaSourceError,
  toMediaSourceError,
} from "#media/media-errors";
export {
  createVideoEngineMediaRendererSource,
  openVideoEngineMediaSource,
  type VideoEngineMediaSource,
  type VideoEngineMediaSourceOptions,
} from "#media/video-engine-media-source";

// Renderer and session primitives.
export { createMediaRenderer } from "#renderers/media-renderer";
export type {
  PreparedAnnotationWindowFrame,
  PreparedAnnotationWindowSnapshot,
} from "#renderers/prepared-annotation-window";
export { createMediaSession } from "#sessions/media-session";
export {
  resolveMediaSessionDefaults,
  type ResolvedMediaSessionDefaults,
} from "#sessions/media-session-defaults";
export type {
  MediaFrameCapture,
  MediaFrameCaptureOptions,
} from "#types/media-renderer";

// Presentation styles.
export { BaseBoxStyle } from "supervision-js-core";
export type { BaseBoxStyleOptions } from "supervision-js-core";
export { BaseBoxCornerStyle } from "supervision-js-core";
export type { BaseBoxCornerStyleOptions } from "supervision-js-core";
export { BaseFocusStyle } from "supervision-js-core";
export type { BaseFocusStyleOptions } from "supervision-js-core";
export { BaseInteractionStyle } from "supervision-js-core";
export type { BaseInteractionStyleOptions } from "supervision-js-core";
export { BaseLabelStyle } from "supervision-js-core";
export type { BaseLabelStyleOptions } from "supervision-js-core";
export { BaseMaskStyle } from "supervision-js-core";
export type { BaseMaskStyleOptions } from "supervision-js-core";
export { BaseMarkerStyle } from "supervision-js-core";
export type { BaseMarkerStyleOptions } from "supervision-js-core";
export { BasePolygonStyle } from "supervision-js-core";
export type { BasePolygonStyleOptions } from "supervision-js-core";
export { BasePolylineStyle } from "supervision-js-core";
export type { BasePolylineStyleOptions } from "supervision-js-core";
export { BaseKeypointStyle, KeypointMarkerShape } from "supervision-js-core";
export type { BaseKeypointStyleOptions } from "supervision-js-core";
export {
  annotationRendererKinds,
  annotationRenderers,
  type AnnotationRenderer,
  type AnnotationRendererFactory,
  type AnnotationRendererKind,
  type BoxAnnotationRenderer,
  type BoxCornerAnnotationRenderer,
  type EllipseAnnotationRenderer,
  type KeypointAnnotationRenderer,
  type LabelAnnotationRenderer,
  type MaskAnnotationRenderer,
  type MaskHaloAnnotationRenderer,
  type MarkerAnnotationRenderer,
  type PolygonAnnotationRenderer,
  type PolylineAnnotationRenderer,
  RegionRendererComposeMode,
  RegionRendererCoverageKind,
  RegionRendererMediaEffectKind,
  RegionRendererRegionKind,
  RegionRendererSizeSpace,
  RegionRendererSourceKind,
  type RegionAnnotationRenderer,
  type RegionRendererAssetReference,
  type RegionRendererAssetSource,
  type RegionRendererBoundsRegion,
  type RegionRendererCompose,
  type RegionRendererMaskCoverage,
  type RegionRendererBlurEffect,
  type RegionRendererMediaEffect,
  type RegionRendererPixelateEffect,
  type RegionRendererPolygonCoverage,
  type RegionRendererKeypointAnchorRegion,
  type RegionRendererMediaSource,
  type RegionRendererRegion,
  type RegionRendererRelativeTransform,
  type RegionRendererSize,
  type RegionRendererSizedTransform,
  type RegionRendererSource,
  type RegionRendererTarget,
  type RegionRendererTargetContext,
  type RegionRendererTargetValue,
  type RegionRendererTransform,
} from "supervision-js-core";
export {
  createDefaultAnnotationPresentation,
  type DefaultAnnotationPresentationOptions,
} from "supervision-js-core";
export {
  DEFAULT_DETECTION_CLASS_STYLES,
  DEFAULT_DETECTION_COLOR_SEQUENCE,
  SUPERVISION_ROBOFLOW_COLOR,
  normalizeDetectionClassName,
  resolveDetectionClassColorStyle,
  type DetectionClassColorStyle,
} from "supervision-js-core";
export { BoxShape, BoxStrokeAlignment } from "supervision-js-core";
export type {
  BoxCornerDrawInstruction,
  BoxCornerStyle,
  BoxCornerStyleContext,
} from "supervision-js-core";
export type {
  BoxDrawInstruction,
  BoxFillStyle,
  BoxStrokeStyle,
  BoxStyle,
  BoxStyleContext,
} from "supervision-js-core";
export type {
  EllipseDrawInstruction,
  EllipseStyle,
  EllipseStyleContext,
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
export { LabelPlacement, LabelVisibilityMode } from "supervision-js-core";
export type {
  DetectionStylePredicate,
  DetectionStyleValue,
} from "supervision-js-core";
export type {
  MaskDrawInstruction,
  MaskHaloDrawInstruction,
  MaskHaloStyle,
  MaskHaloStyleContext,
  MaskStrokeStyle,
  MaskStrokeStyleOptions,
  MaskStyle,
  MaskStyleContext,
} from "supervision-js-core";
export { MaskRenderMode } from "supervision-js-core";
export { MarkerShape, MarkerSizeSpace } from "supervision-js-core";
export type {
  ClosedMarkerDrawInstruction,
  CrossMarkerDrawInstruction,
  MarkerDrawInstruction,
  MarkerStyle,
  MarkerStyleContext,
} from "supervision-js-core";
export type {
  PolygonDrawInstruction,
  PolygonStyle,
  PolygonStyleContext,
  PolylineDrawInstruction,
  PolylineStyle,
  PolylineStyleContext,
  KeypointDrawInstruction,
  KeypointEdgeDrawInstruction,
  KeypointMarkerDrawInstruction,
  KeypointStyle,
  KeypointStyleContext,
} from "supervision-js-core";
export type {
  AnnotationEditingPreviewStyleContext,
  AnnotationOverlayStyle,
  AnnotationVisibility,
  MediaDisplayAdjustments,
  PreviewOverlayData,
  ViewportTransform,
} from "supervision-js-core";
export type {
  MediaPreparationOptions,
  PreparedMedia,
  ProgressivePreparedMedia,
} from "#types/media-preparation";
export type { MaskBrushPreviewOptions } from "./editing";
export {
  DetectionBufferStatus,
  DetectionFrameRetentionMode,
  DetectionFrameSelectionMode,
  type BufferedDetectionTimeline,
  type ColdDetectionFrameStore,
  type ColdDetectionFrameStoreLoadOptions,
  type ColdDetectionFrameStorePruneOptions,
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
  type DetectionFrameLoadOptions,
  type DetectionFrameLiveOptions,
  type DetectionFrameRetentionOptions,
  type DetectionFrameSelectionOptions,
  type DetectionFrameSource,
  type DetectionFrameSourceChanges,
  type DetectionFrameSourceVersionRange,
  type DetectionPlaybackGateOptions,
  type DetectionTimelineContext,
  type LiveWritableDetectionFrameSource,
  type WritableDetectionFrameSource,
  type WritableDetectionFrameSourceOptions,
} from "supervision-js-core";
export {
  DetectionMaskEncoding,
  KeypointVisibility,
  type CompressedRleDetectionMask,
  type Detection,
  type DetectionCoordinateSpace,
  type DetectionFrame,
  type DetectionMask,
  type KeypointEdge,
  type KeypointGeometry,
  type Point,
  type PolygonGeometry,
  type PolylineGeometry,
  type Rect,
  type SkeletonDefinition,
  type SkeletonDefinitions,
  type SkeletonEdgeDefinition,
  type SkeletonVertexDefinition,
  type TopLeftRect,
} from "supervision-js-core";
export type {
  MediaFrameMetadata,
  MediaTimelineMetadata,
  PlatformMediaFrame,
  PlatformMediaFrameSource,
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
  DEFAULT_NORMALIZATION_FRAME_RATE,
  type MediaProbeIssue,
  type MediaProbeOptions,
  type MediaProbeResult,
  type MediaProbeTargetProfile,
  type MediaProbeVideoTrack,
  type NormalizedMedia,
  type ProgressiveNormalizedMedia,
} from "#types/media-normalization";
export {
  type LiveMediaSession,
  type MediaSession,
  MediaSessionActivityKind,
  MediaSessionActivityStatus,
  MediaSessionMediaBranch,
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
  type MediaSessionMediaPreparation,
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
export { MediaErrorKind, PlaybackGateReach } from "supervision-js-core";
export {
  DetectionTimelineOrigin,
  MediaRendererFit,
  MediaRendererPlaybackState,
  MediaSourceStatus,
  type MediaRendererDiagnosticsOptions,
  type MediaRendererAssetError,
  type DetectionLabelBounds,
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
