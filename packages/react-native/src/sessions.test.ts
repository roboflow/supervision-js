import { describe, expect, it, vi } from "vitest";

import {
  createReactNativeVideoSession,
  createReactNativeWorkletRuntime,
} from "./sessions";

vi.mock("@shopify/react-native-skia", () => ({
  AlphaType: { Opaque: 2 },
  ColorType: { Alpha_8: 1 },
  Skia: {},
}));

describe("createReactNativeVideoSession", () => {
  it("throws a diagnosable error outside a device runtime", () => {
    // Off-device (Node/Vitest) the vendor worklet runtimes or the native
    // frame source are absent; the factory must fail loudly, not hang.
    expect(() =>
      createReactNativeVideoSession({
        fileUri: "file:///missing.mp4",
        mediaRect: { height: 1, width: 1, x: 0, y: 0 },
        runtime: {},
        serializeFrame: () => [],
      }),
    ).toThrow(/unavailable|Cannot find module/);
  });
});

describe("createReactNativeWorkletRuntime", () => {
  it("throws a diagnosable error outside a device runtime", () => {
    expect(() => createReactNativeWorkletRuntime("test-runtime")).toThrow();
  });
});
