import type { DetectionFrameSourceVersionRange } from "#types/detection-timeline";

/**
 * Slack allowed when comparing two range ends.
 *
 * Range bounds are computed from frame times and durations, so an end that
 * should meet another exactly can miss it by a float's last bits.
 */
export const RANGE_EPSILON_SECONDS = 1e-6;

/**
 * Whether the available ranges together span the whole of `range`.
 *
 * Detections arrive a batch at a time, and a source that has not coalesced its
 * ranges holds several that abut. Asking each range on its own whether it spans
 * the window reports a window that is entirely covered as uncovered, so the
 * walk below spends ranges in order and asks how far their union reaches.
 */
export function isRangeCovered(
  range: DetectionFrameSourceVersionRange,
  availableRanges: readonly DetectionFrameSourceVersionRange[],
) {
  let reach: number | null = null;

  for (const availableRange of inStartOrder(availableRanges)) {
    if (reach === null) {
      if (availableRange.startTime > range.startTime + RANGE_EPSILON_SECONDS) {
        return false;
      }

      if (availableRange.endTime + RANGE_EPSILON_SECONDS < range.startTime) {
        continue;
      }

      reach = availableRange.endTime;
    } else {
      if (availableRange.startTime > reach + RANGE_EPSILON_SECONDS) {
        return false;
      }

      reach = Math.max(reach, availableRange.endTime);
    }

    if (reach + RANGE_EPSILON_SECONDS >= range.endTime) {
      return true;
    }
  }

  return false;
}

function inStartOrder(
  ranges: readonly DetectionFrameSourceVersionRange[],
): readonly DetectionFrameSourceVersionRange[] {
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index].startTime < ranges[index - 1].startTime) {
      return [...ranges].sort(
        (left, right) => left.startTime - right.startTime,
      );
    }
  }

  return ranges;
}
