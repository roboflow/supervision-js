import type { Sec } from "./types";

const DEFAULT_SAMPLE_CAPACITY = 8;

/** Samples a gesture needs before its direction is asserted at all. Two
 *  describe a single step, and a heading change resets the ring to one, so two
 *  is exactly what a stray backward pixel leaves behind. */
const MIN_SAMPLES_FOR_HEADING = 3;

/**
 * Reads which way a scrub gesture is travelling, so a prefetch window can spend
 * its budget on the side of the playhead the hand is moving toward.
 *
 * The heading spans a bounded ring of recent samples, so one jittery pointer
 * move cannot swing it. A step opposing the ring's heading drops the samples
 * behind it, leaving the reversal as the only evidence of where the gesture is
 * going.
 */
export class ScrubTrajectory {
  private readonly capacity: number;
  private readonly positionsS: Float64Array;
  private readonly timesMs: Float64Array;
  private count = 0;
  private writeIndex = 0;

  constructor(capacity: number = DEFAULT_SAMPLE_CAPACITY) {
    this.capacity = Math.max(2, Math.floor(capacity));
    this.positionsS = new Float64Array(this.capacity);
    this.timesMs = new Float64Array(this.capacity);
  }

  sample(positionS: Sec, atMs: number): void {
    if (this.count > 0) {
      const latest = this.indexFromNewest(0);
      // A clock that has not advanced would divide the step by a zero interval.
      if (atMs <= this.timesMs[latest]) {
        this.positionsS[latest] = positionS;
        return;
      }
      // The samples behind a heading change describe a gesture that is over;
      // keeping them in keeps reporting the direction the hand left.
      //
      // Only against an established heading, though. Right after a reset
      // the ring holds the reversing step and nothing else, so the net
      // displacement IS that step: the hand resuming its original direction
      // then reads as a second reversal and resets again, and a single
      // twitch can suppress the heading for the rest of the gesture. With a
      // heading behind it, the third sample joins the ring and the evidence
      // decides instead: resuming forward outweighs the twitch, a real
      // reversal does not.
      if (
        this.count >= MIN_SAMPLES_FOR_HEADING &&
        (positionS - this.positionsS[latest]) * this.netDisplacementS() < 0
      ) {
        this.count = 1;
      }
    }
    this.positionsS[this.writeIndex] = positionS;
    this.timesMs[this.writeIndex] = atMs;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    if (this.count < this.capacity) this.count += 1;
  }

  /**
   * Which way the gesture is travelling: 1 forward, -1 backward, 0 when there
   * is not enough of a gesture to say. The direction survives being uncertain
   * about how far, which is all a window split needs.
   */
  heading(): -1 | 0 | 1 {
    // A direction taken from two samples is a direction taken from one step,
    // which jitter alone can produce.
    if (this.count < MIN_SAMPLES_FOR_HEADING) return 0;
    const net = this.netDisplacementS();
    if (net > 0) return 1;
    if (net < 0) return -1;
    return 0;
  }

  reset(): void {
    this.count = 0;
    this.writeIndex = 0;
  }

  private netDisplacementS(): number {
    return (
      this.positionsS[this.indexFromNewest(0)] -
      this.positionsS[this.indexFromOldest(0)]
    );
  }

  private indexFromNewest(back: number): number {
    return (this.writeIndex - 1 - back + this.capacity) % this.capacity;
  }

  private indexFromOldest(forward: number): number {
    return (
      (this.writeIndex - this.count + forward + this.capacity) % this.capacity
    );
  }
}
