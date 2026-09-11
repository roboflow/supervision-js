import { describe, expect, it, vi } from "vitest";
import { videoPresentationDuration } from "./video-presentation-duration";

function track(end = 55.232733, first = 0) {
  return {
    computeDuration: vi.fn(async () => end),
    getFirstTimestamp: vi.fn(async () => first),
    isLive: vi.fn(async () => false),
  };
}

describe("selected video presentation duration", () => {
  it.each([1.8411, 552.33, 55.232733])(
    "uses packet timing instead of a %s duration hint",
    async (hint) => {
      const video = track();
      expect(await videoPresentationDuration(video, hint)).toBe(55.232733);
      expect(video.computeDuration).toHaveBeenCalledWith({
        skipLiveWait: true,
      });
    },
  );
  it("subtracts a positive first timestamp exactly once", async () => {
    expect(await videoPresentationDuration(track(12, 2))).toBe(10);
  });
  it("does not extend the presentation span for negative edit-list pre-roll", async () => {
    expect(await videoPresentationDuration(track(12, -0.08))).toBe(12);
  });
  it("preserves zero duration for empty finite media", async () => {
    expect(await videoPresentationDuration(track(0))).toBe(0);
  });
  it("keeps live duration unknown without waiting for its last packet", async () => {
    const video = track();
    video.isLive.mockResolvedValue(true);
    expect(await videoPresentationDuration(video)).toBeNull();
    expect(video.computeDuration).not.toHaveBeenCalled();
    expect(video.getFirstTimestamp).not.toHaveBeenCalled();
  });
  it("retains the finite original's span while a normalization stream is growing", async () => {
    const video = track();
    video.isLive.mockResolvedValue(true);
    expect(await videoPresentationDuration(video, 55.232733)).toBe(55.232733);
    expect(video.computeDuration).not.toHaveBeenCalled();
  });
  it.each([NaN, Infinity, -1])(
    "rejects invalid live hints: %s",
    async (hint) => {
      const video = track();
      video.isLive.mockResolvedValue(true);
      expect(await videoPresentationDuration(video, hint)).toBeNull();
    },
  );
  it("does not wait for EOF of a growing non-live container", async () => {
    const video = track();
    video.computeDuration.mockImplementation(() => new Promise(() => {}));
    expect(await videoPresentationDuration(video, 12, true)).toBe(12);
    expect(await videoPresentationDuration(video, undefined, true)).toBeNull();
    expect(video.computeDuration).not.toHaveBeenCalled();
    expect(video.isLive).not.toHaveBeenCalled();
  });
  it("keeps unavailable finite timing unknown", async () => {
    expect(await videoPresentationDuration(track(Infinity))).toBeNull();
  });
  it("does not silently fall back to a bad header when packet reads fail", async () => {
    const video = track();
    video.computeDuration.mockRejectedValue(
      new Error("unreadable packet index"),
    );
    await expect(videoPresentationDuration(video, 1.8)).rejects.toThrow(
      "packet index",
    );
  });
});
