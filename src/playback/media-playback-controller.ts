import { ALREADY_PRESENTED_SAMPLE_EPSILON_SECONDS } from "#constants/media-renderer";
import type {
  DecodedVideoSample,
  DecodedVideoSampleSink,
} from "#media/media-source";

export interface MediaPlaybackController {
  play(): void;
  pause(): void;
  destroy(): void;
}

export function createMediaPlaybackController(options: {
  readonly sampleSink: DecodedVideoSampleSink;
  readonly firstTimestamp: number;
  readonly duration: number | null;
  readonly loop: boolean;
  readonly initialMediaTime: number;
  readonly presentSample: (sample: DecodedVideoSample) => void;
  readonly onCurrentTimeChange: (currentTime: number) => void;
  readonly onEnded: () => void;
  readonly onError: (error: unknown) => void;
}): MediaPlaybackController {
  let destroyed = false;
  let playing = false;
  let playbackRunId = 0;
  let playbackOriginMediaTime = options.initialMediaTime;
  let playbackOriginNow = 0;
  let currentTime = options.initialMediaTime;
  let animationFrameHandle: number | undefined;

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

  const shouldPresentSample = (
    sample: DecodedVideoSample,
    shouldPresentLoopStartSample: boolean,
  ) =>
    sample.timestamp > currentTime + ALREADY_PRESENTED_SAMPLE_EPSILON_SECONDS ||
    (shouldPresentLoopStartSample &&
      Math.abs(sample.timestamp - options.firstTimestamp) <=
        ALREADY_PRESENTED_SAMPLE_EPSILON_SECONDS);

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
        options.onEnded();
        return;
      }

      setCurrentTime(options.firstTimestamp);
      playbackOriginMediaTime = options.firstTimestamp;
      playbackOriginNow = now;
      requestedMediaTime = options.firstTimestamp;
      shouldPresentLoopStartSample = true;
    }

    try {
      const sample = await options.sampleSink.getSample(requestedMediaTime, {
        skipLiveWait: true,
      });

      if (!isPlaybackRunActive(runId)) {
        sample?.close();
        return;
      }

      if (sample && shouldPresentSample(sample, shouldPresentLoopStartSample)) {
        options.presentSample(sample);
        setCurrentTime(sample.timestamp);
      } else {
        sample?.close();
      }
    } catch (error) {
      if (!destroyed && playbackRunId === runId) {
        playing = false;
        playbackRunId += 1;
        options.onError(error);
      }
      return;
    }

    schedulePlaybackFrame(runId);
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
      schedulePlaybackFrame(playbackRunId);
    },

    pause() {
      if (destroyed || !playing) {
        return;
      }

      playing = false;
      playbackRunId += 1;
      cancelScheduledFrame();
    },

    destroy() {
      if (destroyed) {
        return;
      }

      destroyed = true;
      playing = false;
      playbackRunId += 1;
      cancelScheduledFrame();
    },
  };
}
