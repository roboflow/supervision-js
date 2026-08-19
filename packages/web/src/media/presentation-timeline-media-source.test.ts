import { describe, expect, it, vi } from "vitest";

import type {
  DecodedMediaSource,
  DecodedVideoSample,
} from "#media/media-source";
import { normalizeMediaSourcePresentationTimeline } from "#media/presentation-timeline-media-source";

describe("presentation timeline media source", () => {
  it("passes through media that already starts at or after zero", () => {
    const source = createSource({ firstTimestamp: 0, samples: [] });

    expect(normalizeMediaSourcePresentationTimeline(source)).toBe(source);
  });

  it("reports zero as the first playable timestamp for pre-roll media", () => {
    const normalized = normalizeMediaSourcePresentationTimeline(
      createSource({ firstTimestamp: -0.08, samples: [] }),
    );

    expect(normalized.metadata.firstTimestamp).toBe(0);
    expect(normalized.metadata.duration).toBe(9);
  });

  it("drops pre-roll samples and presents the sample straddling zero at zero", async () => {
    // A decoder must start from a keyframe, so a request for presentation time
    // zero still hands back the pre-roll samples ahead of it.
    const samples = [
      createSample(-0.08, 0.04),
      createSample(-0.04, 0.04),
      createSample(-0.02, 0.04),
      createSample(0.02, 0.04),
    ];
    const normalized = normalizeMediaSourcePresentationTimeline(
      createSource({ firstTimestamp: -0.08, samples }),
    );

    const presented: Array<{ duration: number; timestamp: number }> = [];

    for await (const sample of normalized.sampleSink.samples(-0.08)) {
      presented.push({
        duration: sample.duration,
        timestamp: sample.timestamp,
      });
    }

    expect(presented).toEqual([
      { duration: 0.02, timestamp: 0 },
      { duration: 0.04, timestamp: 0.02 },
    ]);
    // Pre-roll frames are released rather than leaked to the renderer.
    expect(samples[0]?.close).toHaveBeenCalledTimes(1);
    expect(samples[1]?.close).toHaveBeenCalledTimes(1);
    expect(samples[2]?.close).not.toHaveBeenCalled();
  });

  it("clamps a negative seek onto the presentation timeline", async () => {
    const source = createSource({
      firstTimestamp: -0.02,
      samples: [createSample(-0.02, 0.04), createSample(0.02, 0.04)],
    });
    const normalized = normalizeMediaSourcePresentationTimeline(source);

    const sample = await normalized.sampleSink.getSample(-1);

    expect(source.sampleSink.getSample).toHaveBeenCalledWith(0, undefined);
    expect(sample).toMatchObject({ duration: 0.02, timestamp: 0 });
  });

  it("keeps seeking within the presentation timeline unchanged", async () => {
    const normalized = normalizeMediaSourcePresentationTimeline(
      createSource({
        firstTimestamp: -0.02,
        samples: [createSample(-0.02, 0.04), createSample(1, 0.04)],
      }),
    );

    await expect(normalized.sampleSink.getSample(1)).resolves.toMatchObject({
      duration: 0.04,
      timestamp: 1,
    });
  });
});

type MockSample = DecodedVideoSample & {
  readonly close: ReturnType<typeof vi.fn<() => void>>;
};

function createSample(timestamp: number, duration: number): MockSample {
  return {
    close: vi.fn<() => void>(),
    draw: vi.fn<DecodedVideoSample["draw"]>(),
    duration,
    timestamp,
  };
}

function createSource(options: {
  readonly firstTimestamp: number;
  readonly samples: readonly MockSample[];
}): DecodedMediaSource {
  return {
    input: { dispose: vi.fn() },
    metadata: {
      audioTrackCount: 0,
      canRead: true,
      duration: 9,
      firstTimestamp: options.firstTimestamp,
      formatMimeType: "video/mp4",
      formatName: "MP4",
      mimeType: "video/mp4",
      primaryVideoHeight: 720,
      primaryVideoWidth: 1280,
      trackCount: 1,
      videoTrackCount: 1,
    },
    sampleSink: {
      getSample: vi.fn(
        async (timestamp: number): Promise<DecodedVideoSample | null> =>
          [...options.samples]
            .reverse()
            .find((sample) => sample.timestamp <= timestamp) ?? null,
      ),
      // Mirrors a real decoder: reaching a requested timestamp means decoding
      // from the preceding keyframe, so earlier samples are handed back too.
      async *samples() {
        for (const sample of options.samples) {
          yield sample;
        }
      },
    },
  };
}
