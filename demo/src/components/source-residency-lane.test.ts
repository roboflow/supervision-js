import { describe, expect, it } from "vitest";

import {
  formatSourceResidency,
  readSourceResidencyRanges,
} from "./source-residency-lane";

const residency = (
  overrides: Partial<Parameters<typeof formatSourceResidency>[0]> = {},
) => ({
  prefetchedBytes: 0,
  ranges: [],
  residentBytes: 0,
  totalBytes: 1000,
  warming: false,
  ...overrides,
});

describe("source residency lane", () => {
  it("places a held run on the clock by its share of the file", () => {
    expect(
      readSourceResidencyRanges(
        residency({ ranges: [{ end: 750, start: 250 }] }),
        40,
      ),
    ).toStrictEqual([{ endTime: 30, startTime: 10 }]);
  });

  it("draws nothing until a response has disclosed the file's length", () => {
    expect(
      readSourceResidencyRanges(
        residency({ ranges: [{ end: 750, start: 250 }], totalBytes: null }),
        40,
      ),
    ).toStrictEqual([]);
  });

  /**
   * An empty lane reads as a file nobody has touched. Residency is off unless
   * the page asked for it, and off is the case a viewer would otherwise misread.
   */
  it("says the engine is holding nothing rather than holding none of it", () => {
    expect(formatSourceResidency(null)).toBe("off");
    expect(formatSourceResidency(residency())).toBe("0% · 0.0 MiB");
  });

  it("reports the share of the file held and how much that is", () => {
    expect(
      formatSourceResidency(
        residency({
          residentBytes: 5 * 1024 * 1024,
          totalBytes: 20 * 1024 * 1024,
        }),
      ),
    ).toBe("25% · 5.0 MiB");
  });

  it("says a background walk is still filling", () => {
    expect(
      formatSourceResidency(
        residency({
          residentBytes: 2 * 1024 * 1024,
          totalBytes: 8 * 1024 * 1024,
          warming: true,
        }),
      ),
    ).toBe("25% · 2.0 MiB · filling");
  });
});
