import type { DetectionFrame } from "supervision-js";
import type { TimelineRange } from "./demo-session-types";

export function createBatchTimelineRange(
  frames: readonly { readonly duration: number; readonly mediaTime: number }[],
  mediaDuration: number,
): TimelineRange {
  const startTime = Math.min(...frames.map((frame) => frame.mediaTime));
  const endTime = Math.max(
    ...frames.map((frame) => frame.mediaTime + frame.duration),
  );

  return {
    endTime: clamp(endTime, 0, mediaDuration),
    startTime: clamp(startTime, 0, mediaDuration),
  };
}

export function createDetectionFrameTimelineRange(
  frame: DetectionFrame,
): TimelineRange {
  return {
    endTime: frame.endTime ?? frame.mediaTime,
    startTime: frame.mediaTime,
  };
}

export function addTimelineRange(
  ranges: readonly TimelineRange[],
  nextRange: TimelineRange,
) {
  return mergeTimelineRanges([...ranges, nextRange]);
}

export function appendTimelineRange(
  ranges: readonly TimelineRange[],
  nextRange: TimelineRange,
) {
  return ranges.some((range) => sameTimelineRange(range, nextRange))
    ? ranges
    : [...ranges, nextRange];
}

export function removeTimelineRange(
  ranges: readonly TimelineRange[],
  nextRange: TimelineRange,
) {
  return ranges.filter((range) => !sameTimelineRange(range, nextRange));
}

function mergeTimelineRanges(ranges: readonly TimelineRange[]) {
  const sortedRanges = [...ranges]
    .filter((range) => range.endTime >= range.startTime)
    .sort((first, second) => first.startTime - second.startTime);
  const mergedRanges: TimelineRange[] = [];

  for (const range of sortedRanges) {
    const previousRange = mergedRanges.at(-1);

    if (!previousRange || range.startTime > previousRange.endTime + 0.001) {
      mergedRanges.push(range);
      continue;
    }

    mergedRanges[mergedRanges.length - 1] = {
      endTime: Math.max(previousRange.endTime, range.endTime),
      startTime: previousRange.startTime,
    };
  }

  return mergedRanges;
}

function sameTimelineRange(first: TimelineRange, second: TimelineRange) {
  return (
    Math.abs(first.startTime - second.startTime) < 0.001 &&
    Math.abs(first.endTime - second.endTime) < 0.001
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
