import { MediaRendererFit } from "#types/media-renderer";

export interface PixiSceneFit {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

export function calculatePixiSceneFit(options: {
  readonly fit: MediaRendererFit;
  readonly mediaHeight: number;
  readonly mediaWidth: number;
  readonly screenHeight: number;
  readonly screenWidth: number;
}): PixiSceneFit | undefined {
  const { fit, mediaHeight, mediaWidth, screenHeight, screenWidth } = options;

  if (
    mediaWidth <= 0 ||
    mediaHeight <= 0 ||
    screenWidth <= 0 ||
    screenHeight <= 0
  ) {
    return undefined;
  }

  const scale =
    fit === MediaRendererFit.Cover
      ? Math.max(screenWidth / mediaWidth, screenHeight / mediaHeight)
      : Math.min(screenWidth / mediaWidth, screenHeight / mediaHeight);

  return {
    scale,
    x: (screenWidth - mediaWidth * scale) / 2,
    y: (screenHeight - mediaHeight * scale) / 2,
  };
}
