import type {
  DetectionFrameLoadOptions,
  DetectionFrameSource,
  DetectionFrameSourceVersionRange,
} from "#types/detection-timeline";
import type { DetectionCoordinateSpace } from "#types/detections";
import { projectDetectionFrames } from "#utils/detection-projection";

/**
 * Wraps a detection source so every loaded frame that declares a source
 * coordinate space is projected into the target space.
 *
 * The target is resolved per load because media dimensions are only known once
 * the media has opened, while sources are composed before that. Frames without
 * `coordinateSpace`, and loads made before a target exists, pass through by
 * reference, so a producer already emitting media-pixel geometry pays nothing.
 *
 * The target is also handed to the wrapped source through
 * `DetectionFrameLoadOptions`. A source that flattens child frames, such as a
 * composite source, needs it to project each child while that child's own
 * `coordinateSpace` is still attached; projecting the flattened result again
 * here is then a no-op.
 *
 * Optional source hooks are forwarded only when the wrapped source implements
 * them, so capability detection keeps working through the wrapper.
 */
export function createProjectedDetectionFrameSource(
  source: DetectionFrameSource,
  resolveTarget: () => DetectionCoordinateSpace | null,
): DetectionFrameSource {
  const { getAvailableRanges, getChangesSince, getVersion, waitForRange } =
    source;

  return {
    async loadFrames(
      startTime: number,
      endTime: number,
      options?: DetectionFrameLoadOptions,
    ) {
      const target = resolveTarget();
      const frames = await source.loadFrames(startTime, endTime, {
        ...options,
        ...(target ? { coordinateSpace: target } : {}),
      });

      return target ? projectDetectionFrames(frames, target) : frames;
    },

    ...(waitForRange
      ? {
          waitForRange: (range: DetectionFrameSourceVersionRange) =>
            waitForRange.call(source, range),
        }
      : {}),
    ...(getAvailableRanges
      ? { getAvailableRanges: () => getAvailableRanges.call(source) }
      : {}),
    ...(getVersion
      ? {
          getVersion: (range?: DetectionFrameSourceVersionRange) =>
            getVersion.call(source, range),
        }
      : {}),
    ...(getChangesSince
      ? {
          getChangesSince: (
            version: number,
            ranges: readonly DetectionFrameSourceVersionRange[],
          ) => getChangesSince.call(source, version, ranges),
        }
      : {}),
    ...(source.destroy ? { destroy: () => source.destroy?.() } : {}),
  };
}
