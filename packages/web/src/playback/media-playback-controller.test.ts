import { describe, expect, it, vi } from "vitest";

import type { DecodedVideoSample } from "#media/media-source";

import {
  createMockSample,
  domMock,
  flushAnimationFrame,
  mediaMock,
  resetMocks,
} from "../../../../test/media-renderer-harness";
import { createMediaPlaybackController } from "./media-playback-controller";

describe("media playback controller", () => {
  it("advances the media clock at the configured playback rate", async () => {
    resetMocks();
    mediaMock.samples = [
      createMockSample(0, 0.04),
      createMockSample(0.04, 0.04),
    ];
    const presentedTimestamps: number[] = [];
    const controller = createMediaPlaybackController({
      duration: 0.08,
      firstTimestamp: 0,
      initialMediaTime: 0,
      loop: false,
      playbackRate: 2,
      onCurrentTimeChange: vi.fn(),
      onEnded: vi.fn(),
      onError: vi.fn(),
      presentSample: (sample) => {
        presentedTimestamps.push(sample.timestamp);
        sample.close();
      },
      sampleSink: mediaMockSampleSink(),
    });

    controller.play();
    flushAnimationFrame(20);

    await vi.waitFor(() => {
      expect(presentedTimestamps).toEqual([0.04]);
    });

    controller.destroy();
  });

  it("does not present synthetic frames when decoded samples have a gap", async () => {
    resetMocks();
    mediaMock.samples = [
      createMockSample(0, 1 / 30),
      createMockSample(2 / 30, 1 / 30),
    ];
    const presentedTimestamps: number[] = [];
    const controller = createMediaPlaybackController({
      duration: 3 / 30,
      firstTimestamp: 0,
      initialMediaTime: 0,
      loop: false,
      onCurrentTimeChange: vi.fn(),
      onEnded: vi.fn(),
      onError: vi.fn(),
      presentSample: (sample) => {
        presentedTimestamps.push(sample.timestamp);
        sample.close();
      },
      sampleSink: mediaMockSampleSink(),
    });

    controller.play();
    flushAnimationFrame(1_000 / 30);
    await Promise.resolve();

    expect(presentedTimestamps).toEqual([]);

    await vi.waitFor(() => {
      expect(domMock.rafCallbacks.length).toBeGreaterThan(0);
    });

    flushAnimationFrame(2_000 / 30);

    await vi.waitFor(() => {
      expect(presentedTimestamps).toEqual([2 / 30]);
    });

    controller.destroy();
  });

  it("stops queued presentation when playback is paused", async () => {
    resetMocks();
    mediaMock.samples = [
      createMockSample(0, 1 / 30),
      createMockSample(1 / 30, 1 / 30),
    ];
    const presentSample = vi.fn((sample: DecodedVideoSample) => {
      sample.close();
    });
    const controller = createMediaPlaybackController({
      duration: 2 / 30,
      firstTimestamp: 0,
      initialMediaTime: 0,
      loop: false,
      onCurrentTimeChange: vi.fn(),
      onEnded: vi.fn(),
      onError: vi.fn(),
      presentSample,
      sampleSink: mediaMockSampleSink(),
    });

    controller.play();
    controller.pause();
    flushAnimationFrame(1_000 / 30);
    await Promise.resolve();

    expect(presentSample).not.toHaveBeenCalled();
    expect(domMock.cancelAnimationFrame).toHaveBeenCalled();

    controller.destroy();
  });

  it("loops by resetting to the first decoded timestamp", async () => {
    resetMocks();
    mediaMock.samples = [
      createMockSample(0, 1 / 30),
      createMockSample(1 / 30, 1 / 30),
    ];
    const presentedTimestamps: number[] = [];
    const currentTimes: number[] = [];
    const controller = createMediaPlaybackController({
      duration: 2 / 30,
      firstTimestamp: 0,
      initialMediaTime: 0,
      loop: true,
      onCurrentTimeChange: (currentTime) => {
        currentTimes.push(currentTime);
      },
      onEnded: vi.fn(),
      onError: vi.fn(),
      presentSample: (sample) => {
        presentedTimestamps.push(sample.timestamp);
        sample.close();
      },
      sampleSink: mediaMockSampleSink(),
    });

    controller.play();
    flushAnimationFrame(1_000 / 30);

    await vi.waitFor(() => {
      expect(presentedTimestamps).toEqual([1 / 30]);
    });

    flushAnimationFrame(2_000 / 30);

    await vi.waitFor(() => {
      expect(presentedTimestamps).toEqual([1 / 30, 0]);
    });
    expect(currentTimes).toContain(0);
    expect(mediaMock.samplesCallStarts).toEqual([0, 0]);

    controller.destroy();
  });

  it("loops when decoded samples end before the declared media duration", async () => {
    resetMocks();
    mediaMock.samples = [
      createMockSample(0, 1 / 30),
      createMockSample(1 / 30, 1 / 30),
    ];
    const presentedTimestamps: number[] = [];
    const onEnded = vi.fn();
    const controller = createMediaPlaybackController({
      duration: 1,
      firstTimestamp: 0,
      initialMediaTime: 0,
      loop: true,
      onCurrentTimeChange: vi.fn(),
      onEnded,
      onError: vi.fn(),
      presentSample: (sample) => {
        presentedTimestamps.push(sample.timestamp);
        sample.close();
      },
      sampleSink: mediaMockSampleSink(),
    });

    controller.play();
    flushAnimationFrame(1_000 / 30);

    await vi.waitFor(() => {
      expect(presentedTimestamps).toEqual([1 / 30]);
    });

    flushAnimationFrame(2_000 / 30);

    await vi.waitFor(() => {
      expect(presentedTimestamps).toEqual([1 / 30, 0]);
    });
    expect(onEnded).not.toHaveBeenCalled();
    expect(mediaMock.samplesCallStarts).toEqual([0, 0]);

    controller.destroy();
  });

  it("ends live playback when its sample iterator is exhausted", async () => {
    resetMocks();
    mediaMock.samples = [];
    const onEnded = vi.fn();
    const controller = createMediaPlaybackController({
      duration: null,
      firstTimestamp: 0,
      initialMediaTime: 0,
      loop: false,
      onCurrentTimeChange: vi.fn(),
      onEnded,
      onError: vi.fn(),
      presentSample: vi.fn(),
      sampleSink: mediaMockSampleSink(),
    });

    controller.play();
    flushAnimationFrame(0);

    await vi.waitFor(() => expect(onEnded).toHaveBeenCalledOnce());
    controller.destroy();
  });

  it("presents a live sample without waiting for the next sample", async () => {
    resetMocks();
    const sample = createMockSample(0, 1 / 30);
    let releaseIterator: (() => void) | undefined;
    const nextSample = new Promise<void>((resolve) => {
      releaseIterator = resolve;
    });
    const presentedTimestamps: number[] = [];
    const controller = createMediaPlaybackController({
      duration: null,
      firstTimestamp: 0,
      initialMediaTime: -1 / 30,
      loop: false,
      onCurrentTimeChange: vi.fn(),
      onEnded: vi.fn(),
      onError: vi.fn(),
      presentSample: (presentedSample) => {
        presentedTimestamps.push(presentedSample.timestamp);
        presentedSample.close();
      },
      sampleSink: {
        getSample: mediaMock.getSample,
        async *samples() {
          yield sample as unknown as DecodedVideoSample;
          await nextSample;
        },
      },
    });

    controller.play();
    flushAnimationFrame(1_000 / 30);

    await vi.waitFor(() => expect(presentedTimestamps).toEqual([0]));

    controller.destroy();
    releaseIterator?.();
  });

  /**
   * The picture running out of decoded samples is the whole of a byte stall on
   * a pulled source, and nothing downstream of the read reports it: the
   * playhead keeps its state and no transport is consulted.
   */
  it("reports the wait while the source owes the picture its next sample", async () => {
    resetMocks();
    let releaseSample: (() => void) | undefined;
    const heldSample = new Promise<void>((resolve) => {
      releaseSample = resolve;
    });
    const sourceWaits: boolean[] = [];
    const presentedTimestamps: number[] = [];
    const controller = createMediaPlaybackController({
      duration: null,
      firstTimestamp: 0,
      initialMediaTime: -1 / 30,
      loop: false,
      onCurrentTimeChange: vi.fn(),
      onEnded: vi.fn(),
      onError: vi.fn(),
      onSourceWait: (waiting) => sourceWaits.push(waiting),
      presentSample: (presentedSample) => {
        presentedTimestamps.push(presentedSample.timestamp);
        presentedSample.close();
      },
      sampleSink: {
        getSample: mediaMock.getSample,
        async *samples() {
          await heldSample;
          yield createMockSample(0, 1 / 30) as unknown as DecodedVideoSample;
        },
      },
    });

    controller.play();
    flushAnimationFrame(1_000 / 30);

    await vi.waitFor(() => expect(sourceWaits).toEqual([true]));

    releaseSample?.();

    await vi.waitFor(() => expect(presentedTimestamps).toEqual([0]));
    expect(sourceWaits).toEqual([true, false]);

    controller.destroy();
  });
});

function mediaMockSampleSink() {
  return {
    getSample: mediaMock.getSample,
    samples(startTimestamp?: number, endTimestamp?: number, options?: unknown) {
      mediaMock.samplesCallStarts.push(startTimestamp);
      mediaMock.samplesCallEnds.push(endTimestamp);
      mediaMock.samplesCallOptions.push(options);

      return (async function* () {
        let index = mediaMock.samples.findIndex(
          (sample) =>
            startTimestamp === undefined || sample.timestamp >= startTimestamp,
        );

        if (index < 0) {
          index = mediaMock.samples.length;
        }

        try {
          while (index < mediaMock.samples.length) {
            mediaMock.sampleNextCalls.push(index);
            yield mediaMock.samples[index++]! as unknown as DecodedVideoSample;
          }
        } finally {
          await mediaMock.iteratorReturn();
        }
      })();
    },
  };
}
