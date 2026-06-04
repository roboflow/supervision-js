import { describe, expect, it, vi } from "vitest";

import type { DecodedVideoSample } from "#media/media-source";

import {
  createMockSample,
  domMock,
  flushAnimationFrame,
  mediaMock,
  resetMocks,
} from "../../test/media-renderer-harness";
import { createMediaPlaybackController } from "./media-playback-controller";

describe("media playback controller", () => {
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
