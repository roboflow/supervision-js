import { beforeEach, describe, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => {
  const nativeSource = {
    close: vi.fn(),
    copyNextFrame: vi.fn(),
    durationMs: 12_500,
    frameHeight: 1080,
    frameWidth: 1920,
    nominalFrameRate: 30,
    open: vi.fn(),
  };
  const boxedSource = { unbox: vi.fn(() => nativeSource) };
  const createNativeSource = vi.fn<
    () => {
      readonly boxed: typeof boxedSource | null;
      readonly fallbackReason?: string;
    }
  >(() => ({ boxed: boxedSource }));

  return { boxedSource, createNativeSource, nativeSource };
});

vi.mock("../video-frame-source", () => ({
  createReactNativeVideoFrameSource: fixtures.createNativeSource,
}));

import { createReactNativeVideoFileSource } from "./video-file";

describe("createReactNativeVideoFileSource", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("owns native open, metadata, and idempotent close", () => {
    const source = createReactNativeVideoFileSource({
      fileUri: "file:///basketball.mp4",
    });

    expect(source.timeline).toEqual({
      duration: null,
      frameRate: null,
      height: 0,
      width: 0,
    });
    expect(() => source.boxedSource).toThrow(/has not been opened/);

    source.open();

    expect(fixtures.createNativeSource).toHaveBeenCalledTimes(1);
    expect(fixtures.nativeSource.open).toHaveBeenCalledWith(
      "file:///basketball.mp4",
    );
    expect(source.boxedSource).toBe(fixtures.boxedSource);
    expect(source.timeline).toEqual({
      duration: 12.5,
      frameRate: 30,
      height: 1080,
      width: 1920,
    });

    source.close();
    source.close();
    expect(fixtures.nativeSource.close).toHaveBeenCalledTimes(1);
  });

  it("keeps missing optional native dependencies diagnosable", () => {
    fixtures.createNativeSource.mockReturnValueOnce({
      boxed: null,
      fallbackReason: "nitro-module-unavailable",
    });
    const source = createReactNativeVideoFileSource({
      fileUri: "file:///missing.mp4",
    });

    expect(() => source.open()).toThrow(
      "video file source unavailable: nitro-module-unavailable",
    );
  });

  it("closes a partially opened native source before surfacing its error", () => {
    fixtures.nativeSource.open.mockImplementationOnce(() => {
      throw new Error("unsupported codec");
    });
    const source = createReactNativeVideoFileSource({
      fileUri: "file:///unsupported.mp4",
    });

    expect(() => source.open()).toThrow("unsupported codec");
    expect(fixtures.nativeSource.close).toHaveBeenCalledTimes(1);
    expect(() => source.boxedSource).toThrow(/has not been opened/);
  });
});
