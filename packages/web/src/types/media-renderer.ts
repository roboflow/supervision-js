import type { BoxStyle } from "supervision-js-core";
import type {
  DetectionBufferOptions,
  DetectionBufferState,
  DetectionFrameSource,
} from "supervision-js-core";
import type { DetectionFrame } from "supervision-js-core";
import type {
  DetectionPickResult,
  DetectionSelectionOptions,
  MediaInteractionOptions,
} from "supervision-js-core";
import type { FocusStyle } from "supervision-js-core";
import type { InteractionStyle } from "supervision-js-core";
import type { LabelStyle } from "supervision-js-core";
import type { MaskStyle } from "supervision-js-core";
import type { DecodedMediaSource } from "#media/media-source";
import type { RenderPreparationOptions } from "#types/render-preparation";

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
 * Playback lifecycle state reported by the renderer.
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
 * Per-presented-frame diagnostics.
 *
 * Emitted from the renderer's frame loop. Keep handlers lightweight if reading
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
 * Lower-level renderer options.
 *
 * Most applications should prefer `createMediaSession`, which wires media
 * preparation, detection buffering, and render preparation with defaults.
 */
export interface MediaRendererOptions {
  readonly container: HTMLElement;
  readonly src?: string;
  readonly source?: MediaRendererSource;
  readonly autoPlay?: boolean;
  readonly loop?: boolean;
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
  readonly boxStyle?: BoxStyle | null;
  readonly focusStyle?: FocusStyle | null;
  readonly labelStyle?: LabelStyle | null;
  readonly maskStyle?: MaskStyle | null;
  readonly interaction?: MediaInteractionOptions;
  readonly interactionStyle?: InteractionStyle | null;
  readonly renderPreparation?: RenderPreparationOptions;
  readonly diagnostics?: MediaRendererDiagnosticsOptions;
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
   * Caps Pixi's render resolution relative to device pixels.
   *
   * Use `undefined` or a non-positive value to restore native device
   * resolution.
   */
  readonly maxDevicePixelRatio?: number;
}

/**
 * Lower-level renderer controller.
 *
 * Prefer `MediaSession` for application code unless you need to own media
 * preparation and detection buffering yourself.
 */
export interface MediaRenderer {
  play(): Promise<void>;
  pause(): void;
  seek(mediaTime: number): Promise<void>;
  setPresentation(presentation: MediaRendererPresentation): void;
  setRenderQuality(quality: MediaRendererQuality): void;
  setSelectedDetection(
    selection: DetectionSelectionOptions | null,
  ): DetectionPickResult | null;
  getActiveDetectionFrame(): DetectionFrame | null;
  getState(): MediaRendererState;
  destroy(): void;
}
