/**
 * A frame of the source, named by its place in presentation order and by its
 * presentation timestamp in the container's own integer grain.
 */
export interface PresentedFrameId {
  readonly index: number;
  readonly ticks: number;
}

/**
 * One frame a push-based media producer has decided is on screen, carrying the
 * frame it is and the media time it stands for. Whoever receives it owns it and
 * must close it.
 */
export interface PresentedVideoFrame {
  readonly frameId: PresentedFrameId;
  /**
   * The producer's count of the paints it has made, which is what its own
   * diagnostics name a paint by. Two paints of one frame carry different
   * numbers, so this is the only key that joins a frame the renderer drew to
   * the paint the producer recorded making.
   */
  readonly paintSeq: number;
  /**
   * The producer's seconds for `frameId`. The producer also states the position
   * in milliseconds, and this deliberately does not carry it: that value is the
   * seconds scaled by a thousand, so dividing it back is not the identity, and
   * on a container whose tick grain is not whole milliseconds, an NTSC
   * 30000/1001 track among them, the result names no frame at all.
   */
  readonly mediaTimeS: number;
  readonly frame: VideoFrame;
}

/** Where the producer's playhead sits, named as a frame of the source. */
export interface PresentedFramePlayhead {
  readonly frame: PresentedFrameId;
  readonly mediaTimeS: number;
}

/** Coarse producer status, reported in the producer's own vocabulary. */
export type PresentedFrameChannelStatus =
  | "IDLE"
  | "LOADING"
  | "READY"
  | "PLAYING"
  | "PAUSED"
  | "SEEKING"
  | "ENDED"
  | "ERRORED";

/**
 * Whether a seek is a gesture still moving or a jump to a destination. A
 * producer may answer a gesture from a cheap cache and a jump exactly.
 */
export type PresentedFrameSeekIntent = "gesture" | "jump";

/**
 * Producer signals, one per cadence: `time` on every playhead move, `state` on
 * coarse status transitions, `seeking` when a seek starts or settles, `rate`
 * when the playback speed changes.
 */
export type PresentedFrameChannelSignal = "time" | "state" | "seeking" | "rate";

/**
 * A producer's presented-frame plane. Registering replaces any previous
 * handler, so the registered handler is the single owner of every frame.
 */
export interface PresentedFrameSource {
  onPresentedFrame(handler: (presented: PresentedVideoFrame) => void): void;
}

export interface ProtectedPresentedFrameSource {
  readonly source: PresentedFrameSource;
  /** Starts forwarding through the asynchronous pre-presentation guard. */
  activate(
    protect: (
      presented: PresentedVideoFrame,
      signal: AbortSignal,
    ) => Promise<void> | null,
  ): void;
  /** Invalidates a frame waiting on readiness before a new navigation. */
  invalidate(): void;
  /** Opens an acknowledgment for one settling navigation. The producer may
   *  emit its landing before its command promise resumes, so accepted frame
   *  identities are retained until the caller names the producer's result. */
  beginNavigation(): PresentedFrameNavigation;
  /** Resolves after the downstream scene has synchronously accepted a frame. */
  waitForFirstPresentation(): Promise<void>;
  destroy(): void;
}

export interface PresentedFrameNavigation {
  /** Resolves only after the scene has synchronously accepted this frame. */
  waitFor(frameId: PresentedFrameId): Promise<void>;
  /** Releases the acknowledgment when its producer command fails. */
  cancel(): void;
}

interface PresentedFrameNavigationTicket {
  readonly accepted: Set<string>;
  readonly promise: Promise<void>;
  readonly reject: (error: unknown) => void;
  readonly resolve: () => void;
  settled: boolean;
  target: string | null;
}

/**
 * Holds the newest producer frame until both the scene and its readiness guard
 * can accept it. A superseding frame aborts the old guard and closes the old
 * VideoFrame, so stale readiness can never authorize presentation after a new
 * seek. The downstream handler owns a frame only after the guard succeeds.
 */
export function createProtectedPresentedFrameSource(
  upstream: PresentedFrameSource,
  onPresentationError: (error: unknown) => void = () => undefined,
): ProtectedPresentedFrameSource {
  let downstream: ((presented: PresentedVideoFrame) => void) | null = null;
  let protect:
    | ((
        presented: PresentedVideoFrame,
        signal: AbortSignal,
      ) => Promise<void> | null)
    | null = null;
  let pending: PresentedVideoFrame | null = null;
  let active: {
    readonly controller: AbortController;
    readonly frame: PresentedVideoFrame;
    readonly generation: number;
    closed: boolean;
    handedOff: boolean;
  } | null = null;
  let navigation: PresentedFrameNavigationTicket | null = null;
  let generation = 0;
  let destroyed = false;
  let firstPresented = false;
  let resolveFirstPresentation!: () => void;
  let rejectFirstPresentation!: (error: unknown) => void;
  const firstPresentation = new Promise<void>((resolve, reject) => {
    resolveFirstPresentation = resolve;
    rejectFirstPresentation = reject;
  });
  // A retained seed can fail its guard during activate(), before the core has
  // reached its await. Keep the rejection owned until that caller observes it.
  void firstPresentation.catch(() => undefined);

  const closeRun = (run: NonNullable<typeof active>) => {
    if (run.closed || run.handedOff) return;
    run.closed = true;
    run.frame.frame.close();
  };

  const frameKey = (frameId: PresentedFrameId) =>
    `${frameId.index}:${frameId.ticks}`;

  const settleNavigation = (
    ticket: NonNullable<typeof navigation>,
    error?: unknown,
  ) => {
    if (ticket.settled) return;
    ticket.settled = true;
    if (navigation === ticket) navigation = null;
    if (error === undefined) ticket.resolve();
    else ticket.reject(error);
  };

  const acceptNavigationFrame = (frameId: PresentedFrameId) => {
    const ticket = navigation;
    if (!ticket || ticket.settled) return;
    const accepted = frameKey(frameId);
    ticket.accepted.add(accepted);
    if (ticket.target === accepted) settleNavigation(ticket);
  };

  const failPresentation = (error: unknown) => {
    if (!firstPresented) rejectFirstPresentation(error);
    if (navigation) settleNavigation(navigation, error);
    if (firstPresented) onPresentationError(error);
  };

  const cancelActive = () => {
    const run = active;
    if (!run) return;
    active = null;
    run.controller.abort();
    closeRun(run);
  };

  const pump = () => {
    if (destroyed || active || !pending || !downstream || !protect) return;
    const frame = pending;
    pending = null;
    const controller = new AbortController();
    const run = {
      closed: false,
      controller,
      frame,
      generation,
      handedOff: false,
    };
    active = run;

    const handOff = () => {
      if (
        destroyed ||
        controller.signal.aborted ||
        run.generation !== generation
      ) {
        closeRun(run);
        return;
      }
      if (active === run) active = null;
      run.handedOff = true;
      try {
        downstream!(frame);
      } catch (error) {
        failPresentation(error);
        return;
      }
      acceptNavigationFrame(frame.frameId);
      if (!firstPresented) {
        firstPresented = true;
        resolveFirstPresentation();
      }
    };

    let guarded: Promise<void> | null;
    try {
      guarded = protect(frame, controller.signal);
    } catch (error) {
      active = null;
      closeRun(run);
      failPresentation(error);
      pump();
      return;
    }
    if (!guarded) {
      handOff();
      pump();
      return;
    }

    void guarded
      .then(() => {
        handOff();
      })
      .catch((error) => {
        closeRun(run);
        if (!controller.signal.aborted) failPresentation(error);
      })
      .finally(() => {
        if (active === run) active = null;
        pump();
      });
  };

  upstream.onPresentedFrame((presented) => {
    if (destroyed) {
      presented.frame.close();
      return;
    }
    generation += 1;
    cancelActive();
    pending?.frame.close();
    pending = presented;
    pump();
  });

  return {
    source: {
      onPresentedFrame(handler) {
        downstream = handler;
        pump();
      },
    },
    activate(nextProtect) {
      protect = nextProtect;
      pump();
    },
    invalidate() {
      generation += 1;
      cancelActive();
      pending?.frame.close();
      pending = null;
      if (navigation) settleNavigation(navigation);
    },
    beginNavigation() {
      generation += 1;
      cancelActive();
      pending?.frame.close();
      pending = null;
      if (navigation) settleNavigation(navigation);
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<void>((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
      });
      // A scene may fail before the transport reaches waitFor(). Keep the
      // rejection owned until the navigation command observes it.
      void promise.catch(() => undefined);
      const ticket: PresentedFrameNavigationTicket = {
        accepted: new Set<string>(),
        promise,
        reject,
        resolve,
        settled: false,
        target: null,
      };
      navigation = ticket;
      return {
        waitFor(frameId) {
          if (ticket.settled) return ticket.promise;
          ticket.target = frameKey(frameId);
          if (ticket.accepted.has(ticket.target)) settleNavigation(ticket);
          return ticket.promise;
        },
        cancel() {
          settleNavigation(ticket);
        },
      };
    },
    waitForFirstPresentation: () => firstPresentation,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      generation += 1;
      cancelActive();
      pending?.frame.close();
      pending = null;
      if (navigation) settleNavigation(navigation);
      upstream.onPresentedFrame((presented) => presented.frame.close());
      if (!firstPresented) resolveFirstPresentation();
    },
  };
}

/**
 * The frame plane plus the transport that moves it. Everything below the frames
 * is the playhead, and the producer owns it: a renderer holding this channel
 * asks rather than decides.
 */
export interface PresentedFrameChannel extends PresentedFrameSource {
  /**
   * Runs the playhead forward from where it stands, and from `ENDED` restarts
   * at the start of the source.
   *
   * A channel never loops itself. A renderer told to loop replays by calling
   * this when the status turns `ENDED`, so a channel that resumes in place
   * from `ENDED` never loops.
   */
  play(): Promise<void>;
  /**
   * Stops the playhead where it stands. A pause asked for here outranks the
   * freeze `beginInteractiveSeek` holds, so the `endInteractiveSeek` that ends
   * the drag has nothing left to resume.
   */
  pause(): void;
  /** Latest-wins seek for a gesture in flight; returns without settling. */
  scrub(timeMs: number, intent?: PresentedFrameSeekIntent): void;
  /** Seek that settles: resolves once the producer has presented its landing.
   * Recommitting the current time must replay or retain that presentation for
   * a newly subscribed frame consumer. */
  commit(timeMs: number): Promise<void>;
  /** Walks one real source frame in presentation order. */
  step(direction: 1 | -1): Promise<void>;
  /**
   * Forward playback speed, in media seconds per wall second. Throws on a rate
   * the producer cannot play, reverse included.
   */
  setPlaybackRate(rate: number): void;
  getPlaybackRate(): number;
  /** Freezes a playing producer for the length of a drag. */
  beginInteractiveSeek(): void;
  /** Resumes play only if `beginInteractiveSeek` was what paused it. */
  endInteractiveSeek(): Promise<void>;
  getPlayhead(): PresentedFramePlayhead;
  getDurationMs(): number;
  getStatus(): PresentedFrameChannelStatus;
  getSeeking(): boolean;
  subscribe(
    signal: PresentedFrameChannelSignal,
    listener: () => void,
  ): () => void;
}

/**
 * Reads the presented-frame plane an opened media source publishes as `engine`.
 * A source without one is pull-only, and the renderer keeps driving it by
 * asking for samples.
 */
export function resolvePresentedFrameChannel(
  source: unknown,
): PresentedFrameChannel | null {
  if (typeof source !== "object" || source === null) {
    return null;
  }

  const { engine } = source as { readonly engine?: unknown };

  return isPresentedFrameChannel(engine) ? engine : null;
}

function isPresentedFrameChannel(
  value: unknown,
): value is PresentedFrameChannel {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<PresentedFrameChannel>;

  return (
    typeof candidate.onPresentedFrame === "function" &&
    typeof candidate.getPlayhead === "function" &&
    typeof candidate.commit === "function" &&
    typeof candidate.step === "function" &&
    typeof candidate.subscribe === "function"
  );
}
