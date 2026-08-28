import { describe, expect, it } from "vitest";

import {
  describeConversionFrameEffect,
  evaluateMediaConditions,
} from "#media/media-conditions";
import {
  ConversionFrameEffect,
  MediaConditionCode,
  MediaConditionResponse,
  MediaConditionScope,
  MediaIndexPlacement,
  type MediaConditionFacts,
  type MediaTimingFacts,
} from "#types/media-conditions";

const STEADY_TIMING: MediaTimingFacts = {
  distinctGapCount: 1,
  duplicateTimestampCount: 0,
  firstTimestampTicks: 0,
  maxGapTicks: 512,
  medianGapTicks: 512,
  minGapTicks: 512,
  sampleComplete: false,
  sampledPacketCount: 240,
  tickRate: 15360,
};

function facts(overrides: Partial<MediaConditionFacts> = {}) {
  return {
    canDecode: true,
    codec: "avc",
    container: { indexPlacement: MediaIndexPlacement.Front },
    remote: false,
    timing: STEADY_TIMING,
    trackCount: 1,
    videoTrackCount: 1,
    ...overrides,
  } satisfies MediaConditionFacts;
}

function codes(report: ReturnType<typeof evaluateMediaConditions>) {
  return report.conditions.map((condition) => condition.code);
}

describe("evaluateMediaConditions", () => {
  it("refuses a container the demuxer never opened", () => {
    const report = evaluateMediaConditions(
      facts({ canDecode: null, codec: null, container: null, timing: null }),
    );

    expect(codes(report)).toEqual([MediaConditionCode.ContainerUnreadable]);
    expect(report.playback).toBe(MediaConditionResponse.Refuse);
  });

  it("separates a container that listed no track from one whose tracks carry no video", () => {
    const unreadable = evaluateMediaConditions(
      facts({
        canDecode: null,
        codec: null,
        timing: null,
        trackCount: 0,
        videoTrackCount: 0,
      }),
    );
    const audioOnly = evaluateMediaConditions(
      facts({
        canDecode: null,
        codec: null,
        timing: null,
        trackCount: 1,
        videoTrackCount: 0,
      }),
    );

    expect(codes(unreadable)).toEqual([
      MediaConditionCode.VideoTrackUnreadable,
    ]);
    expect(codes(audioOnly)).toEqual([MediaConditionCode.NoVideoTrack]);
    expect(unreadable.playback).toBe(MediaConditionResponse.Refuse);
    expect(audioOnly.playback).toBe(MediaConditionResponse.Refuse);
  });

  it("refuses a video track whose codec the demuxer cannot name, without asking for a decoder", () => {
    const report = evaluateMediaConditions(
      facts({ canDecode: null, codec: null }),
    );

    expect(codes(report)).toContain(MediaConditionCode.CodecUnnamed);
    expect(report.playback).toBe(MediaConditionResponse.Refuse);
  });

  it("converts a named codec this browser cannot decode", () => {
    const report = evaluateMediaConditions(
      facts({ canDecode: false, codec: "prores" }),
    );

    expect(codes(report)).toEqual([MediaConditionCode.CodecUndecodable]);
    expect(report.playback).toBe(MediaConditionResponse.ConvertFirst);
    expect(report.conditions[0].frameEffect).toBe(
      ConversionFrameEffect.Resampled,
    );
  });

  it("converts progressively where the caller can open a prefix", () => {
    const report = evaluateMediaConditions(
      facts({ canDecode: false, codec: "prores" }),
      { progressiveConversion: true },
    );

    expect(report.playback).toBe(MediaConditionResponse.ConvertProgressively);
  });

  it("refuses frame indexing on frames sharing a presentation timestamp, and leaves playback alone", () => {
    const report = evaluateMediaConditions(
      facts({
        timing: {
          ...STEADY_TIMING,
          distinctGapCount: 2,
          duplicateTimestampCount: 59,
          maxGapTicks: 3000,
          medianGapTicks: 3000,
          minGapTicks: 0,
          tickRate: 90000,
        },
      }),
    );

    expect(codes(report)).toEqual([MediaConditionCode.UnstableFrameTiming]);
    expect(report.conditions[0].scope).toBe(MediaConditionScope.FrameIndexing);
    expect(report.frameIndexing).toBe(MediaConditionResponse.Refuse);
    expect(report.playback).toBe(MediaConditionResponse.None);
  });

  it("refuses frame indexing on gaps that take more values than a timebase rounds to", () => {
    const report = evaluateMediaConditions(
      facts({
        timing: {
          ...STEADY_TIMING,
          distinctGapCount: 3,
          maxGapTicks: 40,
          medianGapTicks: 33,
          minGapTicks: 20,
          tickRate: 1000,
        },
      }),
    );

    expect(codes(report)).toEqual([MediaConditionCode.UnstableFrameTiming]);
  });

  it("leaves a timebase that alternates two gaps alone", () => {
    const report = evaluateMediaConditions(
      facts({
        timing: {
          ...STEADY_TIMING,
          distinctGapCount: 2,
          maxGapTicks: 34,
          medianGapTicks: 33,
          minGapTicks: 33,
          tickRate: 1000,
        },
      }),
    );

    expect(codes(report)).toEqual([]);
    expect(report.frameIndexing).toBe(MediaConditionResponse.None);
  });

  it("remuxes a trailing index only when the bytes come over a link", () => {
    const remote = evaluateMediaConditions(
      facts({
        container: { indexPlacement: MediaIndexPlacement.End },
        remote: true,
      }),
    );
    const local = evaluateMediaConditions(
      facts({ container: { indexPlacement: MediaIndexPlacement.End } }),
    );

    expect(remote.playback).toBe(MediaConditionResponse.RemuxFirst);
    expect(remote.conditions[0].frameEffect).toBe(
      ConversionFrameEffect.Preserved,
    );
    expect(codes(local)).toEqual([MediaConditionCode.IndexAtEnd]);
    expect(local.playback).toBe(MediaConditionResponse.None);
  });

  it("reports a per-fragment index without asking for anything", () => {
    const report = evaluateMediaConditions(
      facts({
        container: { indexPlacement: MediaIndexPlacement.Fragmented },
        remote: true,
      }),
    );

    expect(codes(report)).toEqual([MediaConditionCode.IndexFragmented]);
    expect(report.playback).toBe(MediaConditionResponse.None);
  });

  it("reports a first frame presented after zero", () => {
    const report = evaluateMediaConditions(
      facts({ timing: { ...STEADY_TIMING, firstTimestampTicks: 132096 } }),
    );

    expect(codes(report)).toEqual([MediaConditionCode.NonZeroStart]);
    expect(report.conditions[0].detail).toContain("8.600 seconds");
    expect(report.frameIndexing).toBe(MediaConditionResponse.None);
  });

  it("holds no condition against an ordinary constant-rate file", () => {
    const report = evaluateMediaConditions(facts());

    expect(codes(report)).toEqual([]);
    expect(report.playback).toBe(MediaConditionResponse.None);
    expect(report.frameIndexing).toBe(MediaConditionResponse.None);
  });
});

describe("describeConversionFrameEffect", () => {
  it("reads an unstated rate as the 30 hertz the conversion will actually run at", () => {
    const report = describeConversionFrameEffect({ timing: STEADY_TIMING });

    expect(report.resolvedFrameRate).toBe(30);
    expect(report.effect).toBe(ConversionFrameEffect.Preserved);
  });

  it("resamples a 25 hertz source left at the default rate", () => {
    const report = describeConversionFrameEffect({
      timing: {
        ...STEADY_TIMING,
        maxGapTicks: 614,
        medianGapTicks: 614,
        minGapTicks: 614,
      },
    });

    expect(report.effect).toBe(ConversionFrameEffect.Resampled);
    expect(report.detail).toContain("25.016");
  });

  it("preserves frames when the stated rate is the rate the source runs at", () => {
    const report = describeConversionFrameEffect({
      timing: {
        ...STEADY_TIMING,
        maxGapTicks: 3003,
        medianGapTicks: 3003,
        minGapTicks: 3003,
        tickRate: 90000,
      },
      video: { frameRate: 29.97 },
    });

    expect(report.effect).toBe(ConversionFrameEffect.Preserved);
  });

  it("resamples whatever rate is asked for on a source with no steady grid", () => {
    const report = describeConversionFrameEffect({
      timing: { ...STEADY_TIMING, duplicateTimestampCount: 59 },
      video: { frameRate: 30 },
    });

    expect(report.effect).toBe(ConversionFrameEffect.Resampled);
  });

  it("names a one-frame source rather than dividing by a gap it does not have", () => {
    const report = describeConversionFrameEffect({
      timing: {
        ...STEADY_TIMING,
        distinctGapCount: 0,
        maxGapTicks: 0,
        medianGapTicks: 0,
        minGapTicks: 0,
        sampleComplete: true,
        sampledPacketCount: 1,
      },
    });

    expect(report.effect).toBe(ConversionFrameEffect.Resampled);
    expect(report.detail).toContain("one frame");
  });

  it("assumes the frames do not survive when nothing measured the source", () => {
    const report = describeConversionFrameEffect({ video: { frameRate: 30 } });

    expect(report.effect).toBe(ConversionFrameEffect.Resampled);
  });
});
