import { afterEach, describe, expect, it, vi } from "vitest";

import { getDemoMaxDevicePixelRatio } from "./render-quality";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getDemoMaxDevicePixelRatio", () => {
  it("hands every grid the same stated ceiling", () => {
    vi.stubGlobal("devicePixelRatio", 3);

    expect(getDemoMaxDevicePixelRatio(1.5)).toBe(1.5);
  });

  it("states the viewer's own ratio where the demo caps nothing", () => {
    vi.stubGlobal("devicePixelRatio", 3);

    expect(getDemoMaxDevicePixelRatio(undefined)).toBe(3);
  });
});
