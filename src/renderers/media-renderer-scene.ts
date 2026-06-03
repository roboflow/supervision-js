import type { DecodedVideoSample } from "#media/media-source";
import type { BoxStyle } from "#types/box-style";
import type {
  BufferedDetectionTimeline,
  DetectionBufferState,
} from "#types/detection-timeline";
import type {
  MediaRendererDiagnosticsOptions,
  MediaFrameRenderTimings,
  MediaRendererFit,
  MediaRendererPresentation,
} from "#types/media-renderer";
import type { MediaInteractionOptions } from "#types/interaction";
import type { LabelStyle } from "#types/label-style";
import type { MaskStyle } from "#types/mask-style";
import type {
  RenderPreparationOptions,
  RenderPreparationPlaybackGateOptions,
} from "#types/render-preparation";

export interface MediaRendererSceneOptions {
  readonly container: HTMLElement;
  readonly fit: MediaRendererFit;
  readonly detectionTimeline: BufferedDetectionTimeline;
  readonly boxStyle: BoxStyle | undefined;
  readonly labelStyle: LabelStyle | undefined;
  readonly maskStyle: MaskStyle | undefined;
  readonly interaction: MediaInteractionOptions | undefined;
  readonly canInteract: () => boolean;
  readonly renderPreparation: RenderPreparationOptions | undefined;
  readonly diagnostics: MediaRendererDiagnosticsOptions | undefined;
}

export interface PresentedMediaSample {
  readonly mediaTime: number;
  readonly activeDetectionFrameTime: number | null;
  readonly activeDetectionFrameIndex: number | null;
  readonly activeDetectionCount: number;
  readonly detectionBuffer: DetectionBufferState;
  readonly renderTimings?: MediaFrameRenderTimings;
}

export interface MediaRendererScene {
  initializeMedia(dimensions: { width: number; height: number }): void;
  setTimelineContext?(context: MediaRendererSceneTimelineContext): void;
  presentSample(sample: DecodedVideoSample): PresentedMediaSample;
  waitForRenderPreparation?(
    mediaTime: number,
    options: RenderPreparationPlaybackGateOptions,
  ): Promise<void>;
  setPresentation(
    presentation: MediaRendererPresentation,
    mediaTime: number,
  ): PresentedMediaSample | void;
  destroy(): void;
}

export interface MediaRendererSceneTimelineContext {
  readonly duration: number | null;
  readonly loop: boolean;
}
