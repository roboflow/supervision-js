import { MediaRendererPlaybackState } from "#types/media-renderer";
import type {
  PresentedFrameChannel,
  PresentedFrameChannelStatus,
} from "./presented-frame-channel";

const MILLISECONDS_PER_SECOND = 1000;

export interface MediaRendererTransport {
  play(): Promise<void>;
  pause(): void;
  togglePlayback(): void;
  scrub(mediaTime: number): void;
  commit(mediaTime: number): Promise<void>;
  step(direction: 1 | -1): Promise<void>;
  destroy(): void;
}

export interface MediaRendererTransportOptions {
  /** Replay from the start when the producer reports the source ended. */
  readonly loop: boolean;
  readonly channel: PresentedFrameChannel;
  readonly onPlaybackState: (state: MediaRendererPlaybackState) => void;
  readonly onPlayheadTime: (mediaTime: number) => void;
}

/**
 * The renderer's playback surface over a producer that owns the playhead.
 * Seconds meet milliseconds here and nowhere else.
 *
 * A drag is a pair: every `scrub` belongs to one gesture the producer is told
 * about, and the `commit` that lands it releases that gesture, so a producer
 * that froze itself for the drag is the one deciding whether to resume.
 */
export function createMediaRendererTransport(
  options: MediaRendererTransportOptions,
): MediaRendererTransport {
  const { channel } = options;
  let gestureInFlight = false;
  let settledState: MediaRendererPlaybackState | null = null;

  const publishPlaybackState = () => {
    const status = channel.getStatus();

    // The engine has no loop of its own; its play() from ENDED restarts at
    // zero, so looping is one replay at the moment the producer announces it.
    if (status === "ENDED" && options.loop) {
      void channel.play();
    }

    const seeking = channel.getSeeking();
    // Inside the transport's own drag gesture the engine pauses itself as a
    // mechanic and resumes on release; the user never asked to pause, so the
    // state holds whatever was settled when the gesture began.
    const state =
      gestureInFlight && settledState !== null && status !== "ERRORED"
        ? settledState
        : resolveTransportPlaybackState(status, seeking, settledState);

    if (!gestureInFlight && !isSettling(status, seeking)) {
      settledState = state;
    }

    options.onPlaybackState(state);
  };
  const publishPlayheadTime = () => {
    options.onPlayheadTime(channel.getTimeMs() / MILLISECONDS_PER_SECOND);
  };
  const unsubscribes = [
    channel.subscribe("state", publishPlaybackState),
    channel.subscribe("seeking", publishPlaybackState),
    channel.subscribe("time", publishPlayheadTime),
  ];

  const releaseGesture = async () => {
    if (!gestureInFlight) {
      return;
    }

    gestureInFlight = false;
    await channel.endInteractiveSeek();
  };

  return {
    async play() {
      await releaseGesture();
      await channel.play();
    },

    pause() {
      channel.pause();
    },

    togglePlayback() {
      channel.togglePlayback();
    },

    scrub(mediaTime) {
      if (!gestureInFlight) {
        gestureInFlight = true;
        channel.beginInteractiveSeek();
      }

      channel.scrub(mediaTime * MILLISECONDS_PER_SECOND, "gesture");
    },

    async commit(mediaTime) {
      await channel.commit(mediaTime * MILLISECONDS_PER_SECOND);
      await releaseGesture();
    },

    async step(direction) {
      await releaseGesture();
      await channel.step(direction);
    },

    destroy() {
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
    },
  };
}

/**
 * A settling seek is not a playback state: the picture is landing, and the
 * transport keeps whatever play or pause the seek interrupted. Seeking travels
 * as its own signal, so folding it in here would only spend the buffering
 * state on every scrub and leave nothing to say when playback truly stalls.
 */
function resolveTransportPlaybackState(
  status: PresentedFrameChannelStatus,
  seeking: boolean,
  settledState: MediaRendererPlaybackState | null,
): MediaRendererPlaybackState {
  if (status === "ERRORED") {
    return MediaRendererPlaybackState.Error;
  }

  if (isSettling(status, seeking)) {
    return settledState ?? MediaRendererPlaybackState.Ready;
  }

  switch (status) {
    case "PLAYING":
      return MediaRendererPlaybackState.Playing;
    case "PAUSED":
    case "ENDED":
      return MediaRendererPlaybackState.Paused;
    case "READY":
      return MediaRendererPlaybackState.Ready;
    case "SEEKING":
      return settledState ?? MediaRendererPlaybackState.Ready;
    case "IDLE":
    case "LOADING":
      // Falling back to loading mid-playback is the producer saying it cannot
      // advance the frame it is meant to be playing.
      return settledState === MediaRendererPlaybackState.Playing
        ? MediaRendererPlaybackState.Buffering
        : MediaRendererPlaybackState.Loading;
  }
}

function isSettling(status: PresentedFrameChannelStatus, seeking: boolean) {
  return seeking || status === "SEEKING";
}
