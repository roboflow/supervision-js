import type { DecodedVideoSample } from "#media/media-source";
import type { BoxStyle } from "#types/box-style";
import type {
  BufferedDetectionTimeline,
  DetectionBufferState,
} from "#types/detection-timeline";
import type {
  MediaRendererFit,
  MediaRendererPresentation,
} from "#types/media-renderer";
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
  readonly renderPreparation: RenderPreparationOptions | undefined;
}

export interface PresentedMediaSample {
  readonly mediaTime: number;
  readonly activeDetectionFrameTime: number | null;
  readonly activeDetectionFrameIndex: number | null;
  readonly activeDetectionCount: number;
  readonly detectionBuffer: DetectionBufferState;
}

export interface MediaRendererScene {
  initializeMedia(dimensions: { width: number; height: number }): void;
  presentSample(sample: DecodedVideoSample): PresentedMediaSample;
  waitForRenderPreparation?(
    mediaTime: number,
    options: RenderPreparationPlaybackGateOptions,
  ): Promise<void>;
  setPresentation(
    presentation: MediaRendererPresentation,
    mediaTime: number,
  ): void;
  destroy(): void;
}
