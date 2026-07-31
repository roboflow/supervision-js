import type { DetectionBufferState } from "#types/detection-timeline";
import type { DetectionFrame } from "#types/detections";
import type { BoxStyle } from "#types/box-style";
import type { FocusStyle } from "#types/focus-style";
import type { InteractionStyle } from "#types/interaction-style";
import type { LabelStyle } from "#types/label-style";
import type { MaskStyle } from "#types/mask-style";
import type { Point } from "#types/detections";
import type { ViewportTransform } from "#types/viewport";
import type { PolygonStyle } from "#types/polygon-style";
import type { PolylineStyle } from "#types/polyline-style";
import type { KeypointStyle } from "#types/keypoint-style";
import type { AnnotationOverlayStyle } from "#types/editing";

export enum MediaRendererFit {
  /**
   * Preserve media aspect ratio and fit the full frame inside the canvas.
   */
  Contain = "contain",
  /**
   * Preserve media aspect ratio and fill the canvas, cropping if necessary.
   */
  Cover = "cover",
}

/**
 * Playback lifecycle state reported by a platform renderer.
 */
export enum MediaRendererPlaybackState {
  Loading = "loading",
  Ready = "ready",
  Playing = "playing",
  Buffering = "buffering",
  Paused = "paused",
  Error = "error",
  Destroyed = "destroyed",
}

/**
 * Lower-level media source readiness.
 */
export enum MediaSourceStatus {
  Loading = "loading",
  Ready = "ready",
  Error = "error",
  Destroyed = "destroyed",
}

/**
 * Optional timing breakdown for one rendered frame.
 */
export interface MediaFrameRenderTimings {
  readonly totalMs: number;
  readonly mediaUploadMs: number;
  readonly maskMs: number;
  readonly boxMs: number;
  readonly focusMs: number;
  readonly interactionMs: number;
  readonly labelMs: number;
  readonly fitMs: number;
}

/**
 * Per-presented-frame diagnostics.
 *
 * Emitted from a renderer's frame loop. Keep handlers lightweight if reading
 * diagnostics at high frequency.
 */
export interface MediaFrameDiagnostics {
  readonly rendererBackend: string | null;
  readonly mediaTime: number;
  readonly presentedFrames: number;
  readonly currentTime: number;
  readonly duration: number | null;
  readonly mediaWidth: number;
  readonly mediaHeight: number;
  readonly expectedDisplayTime: null;
  readonly activeDetectionFrameTime: number | null;
  readonly activeDetectionFrameIndex: number | null;
  readonly activeDetectionCount: number;
  readonly detectionBuffer: DetectionBufferState;
  readonly renderTimings: MediaFrameRenderTimings | null;
}

export interface MediaRendererDiagnosticsOptions {
  /**
   * Measure per-frame render timings. Useful for profiling, but avoid enabling
   * it permanently in latency-sensitive apps unless needed.
   */
  readonly frameTimings?: boolean;
}

/**
 * Snapshot of the opened media source.
 */
export interface MediaSourceState {
  readonly status: MediaSourceStatus;
  readonly canRead: boolean | null;
  readonly formatName: string | null;
  readonly formatMimeType: string | null;
  readonly mimeType: string | null;
  readonly duration: number | null;
  readonly trackCount: number | null;
  readonly videoTrackCount: number | null;
  readonly audioTrackCount: number | null;
  readonly primaryVideoWidth: number | null;
  readonly primaryVideoHeight: number | null;
  readonly errorMessage: string | null;
}

/**
 * Current renderer state.
 */
export interface MediaRendererState {
  readonly rendererBackend: string | null;
  readonly playbackState: MediaRendererPlaybackState;
  readonly fit: MediaRendererFit;
  readonly currentTime: number;
  readonly duration: number | null;
  readonly mediaWidth: number;
  readonly mediaHeight: number;
  readonly presentedFrames: number;
  readonly activeDetectionFrameTime: number | null;
  readonly activeDetectionFrameIndex: number | null;
  readonly activeDetectionCount: number;
  readonly detectionBuffer: DetectionBufferState;
  readonly lastFrameRenderTimings: MediaFrameRenderTimings | null;
  readonly source: MediaSourceState;
}

/**
 * Current presentation styles used by renderer layers.
 */
export interface MediaRendererPresentation {
  /**
   * Renderer canvas color shown around media that is letterboxed or not yet
   * presented. Hosts can update this with their color theme without recreating
   * the media session.
   */
  readonly backgroundColor?: number;
  readonly annotationOverlayStyle?: AnnotationOverlayStyle | null;
  readonly boxStyle?: BoxStyle | null;
  readonly focusStyle?: FocusStyle | null;
  readonly interactionStyle?: InteractionStyle | null;
  readonly labelStyle?: LabelStyle | null;
  readonly maskStyle?: MaskStyle | null;
  readonly polygonStyle?: PolygonStyle | null;
  readonly polylineStyle?: PolylineStyle | null;
  readonly keypointStyle?: KeypointStyle | null;
  readonly visibility?: AnnotationVisibility;
}

export interface AnnotationVisibility {
  readonly annotationsHidden?: boolean;
  readonly labelsHidden?: boolean;
  readonly hiddenClasses?: ReadonlySet<string> | readonly string[];
  readonly hiddenDetectionIds?:
    ReadonlySet<string | number> | readonly (string | number)[];
  readonly loadingDetectionIds?:
    ReadonlySet<string | number> | readonly (string | number)[];
  readonly ephemeralDetectionIds?:
    ReadonlySet<string | number> | readonly (string | number)[];
  readonly creatingDetectionId?: string | number | null;
}

export interface MediaDisplayAdjustments {
  /** Normalized contrast where 1 is unchanged. */
  readonly contrast?: number;
  /** Normalized brightness where 1 is unchanged. */
  readonly brightness?: number;
}

/**
 * Runtime renderer quality controls.
 */
export interface MediaRendererQuality {
  /**
   * Caps render resolution relative to device pixels.
   *
   * Use `undefined` or a non-positive value to restore native device
   * resolution.
   */
  readonly maxDevicePixelRatio?: number;
}

/**
 * Minimal state-bearing renderer controller contract.
 */
export interface MediaRendererStateController {
  setPresentation(presentation: MediaRendererPresentation): void;
  setRenderQuality(quality: MediaRendererQuality): void;
  setDisplayAdjustments?(adjustments: MediaDisplayAdjustments): void;
  getViewportTransform?(): ViewportTransform;
  setViewportTransform?(
    transform: Partial<Omit<ViewportTransform, "locked">>,
  ): void;
  setViewportLocked?(locked: boolean): void;
  screenToMedia?(point: Point): Point;
  mediaToScreen?(point: Point): Point;
  panViewportBy?(dx: number, dy: number): void;
  zoomViewportAt?(point: Point, factor: number): void;
  zoomViewportFromWheel?(point: Point, deltaY: number): void;
  getActiveDetectionFrame(): DetectionFrame | null;
  getState(): MediaRendererState;
}
