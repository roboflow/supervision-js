import { describe, expect, it, vi } from "vitest";

import { createVisionCameraLiveSource } from "./vision-camera";

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
