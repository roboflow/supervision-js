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
      onScrubbing: vi.fn(),
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
      onScrubbing: vi.fn(),
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

  it("reports a gesture apart from the settle it lands in", () => {
    const producer = createProducer();
    const seeking: boolean[] = [];
    const scrubbing: boolean[] = [];

    const transport = createMediaRendererTransport({
      channel: producer.channel,
      loop: false,
      onPlaybackRate: vi.fn(),
      onPlaybackState: vi.fn(),
      onPlayheadTime: vi.fn(),
      onScrubbing: (next) => scrubbing.push(next),
      onSeeking: (next) => seeking.push(next),
    });

    transport.scrub(secondsAt(120));
    producer.setSeeking(true);
    producer.land(120);

    expect({
      scrubbing: scrubbing.at(-1),
      seeking: seeking.at(-1),
    }).toStrictEqual({ scrubbing: true, seeking: true });
  });

  /**
   * The producer answers on its own thread, so nothing it says lands between
   * the hand going down and the drag that follows. A settle reported just
   * before would otherwise stand for the whole drag.
   */
  it("says the hand is down without waiting for the producer to speak", async () => {
    const producer = createProducer();
    const seeking: boolean[] = [];
    const scrubbing: boolean[] = [];

    const transport = createMediaRendererTransport({
      channel: producer.channel,
      loop: false,
      onPlaybackRate: vi.fn(),
      onPlaybackState: vi.fn(),
      onPlayheadTime: vi.fn(),
      onScrubbing: (next) => scrubbing.push(next),
      onSeeking: (next) => seeking.push(next),
    });

    producer.setStatus("PAUSED");
    producer.setSeeking(true);

    transport.scrub(secondsAt(200));
    const withHandDown = scrubbing.at(-1);

    await transport.commit(secondsAt(200));

    expect({ afterCommit: scrubbing.at(-1), withHandDown }).toStrictEqual({
      afterCommit: false,
      withHandDown: true,
    });
    expect(seeking.at(-1)).toBe(true);
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
      onScrubbing: vi.fn(),
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

  it("tells the gate that a play a pause superseded is never coming", async () => {
    const producer = createProducer();
    let abandoned = false;
    let enterWait = () => {};
    const waitEntered = new Promise<void>((resolve) => {
      enterWait = resolve;
    });
    const transport = createMediaRendererTransport({
      channel: producer.channel,
      loop: false,
      onPlaybackRate: vi.fn(),
      onPlaybackState: vi.fn(),
      onPlayheadTime: vi.fn(),
      onScrubbing: vi.fn(),
      onSeeking: vi.fn(),
      waitForReadiness: (_mediaTime, signal) => {
        enterWait();

        return new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            abandoned = true;
            resolve();
          });
        });
      },
    });

    const playing = transport.play();

    await waitEntered;
    transport.pause();
    await playing;

    expect(abandoned).toBe(true);
  });

  it("leaves no gate hold behind when a play supersedes one still releasing a drag", async () => {
    const producer = createProducer();
    const readinessSignals: AbortSignal[] = [];
    const transport = createMediaRendererTransport({
      channel: producer.channel,
      loop: false,
      onPlaybackRate: vi.fn(),
      onPlaybackState: vi.fn(),
      onPlayheadTime: vi.fn(),
      onScrubbing: vi.fn(),
      onSeeking: vi.fn(),
      waitForReadiness: (_mediaTime, signal) => {
        readinessSignals.push(signal);

        return new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve());
        });
      },
    });

    transport.scrub(0.1);

    const superseded = transport.play();
    const current = transport.play();

    await Promise.resolve();
    transport.pause();
    await Promise.all([superseded, current]);

    expect({
      abandonedCount: readinessSignals.filter((signal) => signal.aborted)
        .length,
      startedCount: readinessSignals.length,
    }).toEqual({ abandonedCount: 1, startedCount: 1 });
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

describe("mid-playback readiness holds", () => {
  it("stops the picture at the first frame nothing can annotate and starts it again when the annotations land", async () => {
    const producer = createProducer();
    const playbackStates: MediaRendererPlaybackState[] = [];
    let coveredThroughSeconds = 2;
    let releaseWait = () => {};

    createMediaRendererTransport({
      channel: producer.channel,
      loop: false,
      holdForReadiness: (mediaTime) =>
        mediaTime > coveredThroughSeconds
          ? new Promise<void>((resolve) => {
              releaseWait = resolve;
            })
          : null,
      onPlaybackRate: vi.fn(),
      onPlaybackState: (state) => playbackStates.push(state),
      onPlayheadTime: vi.fn(),
      onScrubbing: vi.fn(),
      onSeeking: vi.fn(),
    });

    producer.play(120);
    const held = {
      pastCoverage: secondsAt(producer.landedIndex) > coveredThroughSeconds,
      playbackState: playbackStates.at(-1),
      withinOneFrameOfCoverage:
        secondsAt(producer.landedIndex - 1) <= coveredThroughSeconds,
    };

    coveredThroughSeconds = 10;
    releaseWait();
    await vi.waitFor(() =>
      expect(producer.channel.endInteractiveSeek).toHaveBeenCalled(),
    );

    producer.play(120);

    expect(held).toStrictEqual({
      pastCoverage: true,
      playbackState: MediaRendererPlaybackState.Buffering,
      withinOneFrameOfCoverage: true,
    });
    expect(producer.landedIndex).toBe(120);
    expect(playbackStates.at(-1)).toBe(MediaRendererPlaybackState.Playing);
  });

  it("lets the picture go when a producer stops answering, and does not stop it again for every frame after", async () => {
    const producer = createProducer();
    // The gate bounds its own wait and remembers the source it gave up on, so
    // the second question it is asked answers no rather than waiting again.
    let gaveUp = false;

    createMediaRendererTransport({
      channel: producer.channel,
      loop: false,
      holdForReadiness: () =>
        gaveUp
          ? null
          : Promise.resolve().then(() => {
              gaveUp = true;
            }),
      onPlaybackRate: vi.fn(),
      onPlaybackState: vi.fn(),
      onPlayheadTime: vi.fn(),
      onScrubbing: vi.fn(),
      onSeeking: vi.fn(),
    });

    producer.play(120);
    await vi.waitFor(() =>
      expect(producer.channel.endInteractiveSeek).toHaveBeenCalled(),
    );
    producer.play(120);

    expect(producer.landedIndex).toBe(120);
    expect(producer.channel.beginInteractiveSeek).toHaveBeenCalledTimes(1);
  });

  it("starts the producer again when the wait it was holding for fails", async () => {
    const producer = createProducer();
    let held = 0;

    createMediaRendererTransport({
      channel: producer.channel,
      loop: false,
      holdForReadiness: () =>
        (held += 1) === 1
          ? Promise.reject(new Error("Detection source is gone."))
          : null,
      onPlaybackRate: vi.fn(),
      onPlaybackState: vi.fn(),
      onPlayheadTime: vi.fn(),
      onScrubbing: vi.fn(),
      onSeeking: vi.fn(),
    });

    producer.play(120);
    await vi.waitFor(() =>
      expect(producer.channel.endInteractiveSeek).toHaveBeenCalled(),
    );
    producer.play(120);

    expect(producer.landedIndex).toBe(120);
  });

  it("leaves a producer alone when nothing can say whether waiting would help", () => {
    const producer = createProducer();

    createMediaRendererTransport({
      channel: producer.channel,
      loop: false,
      onPlaybackRate: vi.fn(),
      onPlaybackState: vi.fn(),
      onPlayheadTime: vi.fn(),
      onScrubbing: vi.fn(),
      onSeeking: vi.fn(),
      waitForReadiness: async () => undefined,
    });

    producer.play(120);

    expect(producer.landedIndex).toBe(120);
    expect(producer.channel.beginInteractiveSeek).not.toHaveBeenCalled();
  });

  it("hands a drag the hold rather than resuming under it", async () => {
    const producer = createProducer();
    let releaseWait = () => {};

    const transport = createMediaRendererTransport({
      channel: producer.channel,
      loop: false,
      holdForReadiness: () =>
        new Promise<void>((resolve) => {
          releaseWait = resolve;
        }),
      onPlaybackRate: vi.fn(),
      onPlaybackState: vi.fn(),
      onPlayheadTime: vi.fn(),
      onScrubbing: vi.fn(),
      onSeeking: vi.fn(),
    });

    producer.play(120);
    transport.scrub(secondsAt(200));
    releaseWait();
    await Promise.resolve();
    await Promise.resolve();

    expect(producer.channel.endInteractiveSeek).not.toHaveBeenCalled();

    await transport.commit(secondsAt(200));

    expect(producer.channel.endInteractiveSeek).toHaveBeenCalled();
  });

  it("gives the producer back when a pause supersedes a play that took a hold over", async () => {
    const producer = createProducer();
    let enterWait = () => {};
    const waitEntered = new Promise<void>((resolve) => {
      enterWait = resolve;
    });
    const transport = createMediaRendererTransport({
      channel: producer.channel,
      loop: false,
      holdForReadiness: () => new Promise<void>(() => {}),
      onPlaybackRate: vi.fn(),
      onPlaybackState: vi.fn(),
      onPlayheadTime: vi.fn(),
      onScrubbing: vi.fn(),
      onSeeking: vi.fn(),
      waitForReadiness: (_mediaTime, signal) => {
        enterWait();

        return new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve());
        });
      },
    });

    producer.land(1);

    const playing = transport.play();

    await waitEntered;
    transport.pause();
    await playing;

    expect(producer.channel.beginInteractiveSeek).toHaveBeenCalledOnce();
    expect(producer.channel.endInteractiveSeek).toHaveBeenCalledOnce();
  });

  it("gives the producer back when the wait a play made fails under it", async () => {
    const producer = createProducer();
    const transport = createMediaRendererTransport({
      channel: producer.channel,
      loop: false,
      holdForReadiness: () => new Promise<void>(() => {}),
      onPlaybackRate: vi.fn(),
      onPlaybackState: vi.fn(),
      onPlayheadTime: vi.fn(),
      onScrubbing: vi.fn(),
      onSeeking: vi.fn(),
      waitForReadiness: () =>
        Promise.reject(new Error("Annotations are gone.")),
    });

    producer.land(1);

    await expect(transport.play()).rejects.toThrow("Annotations are gone.");

    expect(producer.channel.beginInteractiveSeek).toHaveBeenCalledOnce();
    expect(producer.channel.endInteractiveSeek).toHaveBeenCalledOnce();
  });
});

function createProducer() {
  const listeners = new Set<() => void>();
  const stateListeners = new Set<() => void>();
  let playhead = landingAt(0);
  let seeking = false;
  let frozen = false;
  let status: PresentedFrameChannelStatus = "PLAYING";
  const channel: PresentedFrameChannel = {
    // The engine's own latch: a mechanical pause arms it, a second one is a
    // no-op, and the release resumes only what the latch paused.
    beginInteractiveSeek: vi.fn(() => {
      if (frozen || status !== "PLAYING") {
        return;
      }

      frozen = true;
      status = "PAUSED";
      announce();
    }),
    commit: vi.fn(async () => undefined),
    endInteractiveSeek: vi.fn(async () => {
      if (!frozen) {
        return;
      }

      frozen = false;
      status = "PLAYING";
      announce();
    }),
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

    get landedIndex() {
      return playhead.frame.index;
    },

    land(index: number) {
      playhead = landingAt(index);

      for (const listener of listeners) {
        listener();
      }
      announce();
    },

    /** Walks frames forward, stopping wherever the producer is frozen. */
    play(throughIndex: number) {
      for (
        let index = playhead.frame.index + 1;
        index <= throughIndex && !frozen;
        index += 1
      ) {
        this.land(index);
      }
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
