import { describe, expect, it, vi } from "vitest";
import type { DecodedVideoSampleSink } from "./media-source";
import { createMediabunnySampleSink } from "./mediabunny-sample-sink";

function sample(timestamp: number, duration = 1 / 30) {
  return { timestamp, duration, close: vi.fn(), draw: vi.fn() };
}

describe("Mediabunny random-access recovery", () => {
  it("keeps successful random access on its fast path", async () => {
    const frame = sample(4.566666666666666);
    const sink = {
      getSample: vi.fn(async () => frame),
      samples: vi.fn(async function* () {}),
    } satisfies DecodedVideoSampleSink;
    const options = { skipLiveWait: true };
    expect(
      await createMediabunnySampleSink(sink).getSample(4.57, options),
    ).toBe(frame);
    expect(sink.getSample).toHaveBeenCalledWith(4.57, options);
    expect(sink.samples).not.toHaveBeenCalled();
  });

  it.each([2.466666666666667, 2.471666666666667])(
    "recovers the containing reordered frame at %s and closes its iterator",
    async (timestamp) => {
      const frame = sample(2.466666666666667);
      const release = vi.fn();
      const sink = {
        getSample: vi.fn(async () => null),
        samples: vi.fn(async function* () {
          try {
            yield frame;
            throw new Error(
              "Must stop reading once the requested frame is found.",
            );
          } finally {
            release();
          }
        }),
      } satisfies DecodedVideoSampleSink;
      const options = { skipLiveWait: true };
      expect(
        await createMediabunnySampleSink(sink).getSample(timestamp, options),
      ).toBe(frame);
      expect(sink.samples).toHaveBeenCalledWith(timestamp, undefined, options);
      expect(release).toHaveBeenCalledOnce();
      expect(frame.close).not.toHaveBeenCalled();
    },
  );

  it("does not replace a missing frame with a later frame and releases rejected samples", async () => {
    const earlier = sample(1, 0.1);
    const later = sample(2, 0.1);
    const release = vi.fn();
    const sink = {
      getSample: vi.fn(async () => null),
      samples: vi.fn(async function* () {
        try {
          yield earlier;
          yield later;
        } finally {
          release();
        }
      }),
    } satisfies DecodedVideoSampleSink;
    expect(await createMediabunnySampleSink(sink).getSample(1.5)).toBeNull();
    expect(earlier.close).toHaveBeenCalledOnce();
    expect(later.close).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("preserves decode failures instead of retrying indefinitely", async () => {
    const error = new Error("Input disposed");
    const sink = {
      getSample: vi.fn(async () => {
        throw error;
      }),
      samples: vi.fn(async function* () {}),
    } satisfies DecodedVideoSampleSink;
    await expect(createMediabunnySampleSink(sink).getSample(1)).rejects.toBe(
      error,
    );
    expect(sink.samples).not.toHaveBeenCalled();
  });
});
