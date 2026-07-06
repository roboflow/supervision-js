// Detection sources and storage.
export { createArrayDetectionFrameSource } from "#detections/array-detection-frame-source";
export {
  createBufferedDetectionTimeline,
  createIdleDetectionBufferState,
} from "#detections/buffered-detection-timeline";
export { createColdDetectionFrameSource } from "#detections/cold-detection-frame-source";
export { createCompositeDetectionFrameSource } from "#detections/composite-detection-frame-source";
export { createMemoryColdDetectionFrameStore } from "#detections/memory-cold-detection-frame-store";
export { createWritableDetectionFrameSource } from "#detections/writable-detection-frame-source";

// Interaction and picking.
export {
  createDetectionPickKey,
  pickDetectionAtPoint,
  pickDetectionByMaskId,
  rebaseDetectionPickToFrame,
} from "#interactions/detection-picker";

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
export {
  createSourceAwarePresentation,
  type PresentationStyleSet,
  type SourcePresentation,
  type SourcePresentationEntry,
} from "#styles/source-presentation";
export { resolveStyleValue } from "#styles/style-value";

// Pure utilities used by platform packages.
export {
  copySortedDetectionFrames,
  decodeCompressedRleMask,
  detectionFrameOverlapsRange,
  filterDetectionFramesForRange,
  selectDetectionFrame,
  validateDetectionFrames,
  type DecodedDetectionMask,
} from "#utils/detection-frames";
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
export { includeDefined } from "#utils/object";

export { BoxShape, BoxStrokeAlignment } from "#types/box-style";
export type {
  BoxDrawInstruction,
  BoxFillStyle,
  BoxStrokeStyle,
  BoxStyle,
  BoxStyleContext,
} from "#types/box-style";
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
} from "#types/detection-timeline";
export {
  DetectionMaskEncoding,
  type CompressedRleDetectionMask,
  type Detection,
  type DetectionFrame,
  type DetectionMask,
  type Rect,
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
  MediaRendererPresentation,
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
export { LabelPlacement } from "#types/label-style";
export type {
  MaskDrawInstruction,
  MaskStrokeStyle,
  MaskStrokeStyleOptions,
  MaskStyle,
  MaskStyleContext,
} from "#types/mask-style";
export { MaskRenderMode } from "#types/mask-style";
export type {
  DetectionStylePredicate,
  DetectionStyleValue,
} from "#types/style";
