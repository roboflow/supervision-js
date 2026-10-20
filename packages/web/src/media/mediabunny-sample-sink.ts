import type { VideoSample, VideoSampleSink } from "mediabunny";
import type { DecodedVideoSampleSink } from "./media-source";

/** Keep decoder-specific random-access recovery inside the media adapter. */
export function createMediabunnySampleSink(
  sink: Pick<VideoSampleSink, "getSample" | "samples">,
): DecodedVideoSampleSink {
  return {
    async getSample(timestamp, options) {
      const sample = await sink.getSample(timestamp, options);
      if (sample) return sample;

      // Some reordered H.264 frames need packets beyond the random-access
      // decoder's stopping point. The iterator supplies that decode lookahead.
      let recovered: VideoSample | null = null;
      try {
        for await (const candidate of sink.samples(
          timestamp,
          undefined,
          options,
        )) {
          try {
            if (
              candidate.timestamp <= timestamp &&
              candidate.timestamp + candidate.duration > timestamp
            ) {
              // Iterator cleanup can close its last sample; return an owned handle.
              recovered = candidate.clone();
              break;
            }
            if (candidate.timestamp > timestamp) break;
          } finally {
            candidate.close();
          }
        }
        return recovered;
      } catch (error) {
        recovered?.close();
        throw error;
      }
    },
    samples(startTimestamp, endTimestamp, options) {
      return sink.samples(startTimestamp, endTimestamp, options);
    },
  };
}
