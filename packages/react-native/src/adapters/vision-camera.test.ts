import { describe, expect, it, vi } from "vitest";

import {
  createVisionCameraLiveSource,
  presentVisionCameraFrame,
  resolveVisionCameraFrameRendererStyle,
  resolveVisionCameraFrameSize,
  resolveVisionCameraPreferredZoom,
  useVisionCameraDevice,
  useVisionCameraFrameRenderer,
  useVisionCameraFrameOutput,
  useVisionCameraPermission,
} from "./vision-camera";

function createFrame(timestamp: number) {
  return {
    dispose: vi.fn(),
    height: 720,
    timestamp,
    width: 1280,
  };
}

describe("createVisionCameraLiveSource", () => {
  it("strictly serializes frames and disposes dropped native buffers", async () => {
    let finishFrame: (() => void) | undefined;
    const source = createVisionCameraLiveSource();
    const first = createFrame(1_000_000_000);
    const dropped = createFrame(2_000_000_000);

    source.start({
      onEnd: vi.fn(),
      onError: vi.fn(),
      onFrame: (frame) =>
        new Promise<void>((resolve) => {
          expect(frame.metadata).toMatchObject({
            frameIndex: 0,
            height: 720,
            mediaTime: 1,
            width: 1280,
          });
          finishFrame = resolve;
        }),
    });

    expect(source.offerFrame(first)).toBe(true);
    expect(source.offerFrame(dropped)).toBe(false);
    expect(dropped.dispose).toHaveBeenCalledOnce();

    finishFrame?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(first.dispose).toHaveBeenCalledOnce();
  });

  it("does not retain frames after stop or destroy", () => {
    const source = createVisionCameraLiveSource();
    const stopped = createFrame(0);
    const destroyed = createFrame(1);

    source.start({ onEnd: vi.fn(), onError: vi.fn(), onFrame: vi.fn() });
    source.stop?.();
    expect(source.offerFrame(stopped)).toBe(false);
    source.destroy?.();
    expect(source.offerFrame(destroyed)).toBe(false);
    expect(stopped.dispose).toHaveBeenCalledOnce();
    expect(destroyed.dispose).toHaveBeenCalledOnce();
  });
});

describe("useVisionCameraFrameOutput", () => {
  it("fails clearly outside a VisionCamera runtime", () => {
    expect(() =>
      useVisionCameraFrameOutput({
        onFrame: vi.fn(() => false),
        targetResolution: { height: 720, width: 1280 },
      }),
    ).toThrow(/VisionCamera frame output is unavailable/);
  });
});

describe("useVisionCameraFrameRenderer", () => {
  it("fails clearly outside a VisionCamera runtime", () => {
    expect(() => useVisionCameraFrameRenderer()).toThrow(
      /VisionCamera is unavailable/,
    );
  });
});

describe("VisionCamera hook adapters", () => {
  it("fails clearly outside a VisionCamera runtime", () => {
    expect(() => useVisionCameraDevice("back")).toThrow(
      /VisionCamera is unavailable/,
    );
    expect(() => useVisionCameraPermission()).toThrow(
      /VisionCamera is unavailable/,
    );
  });
});

describe("presentVisionCameraFrame", () => {
  it("renders only completed packets and always disposes the native frame", () => {
    const rendered = createFrame(0);
    const dropped = createFrame(1);
    const frameRenderer = { renderFrame: vi.fn() };

    presentVisionCameraFrame(rendered, frameRenderer, () => true);
    presentVisionCameraFrame(dropped, frameRenderer, () => false);

    expect(frameRenderer.renderFrame).toHaveBeenCalledOnce();
    expect(frameRenderer.renderFrame).toHaveBeenCalledWith(rendered);
    expect(rendered.dispose).toHaveBeenCalledOnce();
    expect(dropped.dispose).toHaveBeenCalledOnce();
  });

  it("releases the frame when host processing throws", () => {
    const frame = createFrame(0);

    expect(() =>
      presentVisionCameraFrame(frame, { renderFrame: vi.fn() }, () => {
        throw new Error("inference failed");
      }),
    ).toThrow(/inference failed/);
    expect(frame.dispose).toHaveBeenCalledOnce();
  });
});

describe("VisionCamera orientation", () => {
  it.each([
    ["up", { height: 720, width: 1280 }],
    ["down", { height: 720, width: 1280 }],
    ["left", { height: 1280, width: 720 }],
    ["right", { height: 1280, width: 720 }],
  ])("normalizes %s detection dimensions", (orientation, expected) => {
    expect(
      resolveVisionCameraFrameSize({
        height: 720,
        orientation,
        width: 1280,
      }),
    ).toEqual(expected);
  });

  it("uses the matching native renderer transform", () => {
    expect(
      resolveVisionCameraFrameRendererStyle({
        canvasHeight: 800,
        canvasWidth: 400,
        mediaHeight: 1280,
        mediaWidth: 720,
        orientation: "left",
      }),
    ).toMatchObject({
      height: 450,
      transform: [{ rotate: "90deg" }],
      width: 800,
    });
    expect(
      resolveVisionCameraFrameRendererStyle({
        canvasHeight: 800,
        canvasWidth: 400,
        mediaHeight: 1280,
        mediaWidth: 720,
        orientation: "down",
      }),
    ).toMatchObject({ transform: [{ rotate: "180deg" }] });
  });
});

describe("VisionCamera preferred zoom", () => {
  it("uses 0.5x when the selected camera supports the ultra-wide zoom", () => {
    expect(resolveVisionCameraPreferredZoom({ maxZoom: 8, minZoom: 0.5 })).toBe(
      0.5,
    );
  });

  it("falls back to the nearest zoom on cameras without an ultra-wide lens", () => {
    expect(resolveVisionCameraPreferredZoom({ maxZoom: 4, minZoom: 1 })).toBe(
      1,
    );
  });
});
