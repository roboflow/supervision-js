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
  /** Seek that settles: resolves once the producer has landed on `timeMs`. */
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
