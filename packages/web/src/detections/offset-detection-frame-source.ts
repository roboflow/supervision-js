import type {
  DetectionFrame,
  DetectionFrameSource,
  DetectionFrameSourceVersionRange,
} from "supervision-js-core";

/**
 * Presents a detection source on a shifted media timeline.
 *
 * The wrapped source remains expressed in its own zero-based clock. Renderer
 * reads, coverage waits, and incremental changes are translated in both
 * directions so buffering and frame selection share the same timeline.
 */
export function createOffsetDetectionFrameSource(
  source: DetectionFrameSource,
  offsetSeconds: number,
): DetectionFrameSource {
  if (!Number.isFinite(offsetSeconds)) {
    throw new RangeError("offsetSeconds must be finite.");
  }

  const fromRendererRange = (range: DetectionFrameSourceVersionRange) => ({
    endTime: range.endTime - offsetSeconds,
    startTime: range.startTime - offsetSeconds,
  });
  const toRendererRange = (range: DetectionFrameSourceVersionRange) => ({
    endTime: range.endTime + offsetSeconds,
    startTime: range.startTime + offsetSeconds,
  });
  const toRendererFrame = (frame: DetectionFrame): DetectionFrame => ({
    ...frame,
    mediaTime: frame.mediaTime + offsetSeconds,
    ...(frame.endTime === undefined
      ? {}
      : { endTime: frame.endTime + offsetSeconds }),
  });

  return {
    async loadFrames(startTime, endTime) {
      const frames = await source.loadFrames(
        startTime - offsetSeconds,
        endTime - offsetSeconds,
      );
      return frames.map(toRendererFrame);
    },
    ...(source.waitForRange
      ? {
          waitForRange: (range: DetectionFrameSourceVersionRange) =>
            source.waitForRange?.(fromRendererRange(range)) ??
            Promise.resolve(),
        }
      : {}),
    ...(source.getAvailableRanges
      ? {
          getAvailableRanges: () =>
            (source.getAvailableRanges?.() ?? []).map(toRendererRange),
        }
      : {}),
    ...(source.getVersion
      ? {
          getVersion: (range?: DetectionFrameSourceVersionRange) =>
            source.getVersion?.(
              range === undefined ? undefined : fromRendererRange(range),
            ) ?? 0,
        }
      : {}),
    ...(source.getChangesSince
      ? {
          getChangesSince: (
            version: number,
            ranges: readonly DetectionFrameSourceVersionRange[],
          ) => {
            const changes = source.getChangesSince?.(
              version,
              ranges.map(fromRendererRange),
            );
            if (!changes) {
              return { ranges: [], requiresReload: false, version };
            }
            return {
              ...changes,
              ranges: changes.ranges.map(toRendererRange),
            };
          },
        }
      : {}),
    destroy: () => source.destroy?.(),
  };
}
