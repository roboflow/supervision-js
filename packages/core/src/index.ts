// Detection sources and storage.
export { createArrayDetectionFrameSource } from "#detections/array-detection-frame-source";
export {
  createBufferedDetectionTimeline,
  createIdleDetectionBufferState,
  getBufferedDetectionTimelineFrameSnapshot,
} from "#detections/buffered-detection-timeline";
export { createColdDetectionFrameSource } from "#detections/cold-detection-frame-source";
export { createCompositeDetectionFrameSource } from "#detections/composite-detection-frame-source";
export {
  AnnotationFrameMutationKind,
  createEditableAnnotationFrameSession,
  type AnnotationFrameMutation,
  type AnnotationFrameMutationListener,
  type DetectionId,
  type EditableDetection,
  type EditableAnnotationFrameSession,
} from "#detections/editable-annotation-frame-session";
export { createMemoryColdDetectionFrameStore } from "#detections/memory-cold-detection-frame-store";
export { createWritableDetectionFrameSource } from "#detections/writable-detection-frame-source";

// Interaction and picking.
export {
  createDetectionPickKey,
  followDetectionPickAcrossFrames,
  haveSameDetectionPickIdentities,
  pickDetectionAtPoint,
  pickDetectionByMaskId,
  rebaseDetectionPickToFrame,
} from "#interactions/detection-picker";
export {
  createViewportController,
  mediaToScreen,
  screenToMedia,
} from "#interactions/viewport-controller";
export { createAnnotationEditingEngine } from "#interactions/annotation-editing-engine";
export {
  applyAnnotationHandleDrag,
  deleteAnnotationVertex,
  findClosestAnnotationSegment,
  getAnnotationHandles,
  offsetDetection,
  pickAnnotationHandle,
} from "#interactions/annotation-handles";

// Presentation styles.
export { BaseBoxStyle } from "#styles/box-style";
export type { BaseBoxStyleOptions } from "#styles/box-style";
export { BaseFocusStyle } from "#styles/focus-style";
export type { BaseFocusStyleOptions } from "#styles/focus-style";
export { BaseInteractionStyle } from "#styles/interaction-style";
export type { BaseInteractionStyleOptions } from "#styles/interaction-style";
export { BaseLabelStyle } from "#styles/label-style";
export type { BaseLabelStyleOptions } from "#styles/label-style";
export { BaseMaskStyle } from "#styles/mask-style";
export type { BaseMaskStyleOptions } from "#styles/mask-style";
export { BasePolygonStyle } from "#styles/polygon-style";
export type { BasePolygonStyleOptions } from "#styles/polygon-style";
export { BasePolylineStyle } from "#styles/polyline-style";
export type { BasePolylineStyleOptions } from "#styles/polyline-style";
export { BaseKeypointStyle } from "#styles/keypoint-style";
export type { BaseKeypointStyleOptions } from "#styles/keypoint-style";
export {
  createDefaultAnnotationPresentation,
  type DefaultAnnotationPresentationOptions,
} from "#styles/default-annotation-presentation";
export {
  annotationRendererKinds,
  annotationRenderers,
  type AnnotationRenderer,
  type AnnotationRendererFactory,
  type AnnotationRendererKind,
  type BoxAnnotationRenderer,
  type EllipseAnnotationRenderer,
  type KeypointAnnotationRenderer,
  type LabelAnnotationRenderer,
  type MaskAnnotationRenderer,
  type PolygonAnnotationRenderer,
  type PolylineAnnotationRenderer,
  RegionRendererComposeMode,
  RegionRendererRegionKind,
  RegionRendererSourceKind,
  type RegionAnnotationRenderer,
  type RegionRendererAssetReference,
  type RegionRendererAssetSource,
  type RegionRendererBoundsRegion,
  type RegionRendererCompose,
  type RegionRendererKeypointAnchorRegion,
  type RegionRendererRegion,
  type RegionRendererTarget,
  type RegionRendererTargetContext,
  type RegionRendererTargetValue,
  type RegionRendererTransform,
} from "#types/annotation-renderer";
export { resolveAnnotationRendererPresentation } from "#styles/annotation-renderer-presentation";
export {
  createSourceAwarePresentation,
  type PresentationStyleSet,
  type SourceAwarePresentationOptions,
  type SourcePresentation,
  type SourcePresentationEntry,
} from "#styles/source-presentation";
export { resolveStyleValue } from "#styles/style-value";

// Pure utilities used by platform packages.
export {
  copySortedDetectionFrames,
  decodeCompressedRleMask,
  decodeCompressedRleCounts,
  detectionFrameOverlapsRange,
  encodeCompressedRleCounts,
  filterDetectionFramesForRange,
  selectDetectionFrame,
  validateDetectionFrames,
  type DecodedDetectionMask,
} from "#utils/detection-frames";
export {
  convertDetectionBoxToMask,
  convertDetectionBoxToPolygon,
  convertDetectionMaskToBox,
  convertDetectionMaskToPolygon,
  convertDetectionPolygonToBox,
  convertDetectionPolygonToMask,
  mergeDetectionMasks,
  mergeDetectionPolygonsByClass,
  polygonToRect,
  rasterizePolygonToMask,
  rasterizeRectToMask,
  rectToPolygon,
  type MediaDimensions,
} from "#utils/detection-conversions";
export {
  DetectionMaskPayloadFormat,
  computeDetectionMaskRect,
  computeMaskBounds,
  decodeDetectionMaskPayload,
  detectMaskBorders,
  encodeBinaryMask,
  encodeBinaryMaskWithBounds,
  encodeDetectionMaskPayload,
  extractMaskContour,
  extractMaskRectRuns,
  isDeflatedBase64DetectionMaskPayload,
  type DetectionMaskCompressionCodec,
  type EncodedBinaryMask,
  type MaskRectRun,
} from "#utils/detection-masks";
export {
  centerRectToTopLeftRect,
  containsPoint,
  distanceToSegment,
  getDetectionRect,
  getPointsRect,
  pointInPolygon,
  polygonArea,
  rectArea,
  topLeftRectToCenterRect,
} from "#utils/geometry";
export {
  canReuseMaskStyleArtifacts,
  resolveMaskStyleOpacity,
} from "#utils/mask-style";
export {
  DEFAULT_DETECTION_CLASS_STYLES,
  DEFAULT_DETECTION_COLOR_SEQUENCE,
  SUPERVISION_ROBOFLOW_COLOR,
  normalizeDetectionClassName,
  resolveDetectionClassColorStyle,
  type DetectionClassColorStyle,
} from "#utils/color-palette";
export {
  MAX_ID_MASK_PALETTE_ENTRIES,
  MAX_ID_MASK_STROKE_WIDTH,
  createIdMaskFrame,
  type IdMaskFrame,
  type IdMaskInstruction,
} from "#utils/id-mask-frame";
export { resolveMarkerGeometry, sampleEllipseArc } from "#utils/shape-geometry";
export type { MarkerGeometry, SampledShapePath } from "#utils/shape-geometry";
export { includeDefined } from "#utils/object";
export { lightenColor, resolveContrastTextColor } from "#utils/color";
export { resolveAnnotationStyleState } from "#utils/annotation-visibility";

export { BoxShape, BoxStrokeAlignment } from "#types/box-style";
export { StrokeAlignment } from "#types/paint-style";
export type { ViewportController, ViewportTransform } from "#types/viewport";
export {
  AnnotationGeometryKind,
  AnnotationGestureStateKind,
  AnnotationHandleKind,
  type AnnotationCreationTool,
  type AnnotationEditingEngine,
  type AnnotationEditingEngineOptions,
  type AnnotationEditingPreviewStyleContext,
  type AnnotationEditingState,
  type AnnotationHandleDefinition,
  type AnnotationOverlayStyle,
  type AnnotationPointerInput,
  type PreviewOverlayData,
  type PreviewOverlayPoint,
} from "#types/editing";
export type {
  BoxDrawInstruction,
  BoxFillStyle,
  BoxStrokeStyle,
  BoxStyle,
  BoxStyleContext,
} from "#types/box-style";
export type {
  FillStyle,
  OpenStrokeStyle,
  StrokeCap,
  StrokeJoin,
  StrokeStyle,
} from "#types/paint-style";
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
  type DetectionFrameSourceChanges,
  type DetectionFrameSourceVersionRange,
  type DetectionPlaybackGateOptions,
  type DetectionTimelineContext,
  type WritableDetectionFrameSource,
} from "#types/detection-timeline";
export {
  DetectionMaskEncoding,
  KeypointVisibility,
  type CompressedRleDetectionMask,
  type Detection,
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
} from "#types/detections";
export type {
  MediaFrameMetadata,
  MediaTimelineMetadata,
  PlatformMediaFrame,
  PlatformMediaFrameSource,
} from "#types/media";
export {
  MediaRendererFit,
  MediaRendererPlaybackState,
  MediaSourceStatus,
} from "#types/media-rendering";
export type {
  MediaFrameDiagnostics,
  MediaFrameRenderTimings,
  MediaRendererDiagnosticsOptions,
  MediaRendererAssetError,
  MediaRendererPresentation,
  AnnotationVisibility,
  MediaDisplayAdjustments,
  MediaRendererQuality,
  MediaRendererState,
  MediaRendererStateController,
  MediaSourceState,
} from "#types/media-rendering";
export {
  MediaSessionActivityKind,
  MediaSessionActivityStatus,
  MediaSessionMode,
  MediaSessionStatus,
} from "#types/session-lifecycle";
export type {
  MediaSessionActivity,
  MediaSessionLifecycleState,
  MediaSessionStateListener,
  MediaSessionStateUnsubscribe,
} from "#types/session-lifecycle";
export type {
  FocusDrawInstruction,
  FocusFallbackStyle,
  FocusFillStyle,
  FocusStyle,
  FocusStyleContext,
  FocusStyleValue,
} from "#types/focus-style";
export { FocusTargetMode } from "#types/focus-style";
export {
  DetectionPickTarget,
  MediaInteractionMode,
  type DetectionPickOptions,
  type DetectionPickPoint,
  type DetectionPickResult,
  type DetectionSelectionOptions,
  type MediaInteractionOptions,
} from "#types/interaction";
export {
  DetectionInteractionState,
  type InteractionPresentation,
  type InteractionStyle,
  type InteractionStyleContext,
} from "#types/interaction-style";
export type {
  LabelBackgroundStyle,
  LabelDrawInstruction,
  LabelOffsetStyle,
  LabelStyle,
  LabelStyleContext,
  LabelTextStyle,
} from "#types/label-style";
export { LabelPlacement, LabelVisibilityMode } from "#types/label-style";
export type {
  MaskDrawInstruction,
  MaskStrokeStyle,
  MaskStrokeStyleOptions,
  MaskStyle,
  MaskStyleContext,
} from "#types/mask-style";
export { MaskRenderMode } from "#types/mask-style";
export type {
  PolygonDrawInstruction,
  PolygonStyle,
  PolygonStyleContext,
} from "#types/polygon-style";
export type {
  PolylineDrawInstruction,
  PolylineStyle,
  PolylineStyleContext,
} from "#types/polyline-style";
export {
  MarkerShape,
  MarkerSizeSpace,
  ShapeInstructionKind,
} from "#types/shape-style";
export type {
  EllipseShapeInstruction,
  MarkerShapeInstruction,
  PathShapeInstruction,
  ShapeDrawInstruction,
  ShapeStyle,
  ShapeStyleContext,
} from "#types/shape-style";
export type {
  EllipseDrawInstruction,
  EllipseStyle,
  EllipseStyleContext,
} from "#types/ellipse-style";
export { KeypointMarkerShape } from "#types/keypoint-style";
export type {
  KeypointDrawInstruction,
  KeypointEdgeDrawInstruction,
  KeypointMarkerDrawInstruction,
  KeypointStyle,
  KeypointStyleContext,
} from "#types/keypoint-style";
export type {
  AnnotationStyleContext,
  DetectionStylePredicate,
  DetectionStyleValue,
} from "#types/style";
