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

      if (sample.timestamp >= 0) {
        return sample;
      }

      if (isVisibleSample(sample)) {
        return clampSampleToZero(sample);
      }

      // Random access can land on pre-roll that ends at or before zero. That
      // sample is never presented, so fall forward to the first visible one
      // instead of showing a zero-duration frame at time zero.
      sample.close();

      return getFirstVisibleSample(sink, options);
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

        if (isVisibleSample(sample)) {
          yield clampSampleToZero(sample);
          continue;
        }

        sample.close();
      }
    },
  };
}

/**
 * Pre-roll that ends at or before presentation time zero is decodable but not
 * presentable, so it is never a valid answer for a seek.
 */
function isVisibleSample(sample: DecodedVideoSample) {
  return sample.timestamp + sample.duration > 0;
}

async function getFirstVisibleSample(
  sink: DecodedVideoSampleSink,
  options: Parameters<DecodedVideoSampleSink["getSample"]>[1],
) {
  for await (const sample of sink.samples(0, undefined, options)) {
    if (sample.timestamp >= 0) {
      return sample;
    }

    if (isVisibleSample(sample)) {
      return clampSampleToZero(sample);
    }

    sample.close();
  }

  return null;
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
