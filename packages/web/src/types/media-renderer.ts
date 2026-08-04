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
  MediaRendererPresentation,
  MediaRendererQuality,
  MediaRendererState,
  MediaDisplayAdjustments,
  MediaSourceState,
} from "supervision-js-core";

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
  /**
   * No-op in the current video-only renderer. Audio playback is deferred.
   */
  readonly muted?: boolean;
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
 * Lower-level renderer controller.
 *
 * Prefer `MediaSession` for application code unless you need to own media
 * preparation and detection buffering yourself.
 */
export interface MediaRenderer extends MediaRendererStateController {
  play(): Promise<void>;
  pause(): void;
  seek(mediaTime: number): Promise<void>;
  stepForward(): Promise<void>;
  stepBackward(): Promise<void>;
  setPlaybackRate(playbackRate: number): void;
  /** Re-read detections and redraw the currently presented media frame. */
  refresh(): Promise<void>;
  setSelectedDetection(
    selection: DetectionSelectionOptions | null,
  ): DetectionPickResult | null;
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
