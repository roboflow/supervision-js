import type {
  DecodedMediaSource,
  DecodedVideoSample,
  DecodedVideoSampleSink,
} from "#media/media-source";

/**
 * Normalizes a decoded media source onto a zero-based presentation timeline.
 *
 * Media trimmed through an edit list — B-frame pre-roll is the common case —
 * carries a few decodable samples ahead of presentation time zero, and the
 * container reports a negative first timestamp for them. Those samples are not
 * meant to be presented, but a renderer that starts its clock at the reported
 * first timestamp would show negative session time and would look for
 * detections outside `[0, duration]`, where no producer writes them.
 *
 * This reports the presentation start as the first timestamp, drops samples
 * that end before zero, and presents the sample straddling zero at zero.
 * Sources that already start at or after zero are returned unchanged.
 */
export function normalizeMediaSourcePresentationTimeline(
  source: DecodedMediaSource,
): DecodedMediaSource {
  if (source.metadata.firstTimestamp >= 0) {
    return source;
  }

  return {
    ...source,
    metadata: { ...source.metadata, firstTimestamp: 0 },
    sampleSink: createPresentationTimelineSampleSink(source.sampleSink),
  };
}

function createPresentationTimelineSampleSink(
  sink: DecodedVideoSampleSink,
): DecodedVideoSampleSink {
  return {
    async getSample(timestamp, options) {
      const sample = await sink.getSample(Math.max(0, timestamp), options);

      if (!sample) {
        return null;
      }

      return sample.timestamp >= 0 ? sample : clampSampleToZero(sample);
    },

    async *samples(startTimestamp, endTimestamp, options) {
      for await (const sample of sink.samples(
        Math.max(0, startTimestamp ?? 0),
        endTimestamp,
        options,
      )) {
        if (sample.timestamp >= 0) {
          yield sample;
          continue;
        }

        if (sample.timestamp + sample.duration > 0) {
          yield clampSampleToZero(sample);
          continue;
        }

        sample.close();
      }
    },
  };
}

function clampSampleToZero(sample: DecodedVideoSample): DecodedVideoSample {
  return {
    close: () => sample.close(),
    draw: (context, dx, dy, dWidth, dHeight) =>
      sample.draw(context, dx, dy, dWidth, dHeight),
    duration: Math.max(0, sample.duration + sample.timestamp),
    timestamp: 0,
  };
}
