import type { DetectionFrame } from "#types/detections";

export function copySortedDetectionFrames(
  detectionFrames: readonly DetectionFrame[] | undefined,
): DetectionFrame[] {
  return (detectionFrames ?? [])
    .map((frame) => ({
      detections: frame.detections.map((detection) => ({
        ...detection,
        metadata: detection.metadata ? { ...detection.metadata } : undefined,
        rect: detection.rect ? { ...detection.rect } : undefined,
      })),
      mediaTime: frame.mediaTime,
    }))
    .sort((left, right) => left.mediaTime - right.mediaTime);
}

export function selectDetectionFrame(
  detectionFrames: readonly DetectionFrame[],
  mediaTime: number,
): DetectionFrame | undefined {
  let selectedFrame: DetectionFrame | undefined;
  let low = 0;
  let high = detectionFrames.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const frame = detectionFrames[middle];

    if (frame.mediaTime <= mediaTime) {
      selectedFrame = frame;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return selectedFrame;
}
