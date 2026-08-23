import type {
  DetectionBufferOptions,
  DetectionFrameSource,
  MediaFrameDiagnostics,
  MediaRendererDiagnosticsOptions,
  MediaRendererFit,
  MediaRendererPresentation,
  MediaRendererState,
  MediaRendererStateController,
  MediaSourceState,
} from "supervision-js-core";
import type { PreparedAnnotationWindowSnapshot } from "#renderers/prepared-annotation-window";
import type { DetectionFrame } from "supervision-js-core";
import type {
  DetectionPickResult,
  DetectionSelectionOptions,
  MediaInteractionOptions,
} from "supervision-js-core";
import type { DecodedMediaSource } from "#media/media-source";
import type { RenderPreparationOptions } from "#types/render-preparation";
import type {
  AnnotationEditingEngine,
  PreviewOverlayData,
} from "supervision-js-core";
import type { MaskBrushPreviewOptions } from "../editing";

export {
  MediaRendererFit,
  MediaRendererPlaybackState,
  MediaSourceStatus,
} from "supervision-js-core";
export type {
  MediaFrameDiagnostics,
  MediaFrameRenderTimings,
  MediaRendererDiagnosticsOptions,
  MediaRendererAssetError,
  MediaRendererPresentation,
  MediaRendererQuality,
  MediaRendererState,
  MediaDisplayAdjustments,
  MediaSourceState,
} from "supervision-js-core";

/** Clock used by semantic detection frames supplied to a media renderer. */
export enum DetectionTimelineOrigin {
  /** Detection times already use the decoded media source's native timeline. */
  MediaTimeline = "mediaTimeline",
  /** Detection time zero corresponds to the first decoded media sample. */
  MediaStart = "mediaStart",
}

/**
 * Lower-level renderer options.
 *
 * Most applications should prefer `createMediaSession`, which wires media
 * preparation, detection buffering, and render preparation with defaults.
 */
export interface MediaRendererOptions extends MediaRendererPresentation {
  readonly container: HTMLElement;
  readonly src?: string | URL | Request;
  readonly source?: MediaRendererSource;
  readonly autoPlay?: boolean;
  readonly loop?: boolean;
  readonly playbackRate?: number;
  readonly fit?: MediaRendererFit;
  /**
   * Caps Pixi's render resolution relative to device pixels.
   *
   * Lower values reduce GPU memory and fill-rate pressure. For example,
   * capping a Retina display from DPR 2 to 1 renders one quarter as many
   * pixels, which can be useful for long videos or browsers under load.
   */
  readonly maxDevicePixelRatio?: number;
  readonly detectionFrames?: readonly DetectionFrame[];
  readonly detectionSource?: DetectionFrameSource;
  readonly detectionBuffer?: DetectionBufferOptions;
  /**
   * Aligns detection timestamps with media whose first presentation timestamp
   * is not zero. Defaults to `MediaTimeline` for backward compatibility.
   */
  readonly detectionTimelineOrigin?: DetectionTimelineOrigin;
  readonly interaction?: MediaInteractionOptions;
  readonly renderPreparation?: RenderPreparationOptions;
  readonly diagnostics?: MediaRendererDiagnosticsOptions;
  readonly editingEngine?: AnnotationEditingEngine;
  readonly maskBrush?: MaskBrushPreviewOptions;
  /** Creates a media-sized brush preview after the source metadata is known. */
  readonly createMaskBrush?: (dimensions: {
    readonly width: number;
    readonly height: number;
  }) => MaskBrushPreviewOptions;
  readonly previewOverlay?: () => PreviewOverlayData | null;
  readonly onFrame?: (diagnostics: MediaFrameDiagnostics) => void;
  readonly onSource?: (state: MediaSourceState) => void;
  readonly onState?: (state: MediaRendererState) => void;
}

/**
 * Provider contract for opening decoded media.
 *
 * This is primarily useful for advanced integrations. The default session path
 * supplies the built-in browser/Mediabunny source.
 */
export interface MediaRendererSource {
  open(): Promise<DecodedMediaSource>;
}

/**
 * Encoder options for capturing the currently presented media frame.
 */
export interface MediaFrameCaptureOptions {
  /**
   * Encoded image MIME type. Defaults to `image/jpeg`.
   *
   * Browsers are only required to support `image/png`; unsupported types fall
   * back to the browser's default encoding, which the capture reports back in
   * `MediaFrameCapture.type`.
   */
  readonly type?: string;
  /**
   * Lossy encoder quality between `0` and `1`. Defaults to `0.92`. Ignored by
   * lossless encoders such as `image/png`.
   */
  readonly quality?: number;
}

/**
 * Encoded image of the media frame the renderer is currently presenting.
 *
 * The image holds raw media pixels without annotation layers, paired with the
 * presentation timestamp of that exact frame.
 */
export interface MediaFrameCapture {
  /** Encoded image bytes for the captured media frame. */
  readonly blob: Blob;
  /** Presentation timestamp of the captured frame on the media timeline. */
  readonly mediaTime: number;
  /** Encoded image MIME type produced by the browser. */
  readonly type: string;
  /** Captured image width in media pixels. */
  readonly width: number;
  /** Captured image height in media pixels. */
  readonly height: number;
}

/** Screen-space bounds of a detection label after renderer layout. */
export interface DetectionLabelBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Lower-level renderer controller.
 *
 * Prefer `MediaSession` for application code unless you need to own media
 * preparation and detection buffering yourself.
 */
export interface MediaRenderer extends MediaRendererStateController {
  play(): Promise<void>;
  pause(): void;
  /**
   * Flips playback without the caller first reading which way it is going, so
   * a frame presented between the read and the call cannot invert the result.
   */
  togglePlayback(): void;
  /** Lands on `mediaTime` and resolves once the frame there is presented. */
  seek(mediaTime: number): Promise<void>;
  /**
   * Moves the playhead for a gesture that is still moving, such as a timeline
   * drag between pointer down and up. The frame that answers it may be an
   * approximation; `seek` is what lands the released position exactly.
   */
  scrub(mediaTime: number): void;
  stepForward(): Promise<void>;
  stepBackward(): Promise<void>;
  setPlaybackRate(playbackRate: number): void;
  /** Re-read detections and redraw the currently presented media frame. */
  refresh(): Promise<void>;
  /**
   * Encodes the media frame that is currently presented.
   *
   * The renderer keeps decode and render ownership: the returned image is a
   * copy of the presented media pixels taken before encoding starts, so a frame
   * presented while the encoder runs cannot change the result.
   */
  captureFrame(options?: MediaFrameCaptureOptions): Promise<MediaFrameCapture>;
  setSelectedDetection(
    selection: DetectionSelectionOptions | null,
  ): DetectionPickResult | null;
  /**
   * Explicit renders issued under the render-on-change policy, which only a
   * media source that pushes presented frames runs under: the count moves when
   * something on screen changed, so a paused, untouched renderer holds it
   * still. It is `null` when the renderer pulls samples instead, because Pixi's
   * ticker then paints every animation frame and no count describes that.
   */
  getRenderCount(): number | null;
  /**
   * Span and per-frame readiness of the prepared annotation window, for
   * instruments; null when the scene free-runs on the ticker or no window
   * exists.
   */
  getPreparedAnnotationWindow(): PreparedAnnotationWindowSnapshot | null;
  destroy(): void;
  getViewportTransform(): import("supervision-js-core").ViewportTransform;
  setViewportTransform(
    transform: Partial<
      Omit<import("supervision-js-core").ViewportTransform, "locked">
    >,
  ): void;
  setViewportLocked(locked: boolean): void;
  screenToMedia(
    point: import("supervision-js-core").Point,
  ): import("supervision-js-core").Point;
  mediaToScreen(
    point: import("supervision-js-core").Point,
  ): import("supervision-js-core").Point;
  /**
   * Returns the label rectangle exactly as laid out by the renderer.
   *
   * Coordinates are relative to the renderer container and already include
   * fit, pan, zoom, screen-stable label sizing, and media-edge clamping.
   */
  getDetectionLabelBounds(
    detectionId: string | number,
  ): DetectionLabelBounds | null;
  panViewportBy(dx: number, dy: number): void;
  zoomViewportAt(
    point: import("supervision-js-core").Point,
    factor: number,
  ): void;
  zoomViewportFromWheel(
    point: import("supervision-js-core").Point,
    deltaY: number,
  ): void;
}
