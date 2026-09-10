import type { DecodedVideoSampleSink } from "./media-source";

/** Keep decoder-specific random-access recovery inside the media adapter. */
export function createMediabunnySampleSink(
  sink: DecodedVideoSampleSink,
): DecodedVideoSampleSink {
  return {
    async getSample(timestamp, options) {
      const sample = await sink.getSample(timestamp, options);
      if (sample) return sample;

      // Some reordered H.264 frames need packets beyond the random-access
      // decoder's stopping point. The iterator supplies that decode lookahead.
      for await (const candidate of sink.samples(
        timestamp,
        undefined,
        options,
      )) {
        if (
          candidate.timestamp <= timestamp &&
          candidate.timestamp + candidate.duration > timestamp
        ) {
          return candidate;
        }
        candidate.close();
        if (candidate.timestamp > timestamp) return null;
      }
      return null;
    },
    samples(startTimestamp, endTimestamp, options) {
      return sink.samples(startTimestamp, endTimestamp, options);
    },
  };
}
