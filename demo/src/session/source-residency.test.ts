import { describe, expect, it } from "vitest";

import { readDemoSourceResidency } from "./source-residency";

describe("readDemoSourceResidency", () => {
  it("stays off when the URL says nothing", () => {
    expect(readDemoSourceResidency("")).toBeUndefined();
    expect(readDemoSourceResidency("?residency=")).toBeUndefined();
    expect(readDemoSourceResidency("?residency=yes")).toBeUndefined();
  });

  it("holds without prefetching", () => {
    expect(readDemoSourceResidency("?residency=hold")).toEqual({
      budgetBytes: 160 * 1024 * 1024,
      prefetch: false,
    });
  });

  it("prefetches on request", () => {
    expect(readDemoSourceResidency("?residency=prefetch")?.prefetch).toBe(true);
  });

  it("takes a budget in megabytes", () => {
    expect(
      readDemoSourceResidency("?residency=hold&residencyMb=32")?.budgetBytes,
    ).toBe(32 * 1024 * 1024);
  });

  it("ignores a budget that is not a positive number", () => {
    expect(
      readDemoSourceResidency("?residency=hold&residencyMb=-4")?.budgetBytes,
    ).toBe(160 * 1024 * 1024);
    expect(
      readDemoSourceResidency("?residency=hold&residencyMb=lots")?.budgetBytes,
    ).toBe(160 * 1024 * 1024);
  });
});
