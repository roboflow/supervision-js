import { describe, expect, it } from "vitest";

import { getReactNativeVideoFilePlatformAvailability } from "./video-frame-source";

describe("getReactNativeVideoFilePlatformAvailability", () => {
  it("keeps Android saved-video decoding explicitly unsupported", () => {
    expect(getReactNativeVideoFilePlatformAvailability("android")).toEqual({
      available: false,
      reason: "android-video-file-source-not-implemented-yet",
    });
  });

  it("does not claim an unavailable source for platforms with an implementation", () => {
    expect(getReactNativeVideoFilePlatformAvailability("ios")).toEqual({
      available: true,
    });
  });
});
