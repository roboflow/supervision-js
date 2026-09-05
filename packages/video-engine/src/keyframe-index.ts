/**
 * Lazy index of a video track's keyframe timestamps, in seconds.
 *
 * Seeking decodes forward from the keyframe at-or-before the target, so every
 * seek needs that anchor. Resolving one costs a container round-trip, so the
 * index remembers each keyframe it discovers; repeated seeks around the same
 * region then resolve synchronously through `cachedAtOrBefore`.
 */

/**
 * Opaque packet handle. Only `timestamp` is read; the object is threaded back
 * into `getNextKeyPacket` unchanged so the probe's hidden packet fields survive.
 */
export interface KeyframePacketLike {
  readonly timestamp: number;
}

interface KeyframeRetrievalOptions {
  readonly metadataOnly?: boolean;
}

/** The slice of mediabunny's `EncodedPacketSink` the index depends on. */
export interface KeyframeProbe {
  getKeyPacket(
    timestamp: number,
    options?: KeyframeRetrievalOptions,
  ): Promise<KeyframePacketLike | null>;
  getNextKeyPacket(
    packet: KeyframePacketLike,
    options?: KeyframeRetrievalOptions,
  ): Promise<KeyframePacketLike | null>;
}

// Only timestamps are read, never frame bytes, so every probe is metadata-only.
const METADATA_ONLY: KeyframeRetrievalOptions = { metadataOnly: true };

/**
 * Distribution of the gaps between discovered keyframes, in seconds. A long
 * maxGopS (or a high stddev) is the badly-encoded-source tell: an off-anchor
 * seek must decode forward from the prior keyframe, so a long GOP is a wall of
 * frames every scrub pays for. Zeros when fewer than two keyframes are known.
 */
export interface GopStats {
  readonly count: number;
  readonly avgGopS: number;
  readonly maxGopS: number;
  readonly minGopS: number;
  readonly stddevS: number;
  readonly densityPerS: number;
}

export class KeyframeIndex {
  private readonly times: number[] = [];
  private probeRoundTrips = 0;
  /** Set once a full walk has completed, so a second call is a free no-op. */
  private fullyIndexed = false;

  constructor(private readonly probe: KeyframeProbe) {}

  /** Keyframe timestamps discovered so far, ascending and deduplicated. */
  get known(): readonly number[] {
    return this.times;
  }

  /** Container queries the index has made; the rest resolve from memory. */
  get probeCount(): number {
    return this.probeRoundTrips;
  }

  /**
   * GOP-gap distribution over the keyframes discovered so far. Pass the track
   * duration so density reflects keyframes across the whole clip, not just the
   * clustered swept span; without it a few discovered keyframes in one region
   * would read as a high density that does not hold track-wide.
   */
  gopStats(durationS?: number): GopStats {
    const t = this.times;
    const n = t.length;
    if (n < 2) {
      return {
        count: n,
        avgGopS: 0,
        maxGopS: 0,
        minGopS: 0,
        stddevS: 0,
        densityPerS: 0,
      };
    }
    const gaps = n - 1;
    let sum = 0;
    let max = -Infinity;
    let min = Infinity;
    for (let i = 1; i < n; i++) {
      const gap = t[i] - t[i - 1];
      sum += gap;
      if (gap > max) max = gap;
      if (gap < min) min = gap;
    }
    const avg = sum / gaps;
    let variance = 0;
    for (let i = 1; i < n; i++) {
      const d = t[i] - t[i - 1] - avg;
      variance += d * d;
    }
    const span = durationS && durationS > 0 ? durationS : t[n - 1] - t[0];
    return {
      count: n,
      avgGopS: avg,
      maxGopS: max,
      minGopS: min,
      stddevS: Math.sqrt(variance / gaps),
      densityPerS: span > 0 ? gaps / span : 0,
    };
  }

  /**
   * Nearest keyframe at or before `tSec`, the anchor a seek decodes forward
   * from. Null when `tSec` precedes the first keyframe.
   */
  async keyframeAtOrBefore(tSec: number): Promise<number | null> {
    this.probeRoundTrips++;
    const packet = await this.probe.getKeyPacket(tSec, METADATA_ONLY);
    if (!packet) return null;
    this.record(packet.timestamp);
    return packet.timestamp;
  }

  /**
   * First keyframe strictly after `tSec`, the boundary a forward decode runs
   * up to. Null when no keyframe follows, or when `tSec` precedes the first
   * keyframe (no anchor to step from).
   */
  async nextKeyframeAfter(tSec: number): Promise<number | null> {
    this.probeRoundTrips++;
    const anchor = await this.probe.getKeyPacket(tSec, METADATA_ONLY);
    if (!anchor) return null;
    this.record(anchor.timestamp);
    this.probeRoundTrips++;
    const next = await this.probe.getNextKeyPacket(anchor, METADATA_ONLY);
    if (!next) return null;
    this.record(next.timestamp);
    return next.timestamp;
  }

  /**
   * Every keyframe needed to decode the window `[startS, endS]`: the anchor at
   * or before `startS` plus each keyframe up to `endS`. Empty when `startS`
   * precedes the first keyframe.
   */
  async keyframesCovering(
    startS: number,
    endS: number,
  ): Promise<readonly number[]> {
    this.probeRoundTrips++;
    let packet = await this.probe.getKeyPacket(startS, METADATA_ONLY);
    if (!packet) return [];
    const covering: number[] = [];
    while (packet && packet.timestamp <= endS) {
      this.record(packet.timestamp);
      covering.push(packet.timestamp);
      this.probeRoundTrips++;
      packet = await this.probe.getNextKeyPacket(packet, METADATA_ONLY);
    }
    return covering;
  }

  /**
   * Walks the whole track once, recording every keyframe timestamp. Metadata
   * only: it threads the same getKeyPacket / getNextKeyPacket pattern as the
   * lazy probes, so it never decodes a pixel. Idempotent: a second call after a
   * completed walk returns at once. Meant for the diagnostics lane, off the hot
   * seek path, so the purple lane reflects the whole file rather than only the
   * regions a scrub has visited.
   */
  async ensureFullyIndexed(fromS = 0): Promise<void> {
    if (this.fullyIndexed) return;
    this.probeRoundTrips++;
    let packet = await this.probe.getKeyPacket(fromS, METADATA_ONLY);
    while (packet) {
      this.record(packet.timestamp);
      this.probeRoundTrips++;
      packet = await this.probe.getNextKeyPacket(packet, METADATA_ONLY);
    }
    this.fullyIndexed = true;
  }

  /**
   * Largest discovered keyframe at or before `tSec`, resolved synchronously
   * from memory. Null when nothing at or before `tSec` has been discovered
   * yet; callers fall back to the async probes above.
   */
  cachedAtOrBefore(tSec: number): number | null {
    const i = floorIndex(this.times, tSec);
    return i < 0 ? null : this.times[i];
  }

  private record(t: number): void {
    const i = lowerBound(this.times, t);
    if (i < this.times.length && this.times[i] === t) return;
    this.times.splice(i, 0, t);
  }
}

/** First index whose value is `>= target` (insertion point for `target`). */
function lowerBound(values: readonly number[], target: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Largest index whose value is `<= target`, or -1 when all exceed `target`. */
function floorIndex(values: readonly number[], target: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid] <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}
