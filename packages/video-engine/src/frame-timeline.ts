import { asSec, type Sec } from "./types";

/** Ticks per second, from the container's own timing grain. */
export type TickRate = number;

/**
 * A frame of the source, named twice: by its position in presentation order and
 * by its presentation timestamp in the track's own integer grain.
 */
export interface FrameId {
  readonly index: number;
  readonly ticks: number;
}

/**
 * Where the transport has settled: the frame, and the one seconds value anyone
 * publishes for it. Nothing else on the wire carries a media position.
 */
export interface FrameLanding {
  readonly frame: FrameId;
  readonly mediaTimeS: number;
}

/** The clone-safe shape the timeline crosses a worker boundary as. */
export interface FrameTimelineData {
  readonly tickRate: TickRate;
  readonly ticks: Float64Array;
  readonly lastDurationTicks: number;
}

/**
 * One entry per presentation instant.
 *
 * A container may carry several coded pictures on one timestamp, and they
 * occupy no time between them: a decode for that instant answers with a single
 * picture, so the rest are frames no reader can reach or name. Counting them
 * would leave a step across the group moving the picture nowhere, and a search
 * for a time inside it answering with the group's last entry whatever it was
 * asked.
 */
function oneEntryPerInstant(data: FrameTimelineData): FrameTimelineData {
  const { ticks } = data;
  let at = 1;
  while (at < ticks.length && ticks[at] !== ticks[at - 1]) at += 1;
  if (at === ticks.length) return data;
  const distinct = new Float64Array(ticks.length);
  distinct.set(ticks.subarray(0, at));
  let size = at;
  for (let i = at + 1; i < ticks.length; i += 1) {
    if (ticks[i] === distinct[size - 1]) continue;
    distinct[size] = ticks[i];
    size += 1;
  }
  return { ...data, ticks: distinct.slice(0, size) };
}

/**
 * Every real frame of one track, in presentation order, by its container tick
 * timestamp.
 *
 * A container states its timestamps as integer multiples of 1/tickRate, so a
 * frame's tick count is exact and comparisons between two readers of the same
 * container are integer comparisons. `timeAt` is the same division of the same
 * two integers the demuxer itself performs, which is what lets a consumer
 * holding only seconds match a producer's frame with `===`.
 */
export class FrameTimeline {
  private readonly ticksArray: Float64Array;

  private constructor(private readonly data: FrameTimelineData) {
    this.ticksArray = data.ticks;
  }

  static from(data: FrameTimelineData): FrameTimeline {
    if (data.ticks.length === 0) {
      throw new RangeError(
        "FrameTimeline: a track with no frames has no timeline",
      );
    }
    if (!(data.tickRate > 0)) {
      throw new RangeError(
        `FrameTimeline: tick rate ${data.tickRate} is not positive`,
      );
    }
    return new FrameTimeline(oneEntryPerInstant(data));
  }

  /** A synthetic constant-rate table. Tests and fakes only. The default tick
   *  rate is a whole multiple of `fps`, so no test table needs rounding. */
  static uniform(
    fps: number,
    frameCount: number,
    tickRate: TickRate = fps * 1000,
  ): FrameTimeline {
    const step = tickRate / fps;
    const ticks = Float64Array.from(
      { length: frameCount },
      (_, index) => index * step,
    );
    return FrameTimeline.from({ lastDurationTicks: step, tickRate, ticks });
  }

  get tickRate(): TickRate {
    return this.data.tickRate;
  }

  get frameCount(): number {
    return this.ticksArray.length;
  }

  toData(): FrameTimelineData {
    return this.data;
  }

  ticksAt(index: number): number {
    return this.ticksArray[this.clampIndex(index)];
  }

  timeAt(index: number): Sec {
    return asSec(this.ticksAt(index) / this.data.tickRate);
  }

  idAt(index: number): FrameId {
    const at = this.clampIndex(index);
    return { index: at, ticks: this.ticksArray[at] };
  }

  landingAt(index: number): FrameLanding {
    const at = this.clampIndex(index);
    return { frame: this.idAt(at), mediaTimeS: this.timeAt(at) };
  }

  /** Ticks the frame at `index` ends at, which is where the next one starts. */
  endTicksAt(index: number): number {
    const at = this.clampIndex(index);
    return at + 1 < this.ticksArray.length
      ? this.ticksArray[at + 1]
      : this.ticksArray[at] + this.data.lastDurationTicks;
  }

  /**
   * The frame covering `timeS`, which is what a decode for it returns.
   *
   * The comparison divides, as `timeAt` does, so a frame's own published
   * second answers with that frame.
   */
  indexAtOrBefore(timeS: number): number {
    let low = 0;
    let high = this.ticksArray.length - 1;
    let found = 0;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (this.ticksArray[mid] / this.data.tickRate <= timeS) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return found;
  }

  /**
   * The frame a decoded sample is.
   *
   * A decoded timestamp has been through the WebCodecs microsecond plane, so
   * it can miss its own tick by up to half a microsecond. Snapping to the
   * nearer neighbour absorbs that by four orders of magnitude, since the
   * narrowest real frame gap measured across the fixtures is 31667 us.
   */
  indexOfDecoded(timeS: number): number {
    const wanted = Math.round(timeS * this.data.tickRate);
    const at = this.indexAtOrBefore(wanted / this.data.tickRate);
    const next = at + 1;
    if (next >= this.ticksArray.length) return at;
    return wanted - this.ticksArray[at] <= this.ticksArray[next] - wanted
      ? at
      : next;
  }

  private clampIndex(index: number): number {
    if (index < 0) return 0;
    const last = this.ticksArray.length - 1;
    return index > last ? last : index;
  }
}
