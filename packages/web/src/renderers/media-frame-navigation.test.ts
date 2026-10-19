import { describe, expect, it, vi } from "vitest";

import type { MediaFrameClock, MediaFrameNavigation } from "../index";

import { createMediaFrameNavigation } from "./media-frame-navigation";

describe("media frame navigation", () => {
  it("maps frame and time addresses through the exact frame clock", async () => {
    const seek = vi.fn(async () => undefined);
    const controller = createController({ seek });
    const navigation: MediaFrameNavigation = controller.api;

    const byFrame = navigation.moveToFrame(1);
    expect(seek).toHaveBeenLastCalledWith(0.3);
    controller.presented({ index: 1, mediaTime: 0.3 });
    await expect(byFrame).resolves.toEqual({
      duration: 0.12,
      index: 1,
      mediaTime: 0.3,
    });

    const byTime = navigation.moveToTime(0.4);
    expect(seek).toHaveBeenLastCalledWith(0.3);
    controller.presented({ index: 1, mediaTime: 0.3 });
    await expect(byTime).resolves.toEqual({
      duration: 0.12,
      index: 1,
      mediaTime: 0.3,
    });
  });

  it("uses the clock to reject invalid frame and time addresses", async () => {
    const controller = createController();

    await expect(controller.api.moveToFrame(-1)).rejects.toBeInstanceOf(
      RangeError,
    );
    await expect(controller.api.moveToTime(Number.NaN)).rejects.toBeInstanceOf(
      RangeError,
    );
    expect(() => controller.api.scrubToFrame(3)).toThrow(RangeError);
    expect(() => controller.api.scrubToTime(Infinity)).toThrow(RangeError);
  });

  it("retains an exact presentation that arrives before the move command completes", async () => {
    const command = createDeferred<void>();
    const controller = createController({ seek: vi.fn(() => command.promise) });
    const move = controller.api.moveToFrame(2);
    const observed = observe(move);

    controller.presented({ index: 2, mediaTime: 0.42 });
    await Promise.resolve();
    expect(observed.status()).toBe("pending");

    command.resolve();
    await expect(move).resolves.toEqual({
      duration: 0.08,
      index: 2,
      mediaTime: 0.42,
    });
  });

  it("rejects when a move command completes without the exact presentation", async () => {
    const controller = createController();
    const move = controller.api.moveToFrame(0);

    await expect(move).rejects.toThrow(
      "Media seek completed without presenting the requested exact frame.",
    );
  });

  it("rejects a neighboring or coarse presentation as a mismatch", async () => {
    const command = createDeferred<void>();
    const controller = createController({ seek: vi.fn(() => command.promise) });
    const move = controller.api.moveToFrame(1);

    controller.presented({ index: 0, mediaTime: 0.25 });
    controller.presented({ index: 1, mediaTime: 0.300_001 });
    command.resolve();
    await expect(move).rejects.toThrow(
      "Media seek completed without presenting the requested exact frame.",
    );
  });

  it("rejects a superseded move with AbortError and keeps the new move active", async () => {
    const controller = createController();
    const first = controller.api.moveToFrame(0);
    const second = controller.api.moveToFrame(2);

    controller.presented({ index: 2, mediaTime: 0.42 });
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await expect(second).resolves.toMatchObject({ index: 2, mediaTime: 0.42 });
  });

  it("settles scrubs as landed or superseded without rejecting", async () => {
    const scrub = vi.fn();
    const controller = createController({ scrub });
    const first = controller.api.scrubToTime(0.4);

    expect(first.target).toEqual({
      duration: 0.12,
      index: 1,
      mediaTime: 0.3,
    });
    expect(scrub).toHaveBeenLastCalledWith(0.3);

    const second = controller.api.scrubToFrame(2);
    await expect(first.settled).resolves.toEqual({ status: "superseded" });
    controller.presented({ index: 2, mediaTime: 0.42 });
    await expect(second.settled).resolves.toEqual({
      frame: { duration: 0.08, index: 2, mediaTime: 0.42 },
      status: "landed",
    });
  });

  it("settles a scrub immediately when its exact frame is already displayed", async () => {
    const scrub = vi.fn();
    const controller = createController({ scrub });

    controller.presented({ index: 1, mediaTime: 0.3 });
    const request = controller.api.scrubToFrame(1);

    expect(scrub).toHaveBeenLastCalledWith(0.3);
    await expect(request.settled).resolves.toEqual({
      frame: { duration: 0.12, index: 1, mediaTime: 0.3 },
      status: "landed",
    });
  });

  it("settles a move when its exact frame is already displayed", async () => {
    const seek = vi.fn(async () => undefined);
    const controller = createController({ seek });

    controller.presented({ index: 2, mediaTime: 0.42 });
    await expect(controller.api.moveToFrame(2)).resolves.toEqual({
      duration: 0.08,
      index: 2,
      mediaTime: 0.42,
    });
    expect(seek).toHaveBeenLastCalledWith(0.42);
  });

  it("does not settle from a same-index presentation at a different timestamp", async () => {
    const controller = createController();

    controller.presented({ index: 1, mediaTime: 0.300_001 });
    const request = controller.api.scrubToFrame(1);
    const settled = observe(request.settled);
    await Promise.resolve();

    expect(settled.status()).toBe("pending");
    controller.cancel();
    await expect(request.settled).resolves.toEqual({ status: "superseded" });
  });

  it("does not settle from an older exact frame that is no longer displayed", async () => {
    const controller = createController();

    controller.presented({ index: 1, mediaTime: 0.3 });
    controller.presented({ index: 2, mediaTime: 0.42 });
    const request = controller.api.scrubToFrame(1);
    const settled = observe(request.settled);
    await Promise.resolve();

    expect(settled.status()).toBe("pending");
    controller.cancel();
    await expect(request.settled).resolves.toEqual({ status: "superseded" });
  });

  it("owns ignored promises and terminates active work on cancel or destroy", async () => {
    const command = createDeferred<void>();
    const failure = new Error("renderer closed");
    const controller = createController({ seek: vi.fn(() => command.promise) });

    void controller.api.moveToFrame(0);
    const scrub = controller.api.scrubToFrame(1);
    await Promise.resolve();
    controller.cancel();
    await expect(scrub.settled).resolves.toEqual({ status: "superseded" });

    const move = controller.api.moveToFrame(2);
    controller.destroy(failure);
    await expect(move).rejects.toBe(failure);
    command.reject(new Error("obsolete command failed"));
    await Promise.resolve();
  });
});

function createController(
  overrides: Partial<{
    seek: (mediaTime: number) => Promise<void>;
    scrub: (mediaTime: number) => void;
  }> = {},
) {
  return createMediaFrameNavigation({
    clock: createClock(),
    seek: overrides.seek ?? vi.fn(async () => undefined),
    scrub: overrides.scrub ?? vi.fn(),
  });
}

function createClock(): MediaFrameClock {
  const times = [0.25, 0.3, 0.42];
  const durations = [0.05, 0.12, 0.08];
  const validateIndex = (index: number) => {
    if (!Number.isInteger(index) || index < 0 || index >= times.length) {
      throw new RangeError("Invalid frame index.");
    }
  };

  return {
    duration: 0.25,
    endTimestamp: 0.5,
    firstTimestamp: 0.25,
    frameCount: times.length,
    durationAt(index) {
      validateIndex(index);
      return durations[index]!;
    },
    indexAtOrBefore(mediaTime) {
      if (!Number.isFinite(mediaTime)) {
        throw new RangeError("Media time must be finite.");
      }
      if (mediaTime < times[1]!) return 0;
      if (mediaTime < times[2]!) return 1;
      return 2;
    },
    timeAt(index) {
      validateIndex(index);
      return times[index]!;
    },
  };
}

function observe<T>(promise: Promise<T>) {
  let state: "pending" | "fulfilled" | "rejected" = "pending";

  void promise.then(
    () => {
      state = "fulfilled";
    },
    () => {
      state = "rejected";
    },
  );

  return { status: () => state };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
}
