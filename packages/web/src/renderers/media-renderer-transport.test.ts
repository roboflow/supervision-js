import { describe, expect, it, vi } from "vitest";

import { createMediaRendererTransport } from "./media-renderer-transport";
import type {
  PresentedFrameChannel,
  PresentedFramePlayhead,
} from "./presented-frame-channel";

/** An NTSC track: 30000 ticks a second, one frame every 1001 of them. */
const TICK_RATE = 30000;
const TICKS_PER_FRAME = 1001;
const FRAME_COUNT = 300;

describe("media renderer transport", () => {
  it("publishes a playhead time that names the frame it came from", () => {
    const producer = createProducer();
    const published: number[] = [];

    createMediaRendererTransport({
      channel: producer.channel,
      loop: false,
      onPlaybackRate: vi.fn(),
      onPlaybackState: vi.fn(),
      onPlayheadTime: (mediaTime) => published.push(mediaTime),
    });

    for (let index = 0; index < FRAME_COUNT; index += 1) {
      producer.land(index);
    }

    expect(published.map(frameNamedBy)).toStrictEqual(
      Array.from({ length: FRAME_COUNT }, (_, index) => index),
    );
  });
});

const secondsAt = (index: number) => (index * TICKS_PER_FRAME) / TICK_RATE;

/**
 * The frame whose own published second is exactly `mediaTime`, or -1 for a time
 * that falls between two frames. Equality, with no tolerance to hide behind:
 * a position that lands between frames is the defect this asserts against.
 */
function frameNamedBy(mediaTime: number): number {
  for (let index = 0; index < FRAME_COUNT; index += 1) {
    if (secondsAt(index) === mediaTime) {
      return index;
    }
  }

  return -1;
}

function createProducer() {
  const listeners = new Set<() => void>();
  let playhead = landingAt(0);
  const channel: PresentedFrameChannel = {
    beginInteractiveSeek: vi.fn(),
    commit: vi.fn(async () => undefined),
    endInteractiveSeek: vi.fn(async () => undefined),
    getDurationMs: () => secondsAt(FRAME_COUNT) * 1000,
    getPlaybackRate: () => 1,
    getPlayhead: () => playhead,
    getSeeking: () => false,
    getStatus: () => "PLAYING",
    onPresentedFrame: vi.fn(),
    pause: vi.fn(),
    play: vi.fn(async () => undefined),
    scrub: vi.fn(),
    setPlaybackRate: vi.fn(),
    step: vi.fn(async () => undefined),
    subscribe: (signal, listener) => {
      if (signal === "time") {
        listeners.add(listener);
      }

      return () => listeners.delete(listener);
    },
    togglePlayback: vi.fn(),
  };

  return {
    channel,

    land(index: number) {
      playhead = landingAt(index);

      for (const listener of listeners) {
        listener();
      }
    },
  };
}

function landingAt(index: number): PresentedFramePlayhead {
  return {
    frame: { index, ticks: index * TICKS_PER_FRAME },
    mediaTimeS: secondsAt(index),
  };
}
