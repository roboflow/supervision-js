import { Skia } from "@shopify/react-native-skia";
import { describe, expect, it, vi } from "vitest";

import {
  createReactNativeSkiaMaskFrame,
  disposeReactNativeSkiaImage,
} from "./skia";
import type { ReactNativeLiveSerializedDetection } from "./index";

vi.mock("@shopify/react-native-skia", () => ({
  AlphaType: { Opaque: 2 },
  ColorType: { Alpha_8: 1 },
  Skia: {
    Data: {
      fromBytes: vi.fn((bytes: Uint8Array) => ({ bytes })),
    },
    Image: {
      MakeImage: vi.fn(() => ({ dispose: vi.fn() })),
    },
  },
}));

const detection: ReactNativeLiveSerializedDetection = {
  bbox: { x1: 0, x2: 2, y1: 0, y2: 2 },
  color: 0xff0000,
  label: "person",
  mask: new Uint8Array([1, 1, 1, 1]),
  maskHeight: 2,
  maskWidth: 2,
};

describe("createReactNativeSkiaMaskFrame", () => {
  it("builds artifact, image, and uniforms as one packet", () => {
    const frame = createReactNativeSkiaMaskFrame({
      detections: [detection],
      frameHeight: 2,
      frameWidth: 2,
      mediaRect: { height: 2, width: 2, x: 0, y: 0 },
    });

    expect(frame).not.toBeNull();
    expect(frame!.builder).toBe("js");
    expect(frame!.byteLength).toBeGreaterThan(0);
    expect(frame!.uniforms.uMediaRect).toEqual([0, 0, 2, 2]);
    expect(Skia.Image.MakeImage).toHaveBeenCalledWith(
      expect.objectContaining({ alphaType: 2, colorType: 1 }),
      expect.anything(),
      frame!.width,
    );
  });

  it("returns null when there is nothing to draw", () => {
    expect(
      createReactNativeSkiaMaskFrame({
        detections: [],
        frameHeight: 2,
        frameWidth: 2,
        mediaRect: { height: 2, width: 2, x: 0, y: 0 },
      }),
    ).toBeNull();
  });

  it("returns null when the Skia image upload fails", () => {
    vi.mocked(Skia.Image.MakeImage).mockReturnValueOnce(null);

    expect(
      createReactNativeSkiaMaskFrame({
        detections: [detection],
        frameHeight: 2,
        frameWidth: 2,
        mediaRect: { height: 2, width: 2, x: 0, y: 0 },
      }),
    ).toBeNull();
  });
});

describe("disposeReactNativeSkiaImage", () => {
  it("disposes present images and tolerates absent ones", () => {
    const dispose = vi.fn();

    disposeReactNativeSkiaImage({
      dispose,
    } as unknown as Parameters<typeof disposeReactNativeSkiaImage>[0]);
    disposeReactNativeSkiaImage(null);
    disposeReactNativeSkiaImage(undefined);

    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
