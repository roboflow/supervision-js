import type { DecodedVideoSample } from "#media/media-source";
import type { BoxStyle } from "#types/box-style";
import type {
  BufferedDetectionTimeline,
  DetectionBufferState,
} from "#types/detection-timeline";
import type { MediaRendererFit } from "#types/media-renderer";

export interface MediaRendererSceneOptions {
  readonly container: HTMLElement;
  readonly fit: MediaRendererFit;
  readonly detectionTimeline: BufferedDetectionTimeline;
  readonly boxStyle: BoxStyle | undefined;
}

export interface PresentedMediaSample {
  readonly mediaTime: number;
  readonly activeDetectionFrameTime: number | null;
  readonly activeDetectionCount: number;
  readonly detectionBuffer: DetectionBufferState;
}

export interface MediaRendererScene {
  initializeMedia(dimensions: { width: number; height: number }): void;
  presentSample(sample: DecodedVideoSample): PresentedMediaSample;
  destroy(): void;
}
