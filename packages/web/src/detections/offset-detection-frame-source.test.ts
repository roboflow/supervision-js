import { describe, expect, it, vi } from "vitest";

import type { DetectionFrameSource } from "supervision-js-core";
import { createOffsetDetectionFrameSource } from "./offset-detection-frame-source";

describe("offset detection frame source", () => {
  it("translates reads, frames, coverage, versions, and incremental changes", async () => {
    const source: DetectionFrameSource = {
      destroy: vi.fn(),
      getAvailableRanges: vi.fn(() => [{ startTime: 0, endTime: 1 }]),
      getChangesSince: vi.fn(() => ({
        ranges: [{ startTime: 0.25, endTime: 0.5 }],
        requiresReload: false,
        version: 3,
      })),
      getVersion: vi.fn(() => 3),
      loadFrames: vi.fn(async () => [
        {
          detections: [],
          endTime: 1 / 30,
          frameIndex: 0,
          mediaTime: 0,
        },
      ]),
      waitForRange: vi.fn(async () => undefined),
    };
    const shifted = createOffsetDetectionFrameSource(source, 0.6);

    await expect(shifted.loadFrames(0.6, 1.6)).resolves.toEqual([
      {
        detections: [],
        endTime: 0.6 + 1 / 30,
        frameIndex: 0,
        mediaTime: 0.6,
      },
    ]);
    expect(source.loadFrames).toHaveBeenCalledWith(0, 1);

    await shifted.waitForRange?.({ startTime: 0.6, endTime: 1.6 });
    expect(source.waitForRange).toHaveBeenCalledWith({
      startTime: 0,
      endTime: 1,
    });
    expect(shifted.getAvailableRanges?.()).toEqual([
      { startTime: 0.6, endTime: 1.6 },
    ]);
    expect(shifted.getVersion?.({ startTime: 0.6, endTime: 1.6 })).toBe(3);
    expect(source.getVersion).toHaveBeenCalledWith({
      startTime: 0,
      endTime: 1,
    });
    expect(
      shifted.getChangesSince?.(2, [{ startTime: 0.6, endTime: 1.6 }]),
    ).toEqual({
      ranges: [{ startTime: 0.85, endTime: 1.1 }],
      requiresReload: false,
      version: 3,
    });

    shifted.destroy?.();
    expect(source.destroy).toHaveBeenCalledOnce();
  });

  it("rejects a non-finite offset", () => {
    expect(() =>
      createOffsetDetectionFrameSource(
        { loadFrames: vi.fn(async () => []) },
        Number.NaN,
      ),
    ).toThrow("offsetSeconds must be finite.");
  });
});
