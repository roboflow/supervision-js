import { describe, expect, it, vi } from "vitest";

import { MediaRendererPlaybackState } from "#types/media-renderer";
import { createMediaRendererTransport } from "./media-renderer-transport";
import type {
  PresentedFrameChannel,
  PresentedFrameChannelStatus,
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
      onSeeking: vi.fn(),
    });

    for (let index = 0; index < FRAME_COUNT; index += 1) {
      producer.land(index);
    }

    expect(published.map(frameNamedBy)).toStrictEqual(
      Array.from({ length: FRAME_COUNT }, (_, index) => index),
    );
  });

  it("reports a seek the settled playback state cannot show", () => {
    const producer = createProducer();
    const playbackStates: MediaRendererPlaybackState[] = [];
    const seeking: boolean[] = [];

    createMediaRendererTransport({
      channel: producer.channel,
      loop: false,
      onPlaybackRate: vi.fn(),
      onPlaybackState: (state) => playbackStates.push(state),
      onPlayheadTime: vi.fn(),
      onSeeking: (next) => seeking.push(next),
    });

    producer.setStatus("PAUSED");
    producer.setSeeking(true);
    producer.land(120);
    const duringSeek = {
      playbackState: playbackStates.at(-1),
      seeking: seeking.at(-1),
    };
    producer.setSeeking(false);
    producer.land(120);

    expect(duringSeek).toStrictEqual({
      playbackState: MediaRendererPlaybackState.Paused,
      seeking: true,
    });
    expect(seeking.at(-1)).toBe(false);
  });

  it("calls a held gesture the viewer's own hand rather than a seek", () => {
    const producer = createProducer();
    const seeking: boolean[] = [];

    const transport = createMediaRendererTransport({
      channel: producer.channel,
      loop: false,
      onPlaybackRate: vi.fn(),
      onPlaybackState: vi.fn(),
      onPlayheadTime: vi.fn(),
      onSeeking: (next) => seeking.push(next),
    });

    transport.scrub(secondsAt(120));
    producer.setSeeking(true);
    producer.land(120);

    expect(seeking.at(-1)).toBe(false);
  });

  it("stops reporting a wait once a producer already at speed is asked to play", async () => {
    const producer = createProducer();
    const playbackStates: MediaRendererPlaybackState[] = [];
    let releaseReadiness = () => {};
    const readiness = new Promise<void>((resolve) => {
      releaseReadiness = resolve;
    });
    const transport = createMediaRendererTransport({
      channel: producer.channel,
      loop: false,
      onPlaybackRate: vi.fn(),
      onPlaybackState: (state) => playbackStates.push(state),
      onPlayheadTime: vi.fn(),
      onSeeking: vi.fn(),
      waitForReadiness: () => readiness,
    });

    const playing = transport.play();
    releaseReadiness();
    await playing;

    // The producer was already running, so it reports no change of its own.
    // Nothing else retires the wait the hold published on its way in.
    expect(playbackStates.at(-1)).toBe(MediaRendererPlaybackState.Playing);
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
  const stateListeners = new Set<() => void>();
  let playhead = landingAt(0);
  let seeking = false;
  let status: PresentedFrameChannelStatus = "PLAYING";
  const channel: PresentedFrameChannel = {
    beginInteractiveSeek: vi.fn(),
    commit: vi.fn(async () => undefined),
    endInteractiveSeek: vi.fn(async () => undefined),
    getDurationMs: () => secondsAt(FRAME_COUNT) * 1000,
    getPlaybackRate: () => 1,
    getPlayhead: () => playhead,
    getSeeking: () => seeking,
    getStatus: () => status,
    onPresentedFrame: vi.fn(),
    pause: vi.fn(),
    play: vi.fn(async () => undefined),
    scrub: vi.fn(),
    setPlaybackRate: vi.fn(),
    step: vi.fn(async () => undefined),
    subscribe: (signal, listener) => {
      if (signal === "time") {
        listeners.add(listener);
      } else {
        stateListeners.add(listener);
      }

      return () => {
        listeners.delete(listener);
        stateListeners.delete(listener);
      };
    },
  };

  const announce = () => {
    for (const listener of stateListeners) {
      listener();
    }
  };

  return {
    channel,

    land(index: number) {
      playhead = landingAt(index);

      for (const listener of listeners) {
        listener();
      }
      announce();
    },

    setSeeking(next: boolean) {
      seeking = next;
      announce();
    },

    setStatus(next: PresentedFrameChannelStatus) {
      status = next;
      announce();
    },
  };
}

function landingAt(index: number): PresentedFramePlayhead {
  return {
    frame: { index, ticks: index * TICKS_PER_FRAME },
    mediaTimeS: secondsAt(index),
  };
}
