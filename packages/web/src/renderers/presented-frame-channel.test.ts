import { describe, expect, it, vi } from "vitest";

import {
  resolvePresentedFrameChannel,
  type PresentedFrameChannel,
} from "./presented-frame-channel";

describe("presented frame channel", () => {
  it("finds the plane a push-based source publishes", () => {
    const engine = createChannel();

    expect(resolvePresentedFrameChannel({ engine })).toBe(engine);
  });

  it.each([
    ["a pull-only source", { sampleSink: {} }],
    ["an engine without the plane", { engine: {} }],
    [
      "a producer that announces frames but drives none of the playhead",
      { engine: { onPresentedFrame: () => undefined } },
    ],
    ["nothing", null],
  ])("has no channel for %s", (_label, source) => {
    expect(resolvePresentedFrameChannel(source)).toBeNull();
  });
});

function createChannel(): PresentedFrameChannel {
  return {
    beginInteractiveSeek: vi.fn(),
    commit: vi.fn(async () => undefined),
    endInteractiveSeek: vi.fn(async () => undefined),
    getDurationMs: vi.fn(() => 0),
    getSeeking: vi.fn(() => false),
    getStatus: vi.fn(() => "READY" as const),
    getTimeMs: vi.fn(() => 0),
    onPresentedFrame: vi.fn(),
    pause: vi.fn(),
    play: vi.fn(async () => undefined),
    scrub: vi.fn(),
    step: vi.fn(async () => undefined),
    subscribe: vi.fn(() => () => undefined),
    togglePlayback: vi.fn(),
  };
}
