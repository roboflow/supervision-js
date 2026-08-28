import { MediaRendererPlaybackState } from "#types/media-renderer";
import type {
  PresentedFrameChannel,
  PresentedFrameChannelStatus,
} from "./presented-frame-channel";

const MILLISECONDS_PER_SECOND = 1000;

export interface MediaRendererTransport {
  play(): Promise<void>;
  pause(): void;
  togglePlayback(): Promise<void>;
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
  /**
   * The playhead has moved to a frame that is not on screen yet. Reported apart
   * from `onPlaybackState` because the state a seek settles from is the one the
   * transport keeps reporting throughout it.
   *
   * True for a scrub as well as for a landing, so pair it with `onScrubbing` to
   * tell a viewer who is waiting from one who is dragging.
   */
  readonly onSeeking: (seeking: boolean) => void;
  /**
   * A drag is open on the playhead. Published as the drag opens and closes
   * without waiting for the producer, whose next word on a slow source is
   * seconds away.
   */
  readonly onScrubbing: (scrubbing: boolean) => void;
  /** Buffered playback. Awaited before the producer is asked to run. */
  readonly waitForReadiness?: (mediaTime: number) => Promise<void>;
  /**
   * A bounded wait for whatever annotates `mediaTime`, or null when nothing is
   * missing. Asked on every playhead move, so answering null has to be cheap.
   *
   * This is what stops a producer already at speed, so what it waits for has to
   * be something that gives up on its own. Left out, playback is held once and
   * never again, and a producer outrunning whatever feeds it runs on past
   * frames that have nothing to draw.
   */
  readonly holdForReadiness?: (mediaTime: number) => Promise<void> | null;
}

/**
 * The renderer's playback surface over a producer that owns the playhead.
 * Seconds meet milliseconds here and nowhere else.
 *
 * A drag is a pair: every `scrub` belongs to one gesture the producer is told
 * about, and the `commit` that lands it releases that gesture, so a producer
 * that froze itself for the drag is the one deciding whether to resume. The
 * drag and the settle travel as separate signals: which of the two a viewer is
 * looking at is the host's judgement, not the transport's.
 */
export function createMediaRendererTransport(
  options: MediaRendererTransportOptions,
): MediaRendererTransport {
  const { channel } = options;
  let gestureInFlight = false;
  let landingRelease: Promise<void> | null = null;
  let settledState: MediaRendererPlaybackState | null = null;
  // Anything that settles playback other than the hold itself invalidates the
  // play the hold is waiting for, so a pause taken during it is not undone by
  // the readiness that arrives afterwards.
  let playbackIntent = 0;
  /** Intent a readiness wait belongs to, or null while none is running. */
  let readinessHoldIntent: number | null = null;
  const isHoldingForReadiness = () => readinessHoldIntent === playbackIntent;

  const publishSeekSignals = () => {
    options.onScrubbing(gestureInFlight);
    options.onSeeking(isSettling(channel.getStatus(), channel.getSeeking()));
  };

  const releaseGesture = async () => {
    if (!gestureInFlight) {
      return;
    }

    gestureInFlight = false;
    publishSeekSignals();
    await channel.endInteractiveSeek();
  };

  const publishPlaybackState = () => {
    const status = channel.getStatus();

    // A producer never loops itself, and its play() from ENDED restarts at the
    // start of the source, so looping is one replay at the moment the producer
    // announces the end.
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
    // which is what the release resumes and what a toggle acts on.
    const state =
      gestureInFlight && status !== "ERRORED"
        ? MediaRendererPlaybackState.Paused
        : isHoldingForReadiness() && status !== "ERRORED"
          ? MediaRendererPlaybackState.Buffering
          : resolveTransportPlaybackState(status, seeking, settledState);

    if (!gestureInFlight && !isSettling(status, seeking)) {
      settledState = state;
    }

    publishSeekSignals();
    options.onPlaybackState(state);
  };
  /**
   * Stops the producer while the frame it has reached waits for what annotates
   * it, and starts it again once that arrives.
   *
   * The producer's own mechanical pause is what holds it, the same one a drag
   * uses, so a drag arriving mid-hold takes the hold over rather than fighting
   * it and the release it lands with is the one that resumes.
   */
  const holdForReadiness = async (wait: Promise<void>) => {
    const intent = playbackIntent;

    readinessHoldIntent = intent;
    channel.beginInteractiveSeek();
    publishPlaybackState();

    try {
      await wait;
    } catch {
      // A wait that failed is over, and the release below is the only thing
      // that starts the producer again. Whoever owns the failure reports it.
    } finally {
      if (readinessHoldIntent === intent) {
        readinessHoldIntent = null;
      }
    }

    if (!gestureInFlight) {
      await channel.endInteractiveSeek();
    }

    publishPlaybackState();
  };

  const publishPlayheadTime = () => {
    options.onPlayheadTime(channel.getPlayhead().mediaTimeS);

    if (
      !options.holdForReadiness ||
      readinessHoldIntent !== null ||
      gestureInFlight ||
      channel.getStatus() !== "PLAYING" ||
      channel.getSeeking()
    ) {
      return;
    }

    const wait = options.holdForReadiness(channel.getPlayhead().mediaTimeS);

    if (wait) {
      void holdForReadiness(wait);
    }
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
      // The producer answers on its own thread, so its status still reads the
      // previous playback until it does. Recording the ask here is what lets a
      // second toggle arriving in that window flip it.
      settledState = MediaRendererPlaybackState.Playing;
      const intent = ++playbackIntent;
      await releaseGesture();

      if (options.waitForReadiness) {
        readinessHoldIntent = intent;
        publishPlaybackState();
        try {
          await options.waitForReadiness(channel.getPlayhead().mediaTimeS);
        } finally {
          if (readinessHoldIntent === intent) {
            readinessHoldIntent = null;
          }
        }

        if (intent !== playbackIntent) {
          publishPlaybackState();
          return;
        }
      }

      await channel.play();
      // A producer already at speed reports no change, so nothing else would
      // retire the hold's own Buffering and it would stand for good.
      publishPlaybackState();
    },

    pause() {
      settledState = MediaRendererPlaybackState.Paused;
      playbackIntent++;
      // A pause ends the producer's mechanical hold, so it lands ahead of the
      // release the open gesture still owes.
      channel.pause();
      void releaseGesture();
    },

    async togglePlayback() {
      // The producer's own toggle is fire-and-forget, so a play that fails
      // inside it reaches nobody. Deciding here is also what a drag needs: the
      // producer sits paused as a mechanic for its length and would read that
      // as the user's pause, while `settledState` holds what the user chose.
      // A stall is a play still being asked for, so it toggles off.
      if (
        settledState === MediaRendererPlaybackState.Playing ||
        settledState === MediaRendererPlaybackState.Buffering
      ) {
        transport.pause();
        return;
      }

      await transport.play();
    },

    scrub(mediaTime) {
      // A drag whose landing seek is still releasing the producer is the drag
      // this scrub belongs to. Opening a second one there would stop the
      // picture for a gesture nobody is holding, and nothing would release it.
      playbackIntent++;
      if (!gestureInFlight && landingRelease === null) {
        gestureInFlight = true;
        channel.beginInteractiveSeek();
        publishSeekSignals();
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
      playbackIntent++;
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
