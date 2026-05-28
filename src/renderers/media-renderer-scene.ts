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
import type { MaskStyle } from "#types/mask-style";

export interface MediaRendererSceneOptions {
  readonly container: HTMLElement;
  readonly fit: MediaRendererFit;
  readonly detectionTimeline: BufferedDetectionTimeline;
  readonly boxStyle: BoxStyle | undefined;
  readonly maskStyle: MaskStyle | undefined;
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
  setPresentation(
    presentation: MediaRendererPresentation,
    mediaTime: number,
  ): void;
  destroy(): void;
}
