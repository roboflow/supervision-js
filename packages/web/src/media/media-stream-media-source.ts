import type {
  DecodedMediaSource,
  DecodedVideoSample,
  DecodedVideoSampleSink,
} from "#media/media-source";
import type { MediaRendererSource } from "#types/media-renderer";
import { MediaSourceError } from "#media/media-errors";
import { MediaErrorKind, includeDefined } from "supervision-js-core";

const DEFAULT_MAX_BUFFERED_FRAMES = 8;
const DEFAULT_FRAME_RATE = 30;
const TIMESTAMP_EPSILON_SECONDS = 1e-6;

/**
 * Renderer-neutral metadata for one frame the browser actually presented.
 *
 * `mediaTime` is on the same timeline the session reports, so a host can
 * correlate transport-side results with what is on screen. Every other field
 * is optional because browsers differ in what `requestVideoFrameCallback`
 * reports; absent fields are normal and must not break rendering. No DOM
 * element or vendor object is exposed.
 */
export type MediaStreamPresentedFrame = {
  /** Presentation time on the session media timeline, in seconds. */
  readonly mediaTime: number;
  /** RTP timestamp the sender stamped this frame with, when reported. */
  readonly rtpTimestamp?: number;
  /** Frame width in pixels, when reported. */
  readonly width?: number;
  /** Frame height in pixels, when reported. */
  readonly height?: number;
  /** `performance.now()` time the user agent submitted the frame, when reported. */
  readonly presentationTime?: number;
  /** `performance.now()` time the frame is expected to be visible, when reported. */
  readonly expectedDisplayTime?: number;
};

export type MediaStreamRendererSourceOptions = {
  /**
   * Receives metadata for each presented frame, before the snapshot is taken.
   *
   * Called synchronously from the browser frame callback so wall-clock
   * correlation stays accurate. Keep the handler cheap; a handler that throws
   * is ignored and does not interrupt playback.
   */
  readonly onPresentedFrame?: (frame: MediaStreamPresentedFrame) => void;
  /** Maximum decoded snapshots retained while the renderer is catching up. */
  readonly maxBufferedFrames?: number;
  /**
   * Timestamp origin exposed to the renderer. `"media"` preserves the browser
   * MediaStream clock. `"first-frame"` starts the visible timeline at zero so
   * an independently transported detection stream can apply the same origin.
   * Defaults to `"media"`.
   */
  readonly timestampOrigin?: "first-frame" | "media";
  /**
   * Stop the caller-supplied MediaStream tracks when the session is destroyed.
   * Defaults to false because WebRTC connection ownership normally stays with
   * the host application.
   */
  readonly stopTracksOnDispose?: boolean;
};

type CapturedMediaStreamFrame = {
  readonly duration: number;
  readonly image: ImageBitmap;
  readonly timestamp: number;
};

type ChangeWaiter = {
  readonly reject: (error: unknown) => void;
  readonly resolve: () => void;
};

/**
 * Adapts a browser MediaStream to the renderer-owned decoded-media boundary.
 *
 * The HTMLVideoElement is an internal decode clock only. Every presented frame
 * is snapshotted before it enters the bounded queue, so Pixi remains the sole
 * visible composition surface and annotations use the exact sample timestamp.
 */
export function createMediaStreamRendererSource(
  stream: MediaStream,
  options: MediaStreamRendererSourceOptions = {},
): MediaRendererSource {
  return {
    open() {
      return openMediaStreamMediaSource(stream, options);
    },
  };
}

async function openMediaStreamMediaSource(
  stream: MediaStream,
  options: MediaStreamRendererSourceOptions,
): Promise<DecodedMediaSource> {
  if (
    typeof document === "undefined" ||
    typeof createImageBitmap === "undefined"
  ) {
    throw new MediaSourceError(
      MediaErrorKind.EnvironmentUnsupported,
      "MediaStream rendering requires browser media APIs.",
    );
  }

  const maxBufferedFrames = resolveMaxBufferedFrames(options.maxBufferedFrames);
  const videoTracks = stream.getVideoTracks();
  const audioTracks = stream.getAudioTracks();

  if (videoTracks.length === 0) {
    throw new MediaSourceError(
      MediaErrorKind.NoVideoTrack,
      "MediaStream does not contain a video track.",
    );
  }

  const video = document.createElement("video");
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;

  const fallbackFrameDuration = resolveFrameDuration(videoTracks[0]);
  const bufferedFrames: CapturedMediaStreamFrame[] = [];
  const waiters = new Set<ChangeWaiter>();
  let disposed = false;
  let ended = false;
  let terminalError: unknown;
  let callbackHandle: number | undefined;
  let callbackKind: "animation" | "video" | undefined;
  let lastCapturedTimestamp = Number.NEGATIVE_INFINITY;
  let firstMediaTimestamp: number | undefined;

  const notifyWaiters = () => {
    for (const waiter of waiters) waiter.resolve();
    waiters.clear();
  };

  const rejectWaiters = (error: unknown) => {
    for (const waiter of waiters) waiter.reject(error);
    waiters.clear();
  };

  const closeBufferedFrames = () => {
    for (const frame of bufferedFrames.splice(0)) frame.image.close();
  };

  const markEnded = () => {
    if (disposed || ended) return;
    ended = true;
    cancelScheduledFrame();
    notifyWaiters();
  };

  const markError = (error: unknown) => {
    if (disposed || terminalError !== undefined) return;
    terminalError = error;
    cancelScheduledFrame();
    rejectWaiters(error);
  };

  const handleTrackEnded = () => {
    if (videoTracks.every((track) => track.readyState === "ended")) markEnded();
  };
  const handleStreamInactive = () => markEnded();
  const handleVideoEnded = () => markEnded();
  const handleVideoError = () =>
    markError(video.error ?? new Error("MediaStream video playback failed."));

  for (const track of videoTracks)
    track.addEventListener("ended", handleTrackEnded);
  stream.addEventListener("inactive", handleStreamInactive);
  video.addEventListener("ended", handleVideoEnded);
  video.addEventListener("error", handleVideoError);

  function cancelScheduledFrame() {
    if (callbackHandle === undefined) return;

    if (callbackKind === "video") {
      video.cancelVideoFrameCallback?.(callbackHandle);
    } else {
      window.cancelAnimationFrame(callbackHandle);
    }

    callbackHandle = undefined;
    callbackKind = undefined;
  }

  const enqueueFrame = (frame: CapturedMediaStreamFrame) => {
    if (disposed || ended || terminalError !== undefined) {
      frame.image.close();
      return;
    }

    if (frame.timestamp <= lastCapturedTimestamp + TIMESTAMP_EPSILON_SECONDS) {
      frame.image.close();
      return;
    }

    lastCapturedTimestamp = frame.timestamp;
    bufferedFrames.push(frame);

    while (bufferedFrames.length > maxBufferedFrames) {
      bufferedFrames.shift()?.image.close();
    }

    notifyWaiters();
  };

  const toSessionTimestamp = (mediaTime: number) => {
    const mediaTimestamp = Number.isFinite(mediaTime)
      ? mediaTime
      : video.currentTime;

    firstMediaTimestamp ??= mediaTimestamp;

    return options.timestampOrigin === "first-frame"
      ? Math.max(0, mediaTimestamp - firstMediaTimestamp)
      : mediaTimestamp;
  };

  const reportPresentedFrame = (frame: MediaStreamPresentedFrame) => {
    if (!options.onPresentedFrame) return;

    try {
      options.onPresentedFrame(frame);
    } catch {
      // Presented-frame reporting is host telemetry; never let it stop
      // decoding the live stream.
    }
  };

  const capturePresentedFrame = async (timestamp: number) => {
    callbackHandle = undefined;
    callbackKind = undefined;

    if (disposed || ended || terminalError !== undefined) return;

    try {
      const image = await createImageBitmap(video);
      enqueueFrame({
        duration: fallbackFrameDuration,
        image,
        timestamp,
      });
    } catch (error) {
      markError(error);
      return;
    }

    scheduleFrameCapture();
  };

  function scheduleFrameCapture() {
    if (
      disposed ||
      ended ||
      terminalError !== undefined ||
      callbackHandle !== undefined
    ) {
      return;
    }

    if (typeof video.requestVideoFrameCallback === "function") {
      callbackKind = "video";
      callbackHandle = video.requestVideoFrameCallback((_now, metadata) => {
        const timestamp = toSessionTimestamp(metadata.mediaTime);

        reportPresentedFrame(toPresentedFrame(timestamp, metadata));
        void capturePresentedFrame(timestamp);
      });
      return;
    }

    callbackKind = "animation";
    callbackHandle = window.requestAnimationFrame(() => {
      const timestamp = toSessionTimestamp(video.currentTime);

      reportPresentedFrame({ mediaTime: timestamp });
      void capturePresentedFrame(timestamp);
    });
  }

  const waitForChange = () => {
    if (terminalError !== undefined) return Promise.reject(terminalError);
    if (disposed || ended || bufferedFrames.length > 0)
      return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      waiters.add({ reject, resolve });
    });
  };

  const takeFrame = (
    startTimestamp: number | undefined,
    preferLatest: boolean,
  ): CapturedMediaStreamFrame | undefined => {
    const minimumTimestamp = startTimestamp ?? Number.NEGATIVE_INFINITY;

    while (
      bufferedFrames[0] &&
      bufferedFrames[0].timestamp < minimumTimestamp - TIMESTAMP_EPSILON_SECONDS
    ) {
      bufferedFrames.shift()?.image.close();
    }

    if (bufferedFrames.length === 0) return undefined;

    if (preferLatest) {
      while (bufferedFrames.length > 1) bufferedFrames.shift()?.image.close();
    }

    return bufferedFrames.shift();
  };

  const nextFrame = async (
    startTimestamp: number | undefined,
    preferLatest: boolean,
  ): Promise<CapturedMediaStreamFrame | null> => {
    while (!disposed) {
      if (terminalError !== undefined) throw terminalError;

      const frame = takeFrame(startTimestamp, preferLatest);
      if (frame) return frame;
      if (ended) return null;

      await waitForChange();
    }

    return null;
  };

  const sampleSink: DecodedVideoSampleSink = {
    async getSample(timestamp) {
      const frame = await nextFrame(timestamp, true);
      return frame ? createDecodedSample(frame) : null;
    },
    async *samples(startTimestamp) {
      while (!disposed) {
        // MediaStream is a live source, not a replayable queue. Rendering every
        // captured snapshot after a slow frame would permanently move playback
        // behind the live edge. Always discard superseded snapshots before the
        // next presentation so latency stays bounded by current work rather
        // than by historical decoder backlog.
        const frame = await nextFrame(startTimestamp, true);
        if (!frame) return;

        startTimestamp = frame.timestamp + TIMESTAMP_EPSILON_SECONDS;
        yield createDecodedSample(frame);
      }
    },
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cancelScheduledFrame();
    closeBufferedFrames();
    notifyWaiters();

    for (const track of videoTracks) {
      track.removeEventListener("ended", handleTrackEnded);
    }
    stream.removeEventListener("inactive", handleStreamInactive);
    video.removeEventListener("ended", handleVideoEnded);
    video.removeEventListener("error", handleVideoError);
    video.pause();
    video.srcObject = null;
    video.load();

    if (options.stopTracksOnDispose === true) {
      for (const track of stream.getTracks()) track.stop();
    }
  };

  try {
    await video.play();
    scheduleFrameCapture();
    await waitForChange();

    if (terminalError !== undefined) throw terminalError;
    const firstFrame = bufferedFrames[0];
    if (!firstFrame)
      throw new Error("MediaStream ended before producing a video frame.");

    return {
      input: { dispose },
      metadata: {
        audioTrackCount: audioTracks.length,
        canRead: true,
        duration: null,
        firstTimestamp: firstFrame.timestamp,
        formatMimeType: null,
        formatName: "media-stream",
        mimeType: null,
        primaryVideoHeight: firstFrame.image.height,
        primaryVideoWidth: firstFrame.image.width,
        trackCount: stream.getTracks().length,
        videoTrackCount: videoTracks.length,
      },
      sampleSink,
    };
  } catch (error) {
    dispose();
    rejectWaiters(error);
    throw error;
  }
}

function toPresentedFrame(
  mediaTime: number,
  metadata: VideoFrameCallbackMetadata,
): MediaStreamPresentedFrame {
  return {
    mediaTime,
    ...includeDefined({
      expectedDisplayTime: finiteOrUndefined(metadata.expectedDisplayTime),
      height: finiteOrUndefined(metadata.height),
      presentationTime: finiteOrUndefined(metadata.presentationTime),
      rtpTimestamp: finiteOrUndefined(metadata.rtpTimestamp),
      width: finiteOrUndefined(metadata.width),
    }),
  };
}

function finiteOrUndefined(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function createDecodedSample(
  frame: CapturedMediaStreamFrame,
): DecodedVideoSample {
  let closed = false;

  return {
    close() {
      if (closed) return;
      closed = true;
      frame.image.close();
    },
    draw(
      context,
      dx,
      dy,
      dWidth = frame.image.width,
      dHeight = frame.image.height,
    ) {
      if (closed) throw new Error("Cannot draw a closed MediaStream frame.");
      context.drawImage(frame.image, dx, dy, dWidth, dHeight);
    },
    duration: frame.duration,
    timestamp: frame.timestamp,
  };
}

function resolveMaxBufferedFrames(value: number | undefined) {
  if (value === undefined) return DEFAULT_MAX_BUFFERED_FRAMES;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("maxBufferedFrames must be a positive integer.");
  }
  return value;
}

function resolveFrameDuration(track: MediaStreamTrack | undefined) {
  const frameRate = track?.getSettings?.().frameRate;
  return frameRate && Number.isFinite(frameRate) && frameRate > 0
    ? 1 / frameRate
    : 1 / DEFAULT_FRAME_RATE;
}
