import { describe, expect, it, vi } from "vitest";
import type { MediaRendererSource } from "supervision";
import type { FrameTimelineData } from "supervision/web-video-engine";

import { tapActiveFrameTimeline } from "./player-frame-timeline";

describe("player frame timeline", () => {
  it("keeps the current source's table when an old open finishes last", async () => {
    const oldTimeline: FrameTimelineData = {
      tickRate: 30,
      ticks: new Float64Array([0, 1]),
      lastDurationTicks: 1,
    };
    const currentTimeline: FrameTimelineData = {
      tickRate: 30,
      ticks: new Float64Array([0, 1, 2]),
      lastDurationTicks: 1,
    };
    type Opened = Awaited<ReturnType<MediaRendererSource["open"]>>;
    let resolveOld!: (opened: Opened) => void;
    let resolveCurrent!: (opened: Opened) => void;
    const oldSource: MediaRendererSource = {
      open: () => new Promise((resolve) => (resolveOld = resolve)),
    };
    const currentSource: MediaRendererSource = {
      open: () => new Promise((resolve) => (resolveCurrent = resolve)),
    };
    const opened = (timeline: FrameTimelineData) =>
      ({ engine: { getMetadata: () => ({ timeline }) } }) as unknown as Opened;
    const publish = vi.fn();
    let oldActive = true;
    const oldOpen = tapActiveFrameTimeline(
      oldSource,
      () => oldActive,
      publish,
    ).open();

    oldActive = false;
    const currentOpen = tapActiveFrameTimeline(
      currentSource,
      () => true,
      publish,
    ).open();
    resolveCurrent(opened(currentTimeline));
    await currentOpen;
    resolveOld(opened(oldTimeline));
    await oldOpen;

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenLastCalledWith(currentTimeline);
  });
});
