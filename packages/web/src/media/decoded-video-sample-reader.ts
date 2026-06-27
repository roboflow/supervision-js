import type {
  DecodedVideoSample,
  DecodedVideoSampleSink,
} from "./media-source";

export type DecodedVideoSampleIterator = AsyncGenerator<
  DecodedVideoSample,
  void,
  unknown
>;

export async function readFirstDecodedVideoSample(options: {
  readonly sampleSink: DecodedVideoSampleSink;
  readonly startTimestamp: number;
  readonly setActiveIterator?: (
    iterator: DecodedVideoSampleIterator | undefined,
  ) => void;
}): Promise<DecodedVideoSample> {
  const iterator = options.sampleSink.samples(
    options.startTimestamp,
    undefined,
    {
      skipLiveWait: true,
    },
  );
  options.setActiveIterator?.(iterator);

  try {
    const firstSampleResult = await iterator.next();

    if (firstSampleResult.done) {
      throw new Error("No decoded video samples were produced.");
    }

    return firstSampleResult.value;
  } finally {
    try {
      await iterator.return?.();
    } finally {
      options.setActiveIterator?.(undefined);
    }
  }
}
