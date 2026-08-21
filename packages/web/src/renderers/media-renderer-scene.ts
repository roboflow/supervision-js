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
import type { PresentedFrameSource } from "./presented-frame-channel";
import type { PreparedAnnotationWindowSnapshot } from "./prepared-annotation-window";

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
  /**
   * Internal shape decoration hook. Renderer kinds that lower to shape
   * instructions will feed this; it has no public presentation field.
   */
  readonly shapeStyle?: ShapeStyle | null;
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
  /**
   * Present plane of a media source that decides for itself which frame is on
   * screen. Given one, the scene presents what the producer announces instead
   * of what the renderer pulls, and renders only when something changed.
   */
  readonly presentedFrames?: PresentedFrameSource;
}

export interface PresentedMediaSample {
  /**
   * Which frame the scene has on screen, as its count of the frames it has
   * presented. Two presentations of one media time carry different serials, and
   * every redraw of the frame on screen carries that frame's own.
   */
  readonly presentedFrameSerial: number;
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
  /**
   * Explicit renders issued so far, which a push-presented scene only issues on
   * change. A scene that free-runs on the ticker has no such count.
   */
  getRenderCount?(): number | null;
  /**
   * Which frames around the playhead have every enabled layer's data cooked. A
   * scene that free-runs on the ticker gates nothing and reports none.
   */
  getPreparedAnnotationWindow?(): PreparedAnnotationWindowSnapshot | null;
  initializeMedia(dimensions: { width: number; height: number }): void;
  /**
   * Whether the playhead is moving. Cooking far ahead of a resting playhead is
   * speculation, so the scene narrows what it prepares until the playhead moves
   * again.
   */
  setPlaybackActive?(active: boolean): void;
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
