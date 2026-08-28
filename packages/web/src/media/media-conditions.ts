import {
  ConversionFrameEffect,
  MediaConditionCode,
  MediaConditionResponse,
  MediaConditionScope,
  MediaIndexPlacement,
  type ConversionFrameEffectReport,
  type MediaCondition,
  type MediaConditionFacts,
  type MediaConditionPolicy,
  type MediaConditionReport,
  type MediaTimingFacts,
} from "#types/media-conditions";
import {
  DEFAULT_NORMALIZATION_FRAME_RATE,
  type MediaNormalizationVideoOptions,
} from "#types/media-normalization";

/**
 * How many different neighbour gaps a steady source is allowed. One is a source
 * whose rate its timebase states exactly. Two is one whose timebase cannot:
 * 30 fps on a millisecond grain alternates 33 and 34 ticks forever, and 10007
 * ticks a second alternates 333 and 334. Measured across the 89-clip media
 * matrix, every clip that steps correctly sits at one or two and every clip
 * that steps wrong sits at three or more.
 */
const MAX_STABLE_DISTINCT_GAPS = 2;

const RESPONSE_STRENGTH: Record<MediaConditionResponse, number> = {
  [MediaConditionResponse.None]: 0,
  [MediaConditionResponse.RemuxFirst]: 1,
  [MediaConditionResponse.ConvertProgressively]: 2,
  [MediaConditionResponse.ConvertFirst]: 3,
  [MediaConditionResponse.Refuse]: 4,
};

/**
 * Which conditions a source's measured facts hold, and what to do about each.
 *
 * Pure: everything it reasons over was measured once by the probe. The two
 * verdicts are separate because the conditions are: a source whose frames do
 * not arrive on a steady grid plays perfectly and cannot be addressed by frame
 * index, and answering that with one verdict would either refuse a clip that
 * plays or hand out indices that name the wrong picture.
 */
export function evaluateMediaConditions(
  facts: MediaConditionFacts,
  policy: MediaConditionPolicy = {},
): MediaConditionReport {
  const conditions: MediaCondition[] = [];

  if (!facts.container) {
    conditions.push({
      code: MediaConditionCode.ContainerUnreadable,
      detail: "The demuxer does not read this file's container.",
      frameEffect: null,
      response: MediaConditionResponse.Refuse,
      scope: MediaConditionScope.Playback,
    });

    return createReport(facts, conditions);
  }

  if (facts.videoTrackCount === 0) {
    conditions.push(
      facts.trackCount === 0
        ? {
            code: MediaConditionCode.VideoTrackUnreadable,
            detail:
              "The container opened and the demuxer parsed no track out of it, so whatever video it holds is in a form this build cannot reach.",
            frameEffect: null,
            response: MediaConditionResponse.Refuse,
            scope: MediaConditionScope.Playback,
          }
        : {
            code: MediaConditionCode.NoVideoTrack,
            detail: `The container's ${facts.trackCount} track(s) read and none of them carries video this build can reach.`,
            frameEffect: null,
            response: MediaConditionResponse.Refuse,
            scope: MediaConditionScope.Playback,
          },
    );

    return createReport(facts, conditions);
  }

  if (facts.codec === null) {
    conditions.push({
      code: MediaConditionCode.CodecUnnamed,
      detail:
        "The video track opened and the demuxer cannot name its codec, so no decoder can be configured for it whatever this browser supports.",
      frameEffect: null,
      response: MediaConditionResponse.Refuse,
      scope: MediaConditionScope.Playback,
    });
  } else if (facts.canDecode === false) {
    const progressive = policy.progressiveConversion === true;

    conditions.push({
      code: MediaConditionCode.CodecUndecodable,
      detail: `This browser has no decoder for ${facts.codec}, so the frames have to be re-encoded into one it does.`,
      frameEffect: ConversionFrameEffect.Resampled,
      response: progressive
        ? MediaConditionResponse.ConvertProgressively
        : MediaConditionResponse.ConvertFirst,
      scope: MediaConditionScope.Playback,
    });
  }

  if (facts.container.indexPlacement === MediaIndexPlacement.End) {
    conditions.push({
      code: MediaConditionCode.IndexAtEnd,
      detail: facts.remote
        ? "The frame index sits after the media data, so opening this over a link fetches the end of the file before the first frame."
        : "The frame index sits after the media data, which costs nothing to read from bytes already on this machine.",
      frameEffect: ConversionFrameEffect.Preserved,
      response: facts.remote
        ? MediaConditionResponse.RemuxFirst
        : MediaConditionResponse.None,
      scope: MediaConditionScope.Playback,
    });
  }

  if (facts.container.indexPlacement === MediaIndexPlacement.Fragmented) {
    conditions.push({
      code: MediaConditionCode.IndexFragmented,
      detail:
        "The file carries one index per fragment rather than one for the whole, so a seek resolves against the fragment it lands in.",
      frameEffect: ConversionFrameEffect.Preserved,
      response: MediaConditionResponse.None,
      scope: MediaConditionScope.Playback,
    });
  }

  if (facts.timing) {
    conditions.push(...timingConditions(facts.timing));
  }

  return createReport(facts, conditions);
}

/**
 * What a conversion would do to the frame sequence, judged against the options
 * as {@link normalizeMedia} will actually run them rather than as they were
 * written: leaving the rate unstated does not keep the source's timing here,
 * it takes the 30 hertz default.
 *
 * A stated rate is only safe on a source that already runs at exactly that
 * rate. On anything else the conversion writes a different number of pictures
 * at different times, and a detection carrying a source frame index then names
 * a picture that was never at that position.
 */
export function describeConversionFrameEffect(options: {
  readonly video?: MediaNormalizationVideoOptions;
  readonly timing?: MediaTimingFacts | null;
}): ConversionFrameEffectReport {
  const resolvedFrameRate =
    options.video?.frameRate ?? DEFAULT_NORMALIZATION_FRAME_RATE;
  const timing = options.timing ?? null;

  if (!timing) {
    return {
      detail: `The conversion writes ${resolvedFrameRate} frames a second and nothing measured what the source runs at, so whether the frames survive is unknown and has to be assumed not to.`,
      effect: ConversionFrameEffect.Resampled,
      resolvedFrameRate,
    };
  }

  if (distinctGapsExceedTimebaseRounding(timing)) {
    return {
      detail: `The source's frames do not arrive on a steady grid, so writing them out at ${resolvedFrameRate} a second drops and repeats pictures to fill it.`,
      effect: ConversionFrameEffect.Resampled,
      resolvedFrameRate,
    };
  }

  if (timing.medianGapTicks === 0) {
    return {
      detail: `The source holds one frame, and a conversion at ${resolvedFrameRate} frames a second writes as many of it as the output's duration asks for.`,
      effect: ConversionFrameEffect.Resampled,
      resolvedFrameRate,
    };
  }

  const sourceFrameRate = timing.tickRate / timing.medianGapTicks;

  if (!ratesMatch(sourceFrameRate, resolvedFrameRate)) {
    return {
      detail: `The source runs at ${sourceFrameRate.toFixed(3)} frames a second and the conversion writes ${resolvedFrameRate}, so the output carries a different picture at every position.`,
      effect: ConversionFrameEffect.Resampled,
      resolvedFrameRate,
    };
  }

  return {
    detail: `The conversion writes the rate the source already runs at, so each source frame comes out once and a source frame index still names the picture it named.`,
    effect: ConversionFrameEffect.Preserved,
    resolvedFrameRate,
  };
}

function timingConditions(timing: MediaTimingFacts): MediaCondition[] {
  const conditions: MediaCondition[] = [];

  if (distinctGapsExceedTimebaseRounding(timing)) {
    conditions.push({
      code: MediaConditionCode.UnstableFrameTiming,
      detail: unstableTimingDetail(timing),
      frameEffect: null,
      response: MediaConditionResponse.Refuse,
      scope: MediaConditionScope.FrameIndexing,
    });
  }

  if (timing.firstTimestampTicks !== 0) {
    conditions.push({
      code: MediaConditionCode.NonZeroStart,
      detail: `The first frame is presented at ${(timing.firstTimestampTicks / timing.tickRate).toFixed(3)} seconds, so media time and elapsed time differ by that much on this source.`,
      frameEffect: ConversionFrameEffect.Preserved,
      response: MediaConditionResponse.None,
      scope: MediaConditionScope.FrameIndexing,
    });
  }

  return conditions;
}

function unstableTimingDetail(timing: MediaTimingFacts) {
  const scope = timing.sampleComplete
    ? `across all ${timing.sampledPacketCount} frames`
    : `across the first ${timing.sampledPacketCount} frames`;

  return timing.duplicateTimestampCount > 0
    ? `${timing.duplicateTimestampCount} pair(s) of frames share one presentation timestamp ${scope}, so no arithmetic can tell those pictures apart by time.`
    : `Neighbouring frames are separated by ${timing.distinctGapCount} different gaps ${scope}, from ${timing.minGapTicks} to ${timing.maxGapTicks} ticks of ${timing.tickRate}, which is more than a timebase's own rounding produces.`;
}

/**
 * Whether the gaps between frames take more values than a timebase that cannot
 * state the rate exactly would produce on its own. Duplicate timestamps are
 * counted here too: they are a zero gap, and a zero gap is never rounding.
 */
function distinctGapsExceedTimebaseRounding(timing: MediaTimingFacts) {
  return (
    timing.duplicateTimestampCount > 0 ||
    timing.distinctGapCount > MAX_STABLE_DISTINCT_GAPS
  );
}

/**
 * A rate derived from a median gap of whole ticks lands within a tick of the
 * rate it stands for, so `30000/1001` read off a 90000-tick grain is 29.97003
 * and the 29.97 a caller writes has to match it.
 */
function ratesMatch(sourceFrameRate: number, requestedFrameRate: number) {
  return Math.abs(sourceFrameRate - requestedFrameRate) < 0.01;
}

function createReport(
  facts: MediaConditionFacts,
  conditions: readonly MediaCondition[],
): MediaConditionReport {
  return {
    conditions,
    facts,
    frameIndexing: strongestResponse(
      conditions,
      MediaConditionScope.FrameIndexing,
    ),
    playback: strongestResponse(conditions, MediaConditionScope.Playback),
  };
}

function strongestResponse(
  conditions: readonly MediaCondition[],
  scope: MediaConditionScope,
) {
  let strongest = MediaConditionResponse.None;

  for (const condition of conditions) {
    if (
      condition.scope === scope &&
      RESPONSE_STRENGTH[condition.response] > RESPONSE_STRENGTH[strongest]
    ) {
      strongest = condition.response;
    }
  }

  return strongest;
}
