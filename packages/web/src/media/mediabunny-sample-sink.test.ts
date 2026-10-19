import { VideoSample, type VideoSampleSink } from "mediabunny";
import { describe, expect, it, vi } from "vitest";
import { createMediabunnySampleSink } from "./mediabunny-sample-sink";

function sample(timestamp: number, duration = 1 / 30) {
  const frame = new VideoSample(new Uint8Array([255, 0, 0, 255]), {
    format: "RGBA",
    codedWidth: 1,
    codedHeight: 1,
    timestamp,
    duration,
  });
  vi.spyOn(frame, "close");
  vi.spyOn(frame, "clone");
  return frame;
}

describe("Mediabunny random-access recovery", () => {
  it.each([2, 2.5])(
    "keeps the recovered final frame readable after iterator cleanup at %s",
    async (timestamp) => {
      const frame = new VideoSample(new Uint8Array([255, 0, 0, 255]), {
        format: "RGBA",
        codedWidth: 1,
        codedHeight: 1,
        timestamp: 2,
        duration: 1,
      });
      const sink = {
        getSample: vi.fn(async () => null),
        samples: vi.fn(async function* () {
          try {
            yield frame;
          } finally {
            frame.close();
          }
        }),
      } satisfies Pick<VideoSampleSink, "getSample" | "samples">;
      const recovered =
        await createMediabunnySampleSink(sink).getSample(timestamp);
      try {
        expect(recovered).not.toBeNull();
        const pixels = new Uint8Array(4);
        await (recovered as VideoSample).copyTo(pixels);
        expect([...pixels]).toEqual([255, 0, 0, 255]);
        expect(recovered?.timestamp).toBe(2);
        expect(recovered?.duration).toBe(1);
      } finally {
        recovered?.close();
      }
    },
  );

  it("keeps successful random access on its fast path", async () => {
    const frame = sample(4.566666666666666);
    const sink = {
      getSample: vi.fn(async () => frame),
      samples: vi.fn(async function* () {}),
    } satisfies Pick<VideoSampleSink, "getSample" | "samples">;
    const options = { skipLiveWait: true };
    expect(
      await createMediabunnySampleSink(sink).getSample(4.57, options),
    ).toBe(frame);
    expect(sink.getSample).toHaveBeenCalledWith(4.57, options);
    expect(sink.samples).not.toHaveBeenCalled();
    expect(frame.clone).not.toHaveBeenCalled();
    frame.close();
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
      } satisfies Pick<VideoSampleSink, "getSample" | "samples">;
      const options = { skipLiveWait: true };
      const recovered = await createMediabunnySampleSink(sink).getSample(
        timestamp,
        options,
      );
      expect(recovered).toBeInstanceOf(VideoSample);
      expect(recovered).not.toBe(frame);
      expect(recovered?.timestamp).toBe(frame.timestamp);
      expect(sink.samples).toHaveBeenCalledWith(timestamp, undefined, options);
      expect(release).toHaveBeenCalledOnce();
      expect(frame.clone).toHaveBeenCalledOnce();
      expect(frame.close).toHaveBeenCalledOnce();
      recovered?.close();
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
    } satisfies Pick<VideoSampleSink, "getSample" | "samples">;
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
    } satisfies Pick<VideoSampleSink, "getSample" | "samples">;
    await expect(createMediabunnySampleSink(sink).getSample(1)).rejects.toBe(
      error,
    );
    expect(sink.samples).not.toHaveBeenCalled();
  });

  it("releases the candidate and iterator when cloning fails", async () => {
    const frame = sample(2, 1);
    const error = new Error("Cannot clone sample");
    vi.mocked(frame.clone).mockImplementation(() => {
      throw error;
    });
    const release = vi.fn();
    const sink = {
      getSample: vi.fn(async () => null),
      samples: vi.fn(async function* () {
        try {
          yield frame;
        } finally {
          release();
        }
      }),
    } satisfies Pick<VideoSampleSink, "getSample" | "samples">;
    await expect(createMediabunnySampleSink(sink).getSample(2.5)).rejects.toBe(
      error,
    );
    expect(frame.close).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("releases the recovered clone if iterator cleanup rejects", async () => {
    const frame = sample(2, 1);
    const error = new Error("Iterator cleanup failed");
    const release = vi.fn().mockRejectedValue(error);
    const sink = {
      getSample: vi.fn(async () => null),
      samples: vi.fn(async function* () {
        try {
          yield frame;
        } finally {
          await release();
        }
      }),
    } satisfies Pick<VideoSampleSink, "getSample" | "samples">;
    await expect(createMediabunnySampleSink(sink).getSample(2.5)).rejects.toBe(
      error,
    );
    expect(frame.clone).toHaveBeenCalledOnce();
    expect(frame.close).toHaveBeenCalledOnce();
    const recovered = vi.mocked(frame.clone).mock.results[0]
      ?.value as VideoSample;
    expect(() => recovered.clone()).toThrow("VideoSample is closed.");
  });

  it("forwards sequential playback without wrapping its iterator", () => {
    const iterator = (async function* () {})();
    const sink = {
      getSample: vi.fn(async () => null),
      samples: vi.fn(() => iterator),
    };
    const options = { skipLiveWait: true };
    expect(createMediabunnySampleSink(sink).samples(1, 2, options)).toBe(
      iterator,
    );
    expect(sink.samples).toHaveBeenCalledWith(1, 2, options);
  });
});
