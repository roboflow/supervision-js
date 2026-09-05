/**
 * Two-tier frame cache.
 *
 * The preview tier holds many downscaled frames: a long, coarse history that
 * answers a scrub instantly while the crisp frame decodes. The exact tier holds
 * a few full-resolution frames, bounded by a RAM budget rather than a fixed
 * count so the slot count tracks frame size.
 *
 * A lookup prefers exact, then preview, tagging the hit with the tier that
 * served it. Only an exact hit is full-resolution; a preview hit still owes the
 * caller a crisp decode.
 *
 * The exact tier is keyed by the timeline's identity for the frame, so two
 * source frames can never share a slot at any frame rate. The preview tier is
 * keyed by rounded millisecond, which merges frames spaced under a millisecond;
 * it is the tier whose answer is already declared approximate, and it never
 * claims to be the frame at the target.
 *
 * Both tiers store OffscreenCanvas blits, never VideoFrames: a raw-frame cache
 * pins decoder output, stalling the decoder and growing VRAM without bound. A
 * frame fed as a live VideoSample is drawn into the blit and never retained, so
 * the no-retention rule holds on the zero-copy path too.
 */

import type { FrameId } from "./frame-timeline";
import type { VideoSampleLike } from "./scrub-cursor";

/** RGBA bytes per cached pixel, used to turn a RAM budget into a slot count. */
const BYTES_PER_PIXEL = 4;

/** Width of the grid the preview tier's keys land on, since `putPreview` keys
 *  by rounded millisecond. */
const PREVIEW_KEY_GRID_MS = 1;

/** The exact tier's keys are frame identities, which are not times, so no two
 *  of them can name one frame. */
const FRAME_IDENTITY_KEY_GRID_MS = 0;

/**
 * What the cache can blit into a tier: an already-decoded canvas/image, or a
 * live VideoSample it draws once and never retains. The sample's draw scales to
 * the tier size just like drawImage does, so the stored blit is identical either
 * way.
 */
export type CacheBlitSource = CanvasImageSource | VideoSampleLike;

/** A VideoSampleLike exposes draw(); a CanvasImageSource does not. */
function isSample(src: CacheBlitSource): src is VideoSampleLike {
  return "draw" in src;
}

export enum FrameTier {
  Exact = "exact",
  Preview = "preview",
}

export interface CachedFrame {
  readonly canvas: OffscreenCanvas;
  readonly timestampMs: number;
  readonly tier: FrameTier;
}

export interface FrameCacheStats {
  readonly exactHits: number;
  readonly previewHits: number;
  readonly misses: number;
  readonly exactSize: number;
  readonly previewSize: number;
  readonly exactCapacity: number;
  readonly previewCapacity: number;
  /** True timestamps (ms) currently resident in each tier, for the diagnostics
   *  timeline. Bounded by capacity, so a small array per poll. */
  readonly exactTimestampsMs: number[];
  readonly previewTimestampsMs: number[];
  /** Configured source frame interval: the visual width of each cached mark on
   *  the timeline. Nothing is keyed by it, so this is a display width and not
   *  the grid entries land on. */
  readonly bucketMs: number;
  /** Frames dropped to LRU pressure per tier, and puts that overwrote a live
   *  key: a frame decoded again on the exact tier, and on the preview tier
   *  either that or two frames sharing one rounded millisecond. */
  readonly exactEvictions: number;
  readonly previewEvictions: number;
  readonly bucketCollapses: number;
  /** Per-tier frame dimensions and the crisp tier's RAM ceiling, so a consumer
   *  can derive resident bytes (size x w x h x 4) and the budget fill. */
  readonly exactFrameWidth: number;
  readonly exactFrameHeight: number;
  readonly previewFrameWidth: number;
  readonly previewFrameHeight: number;
  readonly exactBudgetBytes: number;
}

export interface FrameCacheOptions {
  /** Crisp-tier frame size, the cursor's decode resolution. */
  readonly exactWidth: number;
  readonly exactHeight: number;
  /** Coarse-tier width; height derives from the exact aspect ratio. */
  readonly previewWidth: number;
  /** Crisp scrub-tier RAM ceiling in bytes; slot count derives from frame size. */
  readonly exactBudgetBytes: number;
  /** Coarse-tier slot count. */
  readonly previewCapacity: number;
  /** Source frame interval in ms, reported to diagnostics as the timeline mark
   *  width. It keys nothing. */
  readonly bucketMs: number;
  /** Floor on exact-tier slots, applied even when the byte budget would yield
   *  fewer. Lets a caller that owns the prefetch-window width guarantee a full
   *  window fits regardless of frame size. The cache stays ignorant of the
   *  window; it only honors the number it is handed. */
  readonly minExactSlots?: number;
}

export class FrameCache {
  private readonly exact: TierStore;
  private readonly preview: TierStore;
  private exactHits = 0;
  private previewHits = 0;
  private misses = 0;
  private readonly bucketMs: number;
  private readonly exactBudgetBytes: number;

  constructor(options: FrameCacheOptions) {
    const exactWidth = Math.max(1, Math.round(options.exactWidth));
    const exactHeight = Math.max(1, Math.round(options.exactHeight));
    const aspect = exactWidth / exactHeight;
    const previewWidth = Math.max(1, Math.round(options.previewWidth));
    const previewHeight = Math.max(1, Math.round(previewWidth / aspect));
    const frameBytes = exactWidth * exactHeight * BYTES_PER_PIXEL;
    const floor = Math.max(1, Math.floor(options.minExactSlots ?? 1));
    const exactCapacity =
      options.exactBudgetBytes <= 0
        ? 0
        : Math.max(floor, Math.floor(options.exactBudgetBytes / frameBytes));
    this.bucketMs = Math.max(1, Math.round(options.bucketMs));
    // When the slot floor outgrows the byte budget, the resident bytes can
    // exceed the configured ceiling. Report the larger of the two as the
    // budget so the fill percentage stays an honest <=100% rather than
    // pretending the floor's frames fit a smaller budget.
    this.exactBudgetBytes = Math.max(
      Math.max(0, options.exactBudgetBytes),
      exactCapacity * frameBytes,
    );
    this.exact = new TierStore(
      exactCapacity,
      exactWidth,
      exactHeight,
      FRAME_IDENTITY_KEY_GRID_MS,
    );
    this.preview = new TierStore(
      Math.max(0, Math.floor(options.previewCapacity)),
      previewWidth,
      previewHeight,
      PREVIEW_KEY_GRID_MS,
    );
  }

  /**
   * Store a crisp full-resolution frame for the exact (scrub) tier under
   * `frame`, the timeline's name for it. `timestampMs` is the decoded
   * timestamp, which is what lookups match on and what a hit reports back.
   */
  putExact(
    frame: FrameId,
    timestampMs: number,
    src: CacheBlitSource,
    srcWidth: number,
    srcHeight: number,
  ): void {
    this.exact.put(frame.ticks, timestampMs, src, srcWidth, srcHeight);
  }

  /** Store a downscaled frame for the coarse preview tier. */
  putPreview(
    timestampMs: number,
    src: CacheBlitSource,
    srcWidth: number,
    srcHeight: number,
  ): void {
    this.preview.put(
      Math.round(timestampMs),
      timestampMs,
      src,
      srcWidth,
      srcHeight,
    );
  }

  /**
   * Best cached answer for a named source frame. The exact tier is looked up
   * only by `frame` identity; time is used solely for the approximate preview
   * fallback. This keeps a long variable-rate frame from borrowing a crisp
   * neighbour merely because both timestamps fit a millisecond tolerance.
   */
  getForFrame(
    frame: FrameId,
    timestampMs: number,
    previewTolMs: number,
  ): CachedFrame | null {
    const exact = this.exact.getByKey(frame.ticks);
    if (exact) {
      this.exactHits += 1;
      return { ...exact, tier: FrameTier.Exact };
    }
    const coarse = this.preview.get(timestampMs, previewTolMs);
    if (coarse) {
      this.previewHits += 1;
      return { ...coarse, tier: FrameTier.Preview };
    }
    this.misses += 1;
    return null;
  }

  /** Non-accounting form of {@link getForFrame}. */
  peekForFrame(
    frame: FrameId,
    timestampMs: number,
    previewTolMs: number,
  ): CachedFrame | null {
    const exact = this.exact.getByKey(frame.ticks);
    if (exact) return { ...exact, tier: FrameTier.Exact };
    const coarse = this.preview.get(timestampMs, previewTolMs);
    return coarse ? { ...coarse, tier: FrameTier.Preview } : null;
  }

  /**
   * Best cached frame for `timestampMs`, consulting the exact tier then the
   * preview tier: a crisp hit within `exactTolMs`, else a coarse hit within
   * `previewTolMs`, else null. The two tolerances differ because the exact tier
   * is keyed per source frame while the preview tier may only hold sparse
   * keyframes.
   *
   * `exactTolMs` is an upper bound, not the reach: a crisp hit is also held to
   * the frame span the exact tier has observed, since a tolerance wider than
   * one frame (50ms is, at every rate from 24 to 60fps) would let a neighbour
   * answer as the exact frame.
   */
  get(
    timestampMs: number,
    exactTolMs: number,
    previewTolMs: number,
  ): CachedFrame | null {
    const exact = this.exact.get(timestampMs, exactTolMs, true);
    if (exact) {
      this.exactHits += 1;
      return {
        canvas: exact.canvas,
        timestampMs: exact.timestampMs,
        tier: FrameTier.Exact,
      };
    }
    const coarse = this.preview.get(timestampMs, previewTolMs);
    if (coarse) {
      this.previewHits += 1;
      return {
        canvas: coarse.canvas,
        timestampMs: coarse.timestampMs,
        tier: FrameTier.Preview,
      };
    }
    this.misses += 1;
    return null;
  }

  /**
   * Same lookup as get() but without touching the hit/miss accounting. The
   * synchronous render-loop peek and the authoritative seek both hit the cache
   * for one user gesture; counting both double-books every scrub. The peek
   * uses this so only the seek's get() is tallied, keeping the hit-rate a
   * per-lookup rate rather than two-per-gesture.
   */
  peek(
    timestampMs: number,
    exactTolMs: number,
    previewTolMs: number,
  ): CachedFrame | null {
    const exact = this.exact.get(timestampMs, exactTolMs, true);
    if (exact) {
      return {
        canvas: exact.canvas,
        timestampMs: exact.timestampMs,
        tier: FrameTier.Exact,
      };
    }
    const coarse = this.preview.get(timestampMs, previewTolMs);
    if (coarse) {
      return {
        canvas: coarse.canvas,
        timestampMs: coarse.timestampMs,
        tier: FrameTier.Preview,
      };
    }
    return null;
  }

  /**
   * Marks the exact entry nearest `timestampMs` as most-recently-used without
   * counting a hit. Lets the scheduler protect the just-shown center frame
   * from being the LRU victim of its own neighbor sweep. No-op on a miss.
   */
  bumpExact(timestampMs: number): void {
    this.exact.touch(timestampMs);
  }

  /** Promotes one exact frame by identity. */
  bumpExactFrame(frame: FrameId): void {
    this.exact.touchKey(frame.ticks);
  }

  clear(): void {
    this.exact.clear();
    this.preview.clear();
  }

  get stats(): FrameCacheStats {
    return {
      exactHits: this.exactHits,
      previewHits: this.previewHits,
      misses: this.misses,
      exactSize: this.exact.size,
      previewSize: this.preview.size,
      exactCapacity: this.exact.capacity,
      previewCapacity: this.preview.capacity,
      exactTimestampsMs: this.exact.timestampsSnapshot(),
      previewTimestampsMs: this.preview.timestampsSnapshot(),
      bucketMs: this.bucketMs,
      exactEvictions: this.exact.evictions,
      previewEvictions: this.preview.evictions,
      bucketCollapses:
        this.exact.bucketCollapses + this.preview.bucketCollapses,
      exactFrameWidth: this.exact.width,
      exactFrameHeight: this.exact.height,
      previewFrameWidth: this.preview.width,
      previewFrameHeight: this.preview.height,
      exactBudgetBytes: this.exactBudgetBytes,
    };
  }
}

interface TierHit {
  readonly canvas: OffscreenCanvas;
  readonly timestampMs: number;
}

/** A stored frame: its copied canvas plus the true timestamp that produced it. */
interface TierEntry {
  readonly canvas: OffscreenCanvas;
  timestampMs: number;
}

/**
 * One cache tier: a fixed-capacity, MRU-ordered set of OffscreenCanvas copies
 * under keys its owner assigns. A put onto a live key overwrites that slot in
 * place, so an owner that lets two frames share a key loses one of them
 * silently; overflow past capacity evicts the least-recently-used entry
 * instead. Lookups match on the stored frame's true timestamp and never on the
 * key, so a cache-served frame carries the same timestamp a fresh decode would.
 */
export class TierStore {
  /** MRU-ordered keys. Index 0 is the LRU, the last index is the MRU. */
  private readonly keys: number[] = [];
  private readonly entries = new Map<number, TierEntry>();
  /** Canvases released by eviction, held for the next put to fill. */
  private readonly spare: OffscreenCanvas[] = [];
  private evictionCount = 0;
  private bucketCollapseCount = 0;

  /** Smallest gap between two stored frames, which is the source frame interval
   *  once neighbours are resident. Learned from the timestamps the tier is
   *  handed, so it is what the source really did rather than a declared rate.
   *  Null until two frames have landed. */
  private observedIntervalMs: number | null = null;

  constructor(
    readonly capacity: number,
    readonly width: number,
    readonly height: number,
    /** Width of the grid the owner's keys round onto, or 0 when a key names a
     *  frame outright. Two entries closer together than this are one frame
     *  whose two decodes rounded onto either side of a key boundary. */
    private readonly keyGridMs: number,
  ) {}

  /** Frames dropped to the LRU policy; a cache-pressure signal for diagnostics. */
  get evictions(): number {
    return this.evictionCount;
  }

  /** Puts that landed on a key already live, collapsing both onto one slot. */
  get bucketCollapses(): number {
    return this.bucketCollapseCount;
  }

  put(
    key: number,
    timestampMs: number,
    src: CacheBlitSource,
    srcWidth: number,
    srcHeight: number,
  ): void {
    // capacity 0 is the disabled-tier shape; skip the OffscreenCanvas alloc.
    if (this.capacity === 0) return;
    const existing = this.entries.get(key);
    // Allocating an accelerated canvas at these sizes costs several times the
    // blit that fills it, so an evicted slot's canvas is reused rather than
    // freed and reallocated on the next put.
    const canvas =
      existing?.canvas ??
      this.spare.pop() ??
      new OffscreenCanvas(this.width, this.height);
    // Cached frames are opaque video; alpha:false skips per-pixel blend.
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;
    ctx.clearRect(0, 0, this.width, this.height);
    // A live sample draws (and scales) itself into the blit and is never
    // retained; a canvas/image goes through drawImage. Either way the stored
    // pixels are the tier-sized blit, not the source.
    if (isSample(src)) {
      src.draw(ctx, 0, 0, this.width, this.height);
    } else {
      ctx.drawImage(
        src,
        0,
        0,
        srcWidth,
        srcHeight,
        0,
        0,
        this.width,
        this.height,
      );
    }
    if (existing) {
      existing.timestampMs = timestampMs;
      this.bump(key);
      this.bucketCollapseCount += 1;
    } else {
      this.observeSpacing(timestampMs);
      this.entries.set(key, { canvas, timestampMs });
      this.keys.push(key);
      if (this.keys.length > this.capacity) {
        const lru = this.keys.shift();
        if (lru !== undefined) {
          const dropped = this.entries.get(lru);
          this.entries.delete(lru);
          if (dropped) this.spare.push(dropped.canvas);
          this.evictionCount += 1;
        }
      }
    }
  }

  /**
   * Nearest resident frame to `timestampMs` within `tolMs`, or null.
   *
   * `atOrBefore` restricts it to frames at or before the target, which is the
   * contract a decode answers a seek with. Without it the tier can answer with
   * the frame AFTER the target, one no decode would ever return, so the same
   * pointer position paints a different frame depending on whether the cache or
   * the decoder served it, and the picture steps forward and back as the two
   * alternate.
   */
  get(timestampMs: number, tolMs: number, atOrBefore = false): TierHit | null {
    const best = this.nearest(timestampMs, atOrBefore);
    if (!best || best.delta > tolMs) return null;
    const entry = this.entries.get(best.key);
    if (!entry) return null;
    this.bump(best.key);
    return { canvas: entry.canvas, timestampMs: entry.timestampMs };
  }

  /** Retrieves exactly one owner-assigned key and promotes it to MRU. */
  getByKey(key: number): TierHit | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.bump(key);
    return { canvas: entry.canvas, timestampMs: entry.timestampMs };
  }

  /** Promotes the entry nearest `timestampMs` to most-recently-used. Scans
   *  rather than keys off the timestamp: callers pass a gesture position, which
   *  is not a frame timestamp, so a keyed lookup would miss the very frame on
   *  screen. No accounting; it is not a lookup. */
  touch(timestampMs: number): void {
    const best = this.nearest(timestampMs, false);
    if (best) this.bump(best.key);
  }

  /** Promotes an owner-assigned key without a timestamp scan. */
  touchKey(key: number): void {
    if (this.entries.has(key)) this.bump(key);
  }

  clear(): void {
    this.keys.length = 0;
    this.entries.clear();
    this.spare.length = 0;
    this.observedIntervalMs = null;
  }

  get size(): number {
    return this.keys.length;
  }

  /** True timestamps (ms) of resident frames, for diagnostics. Bounded by capacity. */
  timestampsSnapshot(): number[] {
    return Array.from(this.entries.values(), (entry) => entry.timestampMs);
  }

  private bump(key: number): void {
    const idx = this.keys.indexOf(key);
    if (idx === -1 || idx === this.keys.length - 1) return;
    this.keys.splice(idx, 1);
    this.keys.push(key);
  }

  /**
   * Best candidate for `timestampMs`, or null when nothing qualifies.
   *
   * Under `atOrBefore` a stored frame stands for the span from its own
   * timestamp up to the next source frame; a target past that span belongs to
   * the next frame, which is what a decode for it returns. Answering it from
   * this tier would paint a frame no decode for that time ever produces, so a
   * candidate outside its own frame's span is not eligible however generous the
   * caller's tolerance is. Until the tier has learned a frame gap it has no
   * spacing to bound with and the caller's tolerance stands alone.
   */
  private nearest(
    timestampMs: number,
    atOrBefore: boolean,
  ): { key: number; delta: number } | null {
    const spanMs = atOrBefore
      ? (this.observedIntervalMs ?? Infinity)
      : Infinity;
    let bestKey: number | null = null;
    let bestDelta = Infinity;
    for (const key of this.keys) {
      const entry = this.entries.get(key);
      if (!entry) continue;
      // Against the frame's real timestamp, not its key: a key names the
      // frame, and nothing says it is a time at all.
      if (atOrBefore && entry.timestampMs > timestampMs) continue;
      const delta = Math.abs(entry.timestampMs - timestampMs);
      if (delta >= spanMs) continue;
      if (delta < bestDelta) {
        bestDelta = delta;
        bestKey = key;
      }
    }
    return bestKey === null ? null : { key: bestKey, delta: bestDelta };
  }

  /** Narrows the learned frame interval to the smallest gap seen so far. A gap
   *  at or below the key grid is one frame that rounded onto two keys rather
   *  than two frames, so it is no interval at all; what survives is a gap
   *  between two frames, and never zero. It only ever tightens, so a tier that
   *  has watched an unrepresentative stretch of a variable-rate source bounds
   *  lookups too tightly (a decode) rather than too loosely (the wrong frame). */
  private observeSpacing(timestampMs: number): void {
    for (const entry of this.entries.values()) {
      const gap = Math.abs(entry.timestampMs - timestampMs);
      if (gap <= this.keyGridMs) continue;
      if (this.observedIntervalMs === null || gap < this.observedIntervalMs) {
        this.observedIntervalMs = gap;
      }
    }
  }
}
