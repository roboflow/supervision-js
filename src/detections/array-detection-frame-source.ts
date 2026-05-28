import type { DetectionFrameSource } from "#types/detection-timeline";
import type { DetectionFrame } from "#types/detections";
import { copySortedDetectionFrames } from "#utils/detection-frames";

export function createArrayDetectionFrameSource(
  frames: readonly DetectionFrame[] | undefined,
): DetectionFrameSource {
  const sortedFrames = copySortedDetectionFrames(frames);

  return {
    async loadFrames(startTime, endTime) {
      return copySortedDetectionFrames(
        sortedFrames.filter(
          (frame) => frame.mediaTime >= startTime && frame.mediaTime <= endTime,
        ),
      );
    },
  };
}
