import type { DetectionBufferState } from "#types/detection-timeline";
import type { DetectionFrame } from "#types/detections";
import type { BoxStyle } from "#types/box-style";
import type { FocusStyle } from "#types/focus-style";
import type { InteractionStyle } from "#types/interaction-style";
import type { LabelStyle } from "#types/label-style";
import type { MaskStyle } from "#types/mask-style";

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
  readonly boxStyle?: BoxStyle | null;
  readonly focusStyle?: FocusStyle | null;
  readonly interactionStyle?: InteractionStyle | null;
  readonly labelStyle?: LabelStyle | null;
  readonly maskStyle?: MaskStyle | null;
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
  getActiveDetectionFrame(): DetectionFrame | null;
  getState(): MediaRendererState;
}
