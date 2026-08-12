import type { DecodedVideoSample } from "#media/media-source";
import type { BoxStyle } from "supervision-js-core";
import type {
  BufferedDetectionTimeline,
  DetectionBufferState,
} from "supervision-js-core";
import type {
  DetectionLabelBounds,
  MediaFrameCapture,
  MediaFrameCaptureOptions,
  MediaRendererDiagnosticsOptions,
  MediaFrameRenderTimings,
  MediaRendererFit,
  MediaRendererPresentation,
} from "#types/media-renderer";
import type {
  DetectionPickResult,
  DetectionSelectionOptions,
  MediaInteractionOptions,
} from "supervision-js-core";
import type { FocusStyle } from "supervision-js-core";
import type { InteractionStyle } from "supervision-js-core";
import type { LabelStyle } from "supervision-js-core";
import type { MaskStyle } from "supervision-js-core";
import type {
  RegionAnnotationRenderer,
  PolygonStyle,
  PolylineStyle,
  ShapeStyle,
  KeypointStyle,
} from "supervision-js-core";
import type { MediaDisplayAdjustments } from "supervision-js-core";
import type { Point, ViewportTransform } from "supervision-js-core";
import type {
  AnnotationEditingEngine,
  AnnotationOverlayStyle,
  PreviewOverlayData,
} from "supervision-js-core";
import type {
  RenderPreparationOptions,
  RenderPreparationPlaybackGateOptions,
} from "#types/render-preparation";
import type { MaskBrushPreviewOptions } from "#editing/mask-brush-editor";

export interface MediaRendererSceneOptions {
  readonly container: HTMLElement;
  readonly backgroundColor: MediaRendererPresentation["backgroundColor"];
  readonly fit: MediaRendererFit;
  readonly maxDevicePixelRatio: number | undefined;
  readonly detectionTimeline: BufferedDetectionTimeline;
  readonly boxStyle: BoxStyle | null | undefined;
  readonly focusStyle: FocusStyle | null | undefined;
  readonly labelStyle: LabelStyle | null | undefined;
  readonly maskStyle: MaskStyle | null | undefined;
  readonly polygonStyle: PolygonStyle | null | undefined;
  readonly polylineStyle: PolylineStyle | null | undefined;
  readonly shapeStyle: ShapeStyle | null | undefined;
  readonly keypointStyle: KeypointStyle | null | undefined;
  readonly regionRenderers: readonly RegionAnnotationRenderer[];
  readonly interaction: MediaInteractionOptions | undefined;
  readonly interactionStyle: InteractionStyle | null | undefined;
  readonly canInteract: () => boolean;
  readonly renderPreparation: RenderPreparationOptions | undefined;
  readonly diagnostics: MediaRendererDiagnosticsOptions | undefined;
  readonly visibility: MediaRendererPresentation["visibility"];
  readonly editingEngine: AnnotationEditingEngine | undefined;
  readonly annotationOverlayStyle: AnnotationOverlayStyle | null | undefined;
  readonly maskBrush: MaskBrushPreviewOptions | undefined;
  readonly previewOverlay: (() => PreviewOverlayData | null) | undefined;
  /** Propagates renderer-owned asynchronous visual changes into runtime state. */
  readonly onPresentationUpdate?: (sample: PresentedMediaSample) => void;
}

export interface PresentedMediaSample {
  readonly mediaTime: number;
  readonly duration?: number;
  readonly activeDetectionFrameTime: number | null;
  readonly activeDetectionFrameIndex: number | null;
  readonly activeDetectionCount: number;
  readonly detectionBuffer: DetectionBufferState;
  readonly renderTimings?: MediaFrameRenderTimings;
}

export interface MediaRendererScene {
  readonly rendererBackend: string;
  initializeMedia(dimensions: { width: number; height: number }): void;
  setTimelineContext?(context: MediaRendererSceneTimelineContext): void;
  presentSample(sample: DecodedVideoSample): PresentedMediaSample;
  /**
   * Encodes the media pixels presented by the most recent sample, paired with
   * that sample's presentation timestamp.
   */
  captureFrame?(
    options: MediaFrameCaptureOptions | undefined,
  ): Promise<MediaFrameCapture>;
  waitForRenderPreparation?(
    mediaTime: number,
    options: RenderPreparationPlaybackGateOptions,
  ): Promise<void>;
  setRenderQuality(maxDevicePixelRatio: number | undefined): void;
  setDisplayAdjustments?(adjustments: MediaDisplayAdjustments): void;
  getViewportTransform?(): ViewportTransform;
  setViewportTransform?(
    transform: Partial<Omit<ViewportTransform, "locked">>,
  ): void;
  setViewportLocked?(locked: boolean): void;
  screenToMedia?(point: Point): Point;
  mediaToScreen?(point: Point): Point;
  getDetectionLabelBounds?(
    detectionId: string | number,
  ): DetectionLabelBounds | null;
  panViewportBy?(dx: number, dy: number): void;
  zoomViewportAt?(point: Point, factor: number): void;
  zoomViewportFromWheel?(point: Point, deltaY: number): void;
  setPresentation(
    presentation: MediaRendererPresentation,
    mediaTime: number,
  ): PresentedMediaSample | void;
  setSelectedDetection?(
    selection: DetectionSelectionOptions | null,
    mediaTime: number,
  ): DetectionPickResult | null;
  destroy(): void;
}

export interface MediaRendererSceneTimelineContext {
  readonly duration: number | null;
  readonly loop: boolean;
}
