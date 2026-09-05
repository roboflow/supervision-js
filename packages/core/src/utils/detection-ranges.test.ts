import { describe, expect, it } from "vitest";

import { isRangeCovered } from "#utils/detection-ranges";

/** One range per sampled frame, the shape a source that never coalesces holds. */
function perFrameRanges(frameCount: number, frameDuration: number) {
  return Array.from({ length: frameCount }, (_, index) => ({
    endTime: (index + 1) * frameDuration,
    startTime: index * frameDuration,
  }));
}

describe("isRangeCovered", () => {
  it("covers a window that only the union of adjacent ranges spans", () => {
    const ranges = perFrameRanges(60, 1 / 30);

    expect(
      ranges.some((range) => range.startTime <= 0.5 && range.endTime >= 1.5),
    ).toBe(false);
    expect(isRangeCovered({ endTime: 1.5, startTime: 0.5 }, ranges)).toBe(true);
  });

  it("covers a window spanning batches that abut", () => {
    const ranges = [
      { endTime: 1, startTime: 0 },
      { endTime: 2, startTime: 1 },
      { endTime: 3, startTime: 2 },
    ];

    expect(isRangeCovered({ endTime: 2.5, startTime: 0.25 }, ranges)).toBe(
      true,
    );
  });

  it("reports a window uncovered when a hole falls inside it", () => {
    const ranges = [
      { endTime: 1, startTime: 0 },
      { endTime: 3, startTime: 1.5 },
    ];

    expect(isRangeCovered({ endTime: 2, startTime: 0.5 }, ranges)).toBe(false);
  });

  it("reports a window uncovered when nothing reaches its start", () => {
    const ranges = [{ endTime: 5, startTime: 2 }];

    expect(isRangeCovered({ endTime: 3, startTime: 1 }, ranges)).toBe(false);
  });

  it("walks ranges the caller handed over out of order", () => {
    const ranges = [
      { endTime: 3, startTime: 2 },
      { endTime: 1, startTime: 0 },
      { endTime: 2, startTime: 1 },
    ];

    expect(isRangeCovered({ endTime: 2.5, startTime: 0.5 }, ranges)).toBe(true);
  });

  it("leaves an unbounded window uncovered", () => {
    const ranges = perFrameRanges(60, 1 / 30);

    expect(
      isRangeCovered(
        { endTime: Number.POSITIVE_INFINITY, startTime: 0 },
        ranges,
      ),
    ).toBe(false);
  });

  it("closes a seam narrower than the epsilon", () => {
    const ranges = [
      { endTime: 1, startTime: 0 },
      { endTime: 2, startTime: 1 + 1e-9 },
    ];

    expect(isRangeCovered({ endTime: 1.5, startTime: 0.5 }, ranges)).toBe(true);
  });

  it("leaves a zero-width window past every range uncovered", () => {
    expect(
      isRangeCovered({ endTime: 2, startTime: 2 }, [
        { endTime: 1, startTime: 0 },
      ]),
    ).toBe(false);
  });

  it("covers a zero-width window that falls inside a range", () => {
    expect(
      isRangeCovered({ endTime: 2, startTime: 2 }, [
        { endTime: 3, startTime: 1 },
      ]),
    ).toBe(true);
  });

  it("leaves an empty range list uncovered", () => {
    expect(isRangeCovered({ endTime: 1, startTime: 0 }, [])).toBe(false);
  });
});
