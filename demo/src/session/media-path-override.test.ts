import { describe, expect, it } from "vitest";

import { readDemoMediaPathOverride } from "./media-path-override";
import { DemoMediaPath } from "./session-options";

describe("readDemoMediaPathOverride", () => {
  it("names no path when the query string carries none", () => {
    expect(readDemoMediaPathOverride("")).toBeNull();
    expect(readDemoMediaPathOverride("?clip=horse_trail")).toBeNull();
  });

  it("reads each path the workbench supports", () => {
    expect(readDemoMediaPathOverride("?mediaPath=engine")).toBe(
      DemoMediaPath.Engine,
    );
    expect(readDemoMediaPathOverride("?mediaPath=mediabunny")).toBe(
      DemoMediaPath.Mediabunny,
    );
  });

  it("refuses a path it does not support rather than guessing one", () => {
    expect(readDemoMediaPathOverride("?mediaPath=ffmpeg")).toBeNull();
    expect(readDemoMediaPathOverride("?mediaPath=")).toBeNull();
  });
});
