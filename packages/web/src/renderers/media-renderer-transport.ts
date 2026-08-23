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
  setPlaybackRate(rate: number): void;
  destroy(): void;
}

export interface MediaRendererTransportOptions {
  /** Replay from the start when the producer reports the source ended. */
  readonly loop: boolean;
  readonly channel: PresentedFrameChannel;
  readonly onPlaybackRate: (rate: number) => void;
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
  let landingRelease: Promise<void> | null = null;
  let settledState: MediaRendererPlaybackState | null = null;

  const releaseGesture = async () => {
    if (!gestureInFlight) {
      return;
    }

    gestureInFlight = false;
    await channel.endInteractiveSeek();
  };

  const publishPlaybackState = () => {
    const status = channel.getStatus();

    // The engine has no loop of its own; its play() from ENDED restarts at
    // zero, so looping is one replay at the moment the producer announces it.
    if (status === "ENDED" && options.loop) {
      void channel.play();
    }

    const seeking = channel.getSeeking();
    // The gesture only speaks for the surface while the producer sits in the
    // mechanical pause it asked for. A producer reporting anything else has
    // moved on, and letting the gesture go means paying the release it owes:
    // dropping the bookkeeping alone would leave the producer frozen for a
    // drag nobody is holding.
    if (
      gestureInFlight &&
      !isSettling(status, seeking) &&
      status !== "PAUSED"
    ) {
      void releaseGesture();
    }

    // A drag stops the picture, and a control that reads this state has to be
    // able to say so. What the user settled on survives in `settledState`,
    // which is what the release resumes and what a mid-drag toggle acts on.
    const state =
      gestureInFlight && status !== "ERRORED"
        ? MediaRendererPlaybackState.Paused
        : resolveTransportPlaybackState(status, seeking, settledState);

    if (!gestureInFlight && !isSettling(status, seeking)) {
      settledState = state;
    }

    options.onPlaybackState(state);
  };
  const publishPlayheadTime = () => {
    options.onPlayheadTime(channel.getPlayhead().mediaTimeS);
  };
  const publishPlaybackRate = () => {
    options.onPlaybackRate(channel.getPlaybackRate());
  };
  const unsubscribes = [
    channel.subscribe("state", publishPlaybackState),
    channel.subscribe("seeking", publishPlaybackState),
    channel.subscribe("time", publishPlayheadTime),
    channel.subscribe("rate", publishPlaybackRate),
  ];

  const transport: MediaRendererTransport = {
    async play() {
      await releaseGesture();
      await channel.play();
    },

    pause() {
      // A pause ends the producer's mechanical hold, so it lands ahead of the
      // release the open gesture still owes.
      channel.pause();
      void releaseGesture();
    },

    togglePlayback() {
      if (!gestureInFlight) {
        channel.togglePlayback();
        return;
      }

      // Mid-gesture the producer sits paused as a mechanic, and its own toggle
      // would read that as the user's pause. What the user settled on is what
      // there is to toggle.
      if (settledState === MediaRendererPlaybackState.Playing) {
        transport.pause();
      } else {
        void transport.play();
      }
    },

    scrub(mediaTime) {
      // A drag whose landing seek is still releasing the producer is the drag
      // this scrub belongs to. Opening a second one there would stop the
      // picture for a gesture nobody is holding, and nothing would release it.
      if (!gestureInFlight && landingRelease === null) {
        gestureInFlight = true;
        channel.beginInteractiveSeek();
      }

      channel.scrub(mediaTime * MILLISECONDS_PER_SECOND, "gesture");
    },

    async commit(mediaTime) {
      // Releasing first is what keeps a drag from freezing the picture on
      // release: the producer resumes on its own terms, and the landing decode
      // for a cold region no longer sits between the pointer coming up and
      // playback continuing.
      const release = releaseGesture();
      landingRelease = release;
      try {
        await release;
      } finally {
        if (landingRelease === release) {
          landingRelease = null;
        }
      }

      await channel.commit(mediaTime * MILLISECONDS_PER_SECOND);
    },

    async step(direction) {
      await releaseGesture();
      await channel.step(direction);
    },

    setPlaybackRate(rate) {
      channel.setPlaybackRate(rate);
    },

    destroy() {
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
    },
  };

  return transport;
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
