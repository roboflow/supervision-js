import { describe, expect, it } from "vitest";

import { getReactNativeVideoFilePlatformAvailability } from "./video-frame-source";

describe("getReactNativeVideoFilePlatformAvailability", () => {
  it("supports Android saved-video decoding from API 26", () => {
    expect(getReactNativeVideoFilePlatformAvailability("android", 26)).toEqual({
      available: true,
    });
    expect(getReactNativeVideoFilePlatformAvailability("android", 34)).toEqual({
      available: true,
    });
  });

  it("keeps Android below API 26 explicitly unsupported", () => {
    expect(getReactNativeVideoFilePlatformAvailability("android", 25)).toEqual({
      available: false,
      reason: "android-video-file-source-requires-api-26",
    });
  });

  it("stays available when the Android API level is unknown", () => {
    // The native module lookup reports its own failure reason when the
    // hybrid is genuinely missing; an unknown version must not block it.
    expect(getReactNativeVideoFilePlatformAvailability("android")).toEqual({
      available: true,
    });
  });

  it("does not claim an unavailable source for platforms with an implementation", () => {
    expect(getReactNativeVideoFilePlatformAvailability("ios")).toEqual({
      available: true,
    });
  });
});
