import type { MediaOverlayFrame } from "../types/media-renderer";

export function copySortedOverlayFrames(
  overlayFrames: readonly MediaOverlayFrame[] | undefined,
): MediaOverlayFrame[] {
  return (overlayFrames ?? [])
    .map((frame) => ({
      mediaTime: frame.mediaTime,
      rects: frame.rects.map((rect) => ({ ...rect })),
    }))
    .sort((left, right) => left.mediaTime - right.mediaTime);
}

export function selectOverlayFrame(
  overlayFrames: readonly MediaOverlayFrame[],
  mediaTime: number,
): MediaOverlayFrame | undefined {
  let selectedFrame: MediaOverlayFrame | undefined;
  let low = 0;
  let high = overlayFrames.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const frame = overlayFrames[middle];

    if (frame.mediaTime <= mediaTime) {
      selectedFrame = frame;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return selectedFrame;
}
