import {
  openWalkSource,
  type WalkFrameSource,
  type WalkSourceHandle,
} from "./decode-source";
import type { VideoSampleLike } from "./scrub-cursor";
import type { VideoSource } from "./types";

const MS_PER_SECOND = 1000;

/** One microsecond, the grain container timestamps are stored at, so a bound
 *  that lands on a frame is never pushed off it by float error. */
const BOUND_EPSILON_MS = 1e-3;

/**
 * One frame of a walk.
 *
 * `frameIndex` counts real frames from the start of the walked range, so the
 * same frame carries the same number whatever stride was taken, and
 * `timestampMs` is the sample's own.
 *
 * `sample` is live and closing it is the caller's, the obligation every
 * VideoSampleLike carries. One dropped without close holds a decoder frame until
 * garbage collection, which WebCodecs complains about on the console and which
 * starves the decoder long before that.
 */
export interface WalkedFrame {
  readonly frameIndex: number;
  readonly timestampMs: number;
  readonly durationMs: number;
  readonly sample: VideoSampleLike;
}

export interface FrameWalkRange {
  /** Inclusive start; the track's first timestamp when omitted. */
  readonly startMs?: number;
  /** Exclusive end, so two abutting ranges walk every frame once between them;
   *  the end of the source when omitted. */
  readonly endMs?: number;
  /** Yield every Nth real frame. Counted in frames, not in time, so the spacing
   *  holds on a variable-rate source and cannot accumulate drift. */
  readonly stride?: number;
}

export interface FrameWalkMetadata {
  readonly durationS: number;
  readonly width: number;
  readonly height: number;
  readonly nativeFps: number | null;
  readonly firstTimestampS: number;
}

/**
 * Every real decoded frame of a range, in presentation order, exactly once.
 *
 * Nothing here is synthesized: the walk reads the source's own frames and counts
 * them. Timestamps built from a frame rate and resolved through at-or-before
 * extraction cannot promise that. One falling a float's width short of a sample
 * lands on the frame before it, so the caller gets that frame twice and never
 * sees the one it was aiming at.
 *
 * Every sample the walk decodes and does not yield is closed here: the frames
 * before the range, the ones stride skips, and the first one past the end.
 * Breaking out of the walk returns the underlying stream, which releases the
 * decoder's read of the source; the sample in the caller's hand at that moment
 * is still the caller's to close.
 */
export async function* walkFrames(
  source: WalkFrameSource,
  range: FrameWalkRange = {},
): AsyncGenerator<WalkedFrame, void, unknown> {
  const stride = range.stride ?? 1;
  if (!Number.isInteger(stride) || stride < 1) {
    throw new RangeError(
      `walkFrames: stride must be a positive integer, got ${stride}`,
    );
  }
  const startMs = range.startMs ?? source.track.firstTimestampS * MS_PER_SECOND;
  const endMs = range.endMs ?? Infinity;
  if (endMs <= startMs) return;

  const frames = source.framesFrom(startMs / MS_PER_SECOND);
  let framesInRange = 0;
  try {
    for (
      let next = await frames.next();
      !next.done;
      next = await frames.next()
    ) {
      const sample = next.value;
      const timestampMs = sample.timestamp * MS_PER_SECOND;
      if (timestampMs < startMs - BOUND_EPSILON_MS) {
        // The stream opens on the frame covering startMs, which is a
        // frame the range does not contain.
        sample.close();
        continue;
      }
      if (timestampMs >= endMs - BOUND_EPSILON_MS) {
        sample.close();
        return;
      }
      const frameIndex = framesInRange++;
      if (frameIndex % stride !== 0) {
        sample.close();
        continue;
      }
      yield {
        frameIndex,
        timestampMs,
        durationMs: sample.duration * MS_PER_SECOND,
        sample,
      };
    }
  } finally {
    await frames.return();
  }
}

/**
 * A batch consumer's entry to the runtime: opens a source, walks its real
 * frames, and disposes what it opened. It spins no worker, binds no canvas, and
 * runs no clock, and it decodes on an input of its own, so a walk and a playing
 * engine never contend for one decoder's read head.
 *
 * A walk in flight ends when the walker is closed, the same way extraction does,
 * so a consumer that abandons a job mid-range has one call to make.
 */
export class FrameWalker {
  private closed = false;

  constructor(private readonly handle: WalkSourceHandle) {}

  /** Opens a source for walking; the returned walker owns it. */
  static async open(source: VideoSource): Promise<FrameWalker> {
    return new FrameWalker(await openWalkSource(source));
  }

  get metadata(): FrameWalkMetadata {
    const { track } = this.handle;
    return {
      durationS: track.durationS,
      width: track.width,
      height: track.height,
      nativeFps: track.nativeFps,
      firstTimestampS: track.firstTimestampS,
    };
  }

  async *walkFrames(
    range: FrameWalkRange = {},
  ): AsyncGenerator<WalkedFrame, void, unknown> {
    if (this.closed) return;
    const walk = walkFrames(this.handle, range);
    try {
      for (let next = await walk.next(); !next.done; next = await walk.next()) {
        if (this.closed) {
          next.value.sample.close();
          return;
        }
        yield next.value;
      }
    } catch (error) {
      // A concurrent close() disposes the source mid-decode; that teardown
      // ends the walk and is not a decode failure.
      if (!this.closed) throw error;
    } finally {
      await walk.return();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.handle.dispose();
  }
}
