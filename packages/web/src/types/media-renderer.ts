import type { BoxStyle } from "supervision-js-core";
import type {
  DetectionBufferOptions,
  DetectionFrameSource,
  MediaFrameDiagnostics,
  MediaRendererDiagnosticsOptions,
  MediaRendererFit,
  MediaRendererPresentation,
  MediaRendererQuality,
  MediaRendererState,
  MediaSourceState,
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
  MediaSourceState,
} from "supervision-js-core";

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
