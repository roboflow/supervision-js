import { ALREADY_PRESENTED_SAMPLE_EPSILON_SECONDS } from "#constants/media-renderer";
import type {
  DecodedVideoSample,
  DecodedVideoSampleSink,
} from "#media/media-source";

type DecodedVideoSampleIterator = AsyncGenerator<
  DecodedVideoSample,
  void,
  unknown
>;

const PLAYBACK_SAMPLE_QUEUE_CAPACITY = 6;

export interface MediaPlaybackController {
  play(): void;
  pause(): void;
  seek(mediaTime: number): void;
  destroy(): void;
}

export function createMediaPlaybackController(options: {
  readonly sampleSink: DecodedVideoSampleSink;
  readonly firstTimestamp: number;
  readonly duration: number | null;
  readonly loop: boolean;
  readonly initialMediaTime: number;
  readonly presentSample: (sample: DecodedVideoSample) => void;
  readonly waitForSample?: (sample: DecodedVideoSample) => Promise<void>;
  readonly onCurrentTimeChange: (currentTime: number) => void;
  readonly onEnded: () => void;
  readonly onError: (error: unknown) => void;
  readonly onWaiting?: () => void;
  readonly onResume?: () => void;
}): MediaPlaybackController {
  let destroyed = false;
  let playing = false;
  let playbackRunId = 0;
  let playbackOriginMediaTime = options.initialMediaTime;
  let playbackOriginNow = 0;
  let currentTime = options.initialMediaTime;
  let animationFrameHandle: number | undefined;
  let sampleQueue: DecodedVideoSample[] = [];
  let activeSampleIterator: DecodedVideoSampleIterator | undefined;
  let activeSampleIteratorId = 0;
  let activePrefetch:
    | { readonly iteratorId: number; readonly promise: Promise<void> }
    | undefined;
  let activeSampleIteratorExhausted = false;

  const cancelScheduledFrame = () => {
    if (animationFrameHandle !== undefined) {
      window.cancelAnimationFrame(animationFrameHandle);
      animationFrameHandle = undefined;
    }
  };

  const isPlaybackRunActive = (runId: number) =>
    !destroyed && playing && playbackRunId === runId;

  const schedulePlaybackFrame = (runId: number) => {
    if (!isPlaybackRunActive(runId) || animationFrameHandle !== undefined) {
      return;
    }

    animationFrameHandle = window.requestAnimationFrame((now) => {
      animationFrameHandle = undefined;
      void decodePlaybackFrame(runId, now);
    });
  };

  const setCurrentTime = (nextCurrentTime: number) => {
    currentTime = nextCurrentTime;
    options.onCurrentTimeChange(nextCurrentTime);
  };

  const closeQueuedSamples = () => {
    for (const sample of sampleQueue) {
      sample.close();
    }

    sampleQueue = [];
  };

  const returnSampleIterator = (
    iterator: DecodedVideoSampleIterator | undefined,
  ) => {
    try {
      const returnPromise = iterator?.return?.();

      void returnPromise?.catch(() => undefined);
    } catch {
      // Iterator cleanup is best-effort; playback state is already moving on.
    }
  };

  const stopActiveSampleIterator = () => {
    const iterator = activeSampleIterator;

    activeSampleIterator = undefined;
    activeSampleIteratorExhausted = true;
    activeSampleIteratorId += 1;
    returnSampleIterator(iterator);
  };

  const resetSampleIterator = (startTimestamp: number) => {
    closeQueuedSamples();
    stopActiveSampleIterator();
    activeSampleIterator = options.sampleSink.samples(
      startTimestamp,
      undefined,
      {
        skipLiveWait: true,
      },
    );
    activeSampleIteratorExhausted = false;
    activeSampleIteratorId += 1;
  };

  const stopPlaybackWithError = (runId: number, error: unknown) => {
    if (destroyed || playbackRunId !== runId) {
      return;
    }

    playing = false;
    playbackRunId += 1;
    cancelScheduledFrame();
    closeQueuedSamples();
    stopActiveSampleIterator();
    options.onError(error);
  };

  const fillSampleQueue = async (
    runId: number,
    iteratorId: number,
    iterator: DecodedVideoSampleIterator,
  ) => {
    try {
      while (
        isPlaybackRunActive(runId) &&
        activeSampleIterator === iterator &&
        activeSampleIteratorId === iteratorId &&
        !activeSampleIteratorExhausted &&
        sampleQueue.length < PLAYBACK_SAMPLE_QUEUE_CAPACITY
      ) {
        const result = await iterator.next();

        if (
          !isPlaybackRunActive(runId) ||
          activeSampleIterator !== iterator ||
          activeSampleIteratorId !== iteratorId
        ) {
          if (!result.done) {
            result.value.close();
          }

          return;
        }

        if (result.done) {
          activeSampleIteratorExhausted = true;
          return;
        }

        sampleQueue.push(result.value);
      }
    } catch (error) {
      if (
        !destroyed &&
        playbackRunId === runId &&
        activeSampleIterator === iterator &&
        activeSampleIteratorId === iteratorId
      ) {
        stopPlaybackWithError(runId, error);
      }
    } finally {
      if (activePrefetch?.iteratorId === iteratorId) {
        activePrefetch = undefined;
      }
    }
  };

  const startSamplePrefetch = (runId: number) => {
    const iterator = activeSampleIterator;

    if (
      !isPlaybackRunActive(runId) ||
      !iterator ||
      activeSampleIteratorExhausted ||
      sampleQueue.length >= PLAYBACK_SAMPLE_QUEUE_CAPACITY
    ) {
      return undefined;
    }

    const iteratorId = activeSampleIteratorId;

    if (activePrefetch?.iteratorId === iteratorId) {
      return activePrefetch.promise;
    }

    const promise = fillSampleQueue(runId, iteratorId, iterator);
    activePrefetch = { iteratorId, promise };

    return promise;
  };

  const waitForFirstQueuedSample = async (runId: number) => {
    if (sampleQueue.length > 0 || activeSampleIteratorExhausted) {
      return;
    }

    await startSamplePrefetch(runId);
  };

  const shouldPresentSample = (
    sample: DecodedVideoSample,
    shouldPresentLoopStartSample: boolean,
  ) =>
    sample.timestamp > currentTime + ALREADY_PRESENTED_SAMPLE_EPSILON_SECONDS ||
    (shouldPresentLoopStartSample &&
      Math.abs(sample.timestamp - options.firstTimestamp) <=
        ALREADY_PRESENTED_SAMPLE_EPSILON_SECONDS);

  const takeDueSample = (
    requestedMediaTime: number,
    shouldPresentLoopStartSample: boolean,
  ) => {
    let sampleToPresent: DecodedVideoSample | undefined;

    while (sampleQueue.length > 0) {
      const nextSample = sampleQueue[0];

      if (
        !nextSample ||
        nextSample.timestamp >
          requestedMediaTime + ALREADY_PRESENTED_SAMPLE_EPSILON_SECONDS
      ) {
        break;
      }

      const dueSample = sampleQueue.shift();

      if (!dueSample) {
        break;
      }

      if (!shouldPresentSample(dueSample, shouldPresentLoopStartSample)) {
        dueSample.close();
        continue;
      }

      sampleToPresent?.close();
      sampleToPresent = dueSample;
    }

    return sampleToPresent;
  };

  const decodePlaybackFrame = async (runId: number, now: number) => {
    if (!isPlaybackRunActive(runId)) {
      return;
    }

    let requestedMediaTime =
      playbackOriginMediaTime + (now - playbackOriginNow) / 1000;
    const playableEnd =
      options.duration === null
        ? null
        : options.firstTimestamp + Math.max(options.duration, 0);
    let shouldPresentLoopStartSample = false;

    if (playableEnd !== null && requestedMediaTime >= playableEnd) {
      if (!options.loop) {
        playing = false;
        playbackRunId += 1;
        closeQueuedSamples();
        stopActiveSampleIterator();
        options.onEnded();
        return;
      }

      setCurrentTime(options.firstTimestamp);
      playbackOriginMediaTime = options.firstTimestamp;
      playbackOriginNow = now;
      requestedMediaTime = options.firstTimestamp;
      shouldPresentLoopStartSample = true;
      resetSampleIterator(options.firstTimestamp);
    }

    startSamplePrefetch(runId);
    await waitForFirstQueuedSample(runId);

    if (!isPlaybackRunActive(runId)) {
      return;
    }

    const sample = takeDueSample(
      requestedMediaTime,
      shouldPresentLoopStartSample,
    );

    if (sample) {
      try {
        const didWait = options.waitForSample
          ? await waitForSampleReadiness(sample)
          : false;

        if (!isPlaybackRunActive(runId)) {
          sample.close();
          return;
        }

        if (didWait) {
          playbackOriginMediaTime = sample.timestamp;
          playbackOriginNow = performance.now();
        }
      } catch (error) {
        sample.close();
        stopPlaybackWithError(runId, error);
        return;
      }

      options.presentSample(sample);
      setCurrentTime(sample.timestamp);
    }

    startSamplePrefetch(runId);
    schedulePlaybackFrame(runId);
  };

  const waitForSampleReadiness = async (sample: DecodedVideoSample) => {
    if (!options.waitForSample) {
      return false;
    }

    let didNotifyWaiting = false;
    const waitingTimer = setTimeout(() => {
      didNotifyWaiting = true;
      options.onWaiting?.();
    }, 0);

    try {
      await options.waitForSample(sample);
    } finally {
      clearTimeout(waitingTimer);
    }

    if (!didNotifyWaiting) {
      return false;
    }

    options.onResume?.();
    return true;
  };

  return {
    play() {
      if (destroyed || playing) {
        return;
      }

      playing = true;
      playbackRunId += 1;
      playbackOriginMediaTime = currentTime;
      playbackOriginNow = performance.now();
      resetSampleIterator(currentTime);
      startSamplePrefetch(playbackRunId);
      schedulePlaybackFrame(playbackRunId);
    },

    pause() {
      if (destroyed || !playing) {
        return;
      }

      playing = false;
      playbackRunId += 1;
      cancelScheduledFrame();
      closeQueuedSamples();
      stopActiveSampleIterator();
    },

    seek(mediaTime) {
      if (destroyed) {
        return;
      }

      const shouldResume = playing;

      playing = false;
      playbackRunId += 1;
      cancelScheduledFrame();
      closeQueuedSamples();
      stopActiveSampleIterator();
      setCurrentTime(mediaTime);
      playbackOriginMediaTime = mediaTime;
      playbackOriginNow = performance.now();

      if (!shouldResume) {
        return;
      }

      playing = true;
      playbackRunId += 1;
      resetSampleIterator(mediaTime);
      startSamplePrefetch(playbackRunId);
      schedulePlaybackFrame(playbackRunId);
    },

    destroy() {
      if (destroyed) {
        return;
      }

      destroyed = true;
      playing = false;
      playbackRunId += 1;
      cancelScheduledFrame();
      closeQueuedSamples();
      stopActiveSampleIterator();
    },
  };
}
