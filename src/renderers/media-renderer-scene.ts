import type { DecodedVideoSample } from "#media/media-source";
import type {
  MediaOverlayFrame,
  MediaRendererFit,
} from "#types/media-renderer";

export interface MediaRendererSceneOptions {
  readonly container: HTMLElement;
  readonly fit: MediaRendererFit;
  readonly overlayFrames: readonly MediaOverlayFrame[] | undefined;
}

export interface PresentedMediaSample {
  readonly mediaTime: number;
  readonly activeOverlayFrameTime: number | null;
  readonly activeOverlayRectCount: number;
}

export interface MediaRendererScene {
  initializeMedia(dimensions: { width: number; height: number }): void;
  presentSample(sample: DecodedVideoSample): PresentedMediaSample;
  destroy(): void;
}
