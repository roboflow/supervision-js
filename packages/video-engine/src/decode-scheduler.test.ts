import { beforeAll, describe, expect, it, vi, type Mock } from "vitest";

import { PLAYBACK, HANG_RECOVERY } from "./constants";
import { DecodeScheduler } from "./decode-scheduler";
import type {
  AnySourceHandle,
  CanvasFrameSource,
  DecodeSourceHandle,
  WrappedCanvasLike,
} from "./decode-source";
import type { SessionFrameSource } from "./decode-session";
import { FrameTimeline } from "./frame-timeline";
import { FrameCache } from "./frame-cache";
import { type KeyframePacketLike, type KeyframeProbe } from "./keyframe-index";
import {
  ScrubCursorState,
  type ScrubFrame,
  type ScrubTrackInfo,
  type VideoSampleLike,
} from "./scrub-cursor";
import { asSec, VideoEngineError, VideoEngineErrorCode } from "./types";
import { installWorkerGlobals } from "../test/fake-engine-deps";

beforeAll(() => {
  installWorkerGlobals();
});

const TRACK: ScrubTrackInfo = {
  width: 320,
  height: 180,
  decodeWidth: 320,
  decodeHeight: 180,
  rotation: 0,
  nativeFps: 30,
  durationS: asSec(10),
  firstTimestampS: asSec(0),
  timeline: FrameTimeline.uniform(30, 1000),
};

const TIMELINE = TRACK.timeline;

/** Drawable handle; the fake 2D context ignores it, so any shape works. */
const SRC = { width: 320, height: 180 } as unknown as OffscreenCanvas;

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function makeWrapped(timestamp: number): WrappedCanvasLike {
  return { canvas: SRC, timestamp };
}

/**
 * Fake CanvasSink: getCanvas echoes the requested time; canvases streams a
 * list; canvasesAtTimestamps echoes each requested timestamp (the prefetch path).
 */
class FakeSink implements CanvasFrameSource {
  readonly getCanvasCalls: number[] = [];
  readonly canvasesCalls: number[] = [];
  readonly atTimestampsCalls: number[] = [];

  constructor(
    private readonly frames: number[] = [],
    /** Awaited inside each foreground decode, so a test can hold one open
     *  while the gesture moves on: what a drag outrunning the decoder does. */
    private readonly gate:
      ((timestampS: number) => Promise<void>) | null = null,
  ) {}

  async getCanvas(timestampS: number): Promise<WrappedCanvasLike | null> {
    this.getCanvasCalls.push(timestampS);
    if (this.gate) await this.gate(timestampS);
    return makeWrapped(timestampS);
  }

  async *canvases(
    startS: number,
  ): AsyncGenerator<WrappedCanvasLike, void, unknown> {
    this.canvasesCalls.push(startS);
    for (const t of this.frames) {
      if (t >= startS) yield makeWrapped(t);
    }
  }

  async *canvasesAtTimestamps(
    timestamps: Iterable<number>,
  ): AsyncGenerator<WrappedCanvasLike | null, void, unknown> {
    for (const t of timestamps) {
      this.atTimestampsCalls.push(t);
      yield makeWrapped(t);
    }
  }
}

class FakeKeyframeProbe implements KeyframeProbe {
  constructor(private readonly keyframes: number[]) {}

  async getKeyPacket(timestamp: number): Promise<KeyframePacketLike | null> {
    let found: number | null = null;
    for (const k of this.keyframes) {
      if (k <= timestamp) found = k;
      else break;
    }
    return found === null ? null : { timestamp: found };
  }

  async getNextKeyPacket(
    packet: KeyframePacketLike,
  ): Promise<KeyframePacketLike | null> {
    const i = this.keyframes.indexOf(packet.timestamp);
    if (i === -1 || i + 1 >= this.keyframes.length) return null;
    return { timestamp: this.keyframes[i + 1] };
  }
}

function makeCache(): FrameCache {
  return new FrameCache({
    exactWidth: 320,
    exactHeight: 180,
    previewWidth: 160,
    exactBudgetBytes: 64 * 1024 * 1024,
    previewCapacity: 16,
    bucketMs: 33,
  });
}

/** A tier sized to exactly `slots` so the window clamp is observable. */
function makeCacheWithCapacity(slots: number): FrameCache {
  const frameBytes = 320 * 180 * 4;
  return new FrameCache({
    exactWidth: 320,
    exactHeight: 180,
    previewWidth: 160,
    exactBudgetBytes: slots * frameBytes,
    previewCapacity: 16,
    bucketMs: 33,
  });
}

interface Harness {
  scheduler: DecodeScheduler;
  sink: FakeSink;
  cache: FrameCache;
  disposed: Mock;
}

function setup(
  opts: {
    keyframes?: number[];
    frames?: number[];
    now?: () => number;
    cache?: FrameCache;
    gateDecode?: (timestampS: number) => Promise<void>;
    exactToleranceMs?: number;
    previewToleranceMs?: number;
  } = {},
): Harness {
  const sink = new FakeSink(opts.frames ?? [], opts.gateDecode ?? null);
  const probe = new FakeKeyframeProbe(opts.keyframes ?? [0, 2, 4, 6, 8]);
  const cache = opts.cache ?? makeCache();
  const disposed = vi.fn();
  const source: DecodeSourceHandle = {
    track: TRACK,
    sink,
    keyframeProbe: probe,
    dispose: async () => {
      disposed();
    },
  };
  const scheduler = new DecodeScheduler({
    source,
    cache,
    now: opts.now,
    exactToleranceMs: opts.exactToleranceMs,
    previewToleranceMs: opts.previewToleranceMs,
  });
  return { scheduler, sink, cache, disposed };
}

/** A clock advancing a fixed step per read, so a decode measures a real latency
 *  and the gesture samples that read it land at a known cadence. */
function tickingClock(stepMs: number): () => number {
  let t = 0;
  return () => (t += stepMs);
}

/** The prefetch batch one seek settles into. */
async function seekAndSweep(h: Harness, targetS: number): Promise<number[]> {
  const before = h.sink.atTimestampsCalls.length;
  h.scheduler.seekTo(asSec(targetS));
  await h.scheduler.whenSettled();
  return h.sink.atTimestampsCalls.slice(before);
}

/** Walks a drag through every position and returns the window the last one left. */
async function drag(h: Harness, positionsS: number[]): Promise<number[]> {
  let window: number[] = [];
  for (const p of positionsS) window = await seekAndSweep(h, p);
  return window;
}

function record(scheduler: DecodeScheduler): ScrubFrame[] {
  const frames: ScrubFrame[] = [];
  scheduler.subscribe((f) => frames.push(f));
  return frames;
}

describe("DecodeScheduler", () => {
  describe("foreground decode", () => {
    it("open seeds the first frame, emits it, and caches it", async () => {
      const { scheduler, sink, cache } = setup();
      const frames = record(scheduler);
      await scheduler.open();

      expect(sink.getCanvasCalls).toEqual([0]);
      expect(frames.map((f) => f.timestampS)).toEqual([0]);
      expect(cache.stats.exactSize).toBe(1);
      expect(scheduler.state).toBe(ScrubCursorState.Idle);
    });

    it("subscribe replays the most recent frame", async () => {
      const { scheduler } = setup();
      await scheduler.open();
      const late = record(scheduler);
      expect(late.map((f) => f.timestampS)).toEqual([0]);
    });

    it("peekCached is null on an empty region and hits after a decode", async () => {
      const { scheduler } = setup();
      expect(scheduler.peekCached(5000)).toBeNull();
      await scheduler.open();
      expect(scheduler.peekCached(0)).not.toBeNull();
    });

    it("a missed seek decodes, emits, and caches the crisp frame", async () => {
      const { scheduler, sink } = setup();
      await scheduler.open();
      const frames = record(scheduler);
      frames.length = 0;

      scheduler.seekTo(asSec(1));
      await scheduler.idle();

      expect(sink.getCanvasCalls).toEqual([0, 1]);
      expect(frames.map((f) => f.timestampS)).toEqual([1]);
      expect(frames[0].quality).toBe("exact");
      expect(scheduler.peekCached(1000)?.quality).toBe("exact");
    });

    it("a cached frame keeps the decoded timestamp, whole milliseconds or not", async () => {
      // A 1/600-timebase source lands frames off the millisecond grid, and a
      // cache-served paint is what most scrub positions read; a rounded entry
      // would publish a position no frame in the source has.
      const { scheduler, cache } = setup();
      await scheduler.open();

      scheduler.seekTo(asSec(1 / 3));
      await scheduler.idle();

      expect(cache.stats.exactTimestampsMs).toContain(1000 / 3);
    });

    it("a decode the drag outran paints when it gains on where the drag has reached", async () => {
      let release = (): void => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { scheduler } = setup({
        gateDecode: async (timestampS) => {
          if (timestampS === 2) await held;
        },
      });
      await scheduler.open();
      await scheduler.whenSettled();
      const frames = record(scheduler);
      frames.length = 0;

      scheduler.seekTo(asSec(2));
      await tick();
      // The hand moves on while the decode for 2 is still in flight, which
      // is what every pointer move during a drag does.
      scheduler.seekTo(asSec(5));
      release();
      await scheduler.idle();

      // The screen still holds the seed at 0, so 2 is nearer 5 than what is
      // up, and showing it walks the picture toward the hand.
      const decodedAt2 = frames.filter(
        (f) => f.timestampS === 2 && f.quality === "exact",
      );
      expect(decodedAt2).toHaveLength(1);
      expect(frames.map((f) => f.timestampS).at(-1)).toBe(5);
      expect(scheduler.peekCached(2000)).not.toBeNull();
    });

    it("a decode the drag outran stays off screen when the screen is already nearer", async () => {
      let release = (): void => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { scheduler } = setup({
        gateDecode: async (timestampS) => {
          if (timestampS === 2) await held;
        },
      });
      await scheduler.open();
      scheduler.seekTo(asSec(4.9));
      await scheduler.idle();
      const frames = record(scheduler);
      frames.length = 0;

      scheduler.seekTo(asSec(2));
      await tick();
      scheduler.seekTo(asSec(5));
      release();
      await scheduler.idle();

      const decodedAt2 = frames.filter(
        (f) => f.timestampS === 2 && f.quality === "exact",
      );
      expect(decodedAt2).toHaveLength(0);
      expect(frames.map((f) => f.timestampS).at(-1)).toBe(5);
      expect(scheduler.peekCached(2000)).not.toBeNull();
    });

    it("a jump the next jump outran never paints its intermediate decode", async () => {
      let release = (): void => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { scheduler } = setup({
        gateDecode: async (timestampS) => {
          if (timestampS === 2) await held;
        },
      });
      await scheduler.open();
      await scheduler.whenSettled();
      const frames = record(scheduler);
      frames.length = 0;

      scheduler.seekTo(asSec(2), "jump");
      await tick();
      scheduler.seekTo(asSec(5), "jump");
      release();
      await scheduler.idle();

      const decodedAt2 = frames.filter(
        (f) => f.timestampS === 2 && f.quality === "exact",
      );
      expect(decodedAt2).toHaveLength(0);
      expect(frames.map((f) => f.timestampS).at(-1)).toBe(5);
    });

    it("an exact cache hit serves without decoding again", async () => {
      const { scheduler, sink } = setup();
      await scheduler.open();
      scheduler.seekTo(asSec(1));
      await scheduler.idle();
      const callsBefore = sink.getCanvasCalls.length;

      const frames = record(scheduler);
      frames.length = 0;
      scheduler.seekTo(asSec(1));
      await scheduler.idle();

      expect(sink.getCanvasCalls.length).toBe(callsBefore);
      expect(frames.map((f) => f.timestampS)).toEqual([1]);
    });

    it("a preview-only hit paints coarse, then decodes the crisp frame", async () => {
      const { scheduler, sink, cache } = setup();
      await scheduler.open();
      cache.putPreview(3000, SRC, 320, 180);
      const frames = record(scheduler);
      frames.length = 0;

      scheduler.seekTo(asSec(3));
      await scheduler.idle();

      expect(frames.map((f) => f.quality)).toEqual(["preview", "exact"]);
      expect(sink.getCanvasCalls).toContain(3);
    });

    it("seekToKey lands on the sample at or before the target", async () => {
      const { scheduler, sink, cache } = setup({ keyframes: [0, 2, 4, 6, 8] });
      await scheduler.open();
      await scheduler.whenSettled();
      const previewBefore = cache.stats.previewSize;
      const frames = record(scheduler);
      frames.length = 0;

      scheduler.seekToKey(asSec(7));
      await scheduler.idle();

      expect(sink.getCanvasCalls).toContain(7);
      expect(frames).toHaveLength(1);
      expect(frames[0].timestampS).toBe(7);
      expect(frames[0].isKeyFrame).toBe(true);
      expect(cache.stats.previewSize).toBe(previewBefore + 1);
    });

    it("a source with one keyframe answers distinct targets distinctly", async () => {
      const { scheduler, sink } = setup({ keyframes: [0] });
      await scheduler.open();
      await scheduler.whenSettled();
      const frames = record(scheduler);
      frames.length = 0;

      scheduler.seekToKey(asSec(5));
      await scheduler.idle();

      expect(sink.getCanvasCalls).toContain(5);
      expect(frames.map((f) => f.timestampS)).toEqual([5]);
    });

    it("a burst of seeks collapses to the latest target", async () => {
      const { scheduler, sink } = setup();
      await scheduler.open();

      scheduler.seekTo(asSec(1));
      scheduler.seekTo(asSec(2));
      scheduler.seekTo(asSec(3));
      await scheduler.idle();

      // The burst arrives before the drain begins decoding, so the stale
      // intermediates are skipped and only the latest target decodes.
      expect(sink.getCanvasCalls).toEqual([0, 3]);
    });

    it("seekToFrame emits exactly the frame it was handed", async () => {
      const { scheduler, sink } = setup({ frames: [0, 1, 2, 3] });
      await scheduler.open();
      const frames = record(scheduler);
      frames.length = 0;

      const forward = await scheduler.seekToFrame(TIMELINE.idAt(60));
      const back = await scheduler.seekToFrame(TIMELINE.idAt(30));

      expect(forward?.timestampS).toBe(2);
      expect(back?.timestampS).toBe(1);
      expect(frames.map((f) => f.timestampS)).toEqual([2, 1]);
      expect(sink.getCanvasCalls.slice(-2)).toEqual([2, 1]);
    });

    it("play pulls advance forward and seed only the coarse tier", async () => {
      const { scheduler, cache } = setup({ frames: [0, 1, 2, 3] });
      await scheduler.open();
      const frames = record(scheduler);
      frames.length = 0;
      const exactBefore = cache.stats.exactSize;

      scheduler.attachPlay(0);
      scheduler.next();
      await tick();
      scheduler.next();
      await tick();
      scheduler.detachPlay();

      expect(frames.map((f) => f.timestampS)).toEqual([0, 1]);
      // A frame every interval would churn the whole crisp window, so
      // playback seeds the coarse tier and leaves the exact tier alone.
      expect(cache.stats.exactSize).toBe(exactBefore);
      expect(cache.stats.previewSize).toBeGreaterThanOrEqual(2);
      await scheduler.whenSettled();
    });

    it("a scrub back over played footage paints coarse at once, then decodes crisp", async () => {
      const { scheduler, sink, cache } = setup({ frames: [0, 1, 2, 3] });
      await scheduler.open();
      await scheduler.whenSettled();

      // Play forward so frames 1 and 2 land in the coarse tier, ending on
      // 2: scrubbing BACK to 1 is then a real move, not a re-request of
      // the frame already on screen (which correctly paints nothing new).
      scheduler.attachPlay(0);
      scheduler.next();
      await tick();
      scheduler.next();
      await tick();
      scheduler.next();
      await tick();
      scheduler.detachPlay();
      await scheduler.whenSettled();
      expect(cache.stats.previewSize).toBeGreaterThan(0);

      const frames = record(scheduler);
      frames.length = 0;
      const decodesBefore = sink.getCanvasCalls.length;

      scheduler.seekTo(asSec(1));
      await scheduler.idle();

      // The coarse hit paints immediately and still owes a crisp frame, so
      // the seek decodes: two paints for the one gesture.
      expect(cache.stats.previewHits).toBeGreaterThan(0);
      expect(sink.getCanvasCalls.length).toBeGreaterThan(decodesBefore);
      expect(frames.map((f) => f.timestampS)).toEqual([1, 1]);
      // What playback left resident is the 160px coarse blit; the crisp
      // 320px frame comes from the decode, not from memory held for it.
      expect(frames[0].width).toBe(160);
      expect(frames[0].quality).toBe("preview");
      expect(frames[1].width).toBe(320);
      expect(frames[1].quality).toBe("exact");
      await scheduler.whenSettled();
    });

    it("a coarse stand-in never replaces a crisp frame it is no closer than", async () => {
      // Tight exact tolerance so a target between decoded frames is not
      // answered crisply, wide preview tolerance so the coarse tier is.
      const { scheduler, cache } = setup({
        frames: [0, 1, 2, 3],
        exactToleranceMs: 10,
        previewToleranceMs: 500,
      });
      await scheduler.open();
      await scheduler.whenSettled();

      // Land crisply on 1, which also seeds the coarse tier there.
      scheduler.seekTo(asSec(1));
      await scheduler.idle();
      await scheduler.whenSettled();
      expect(cache.stats.previewSize).toBeGreaterThan(0);

      const frames = record(scheduler);
      frames.length = 0;
      // 1.4 is outside the window the sweep filled crisply, so no crisp
      // frame answers it, but the coarse copy of the frame at 1 does. That
      // copy sits exactly as far from the target as the crisp frame already
      // on screen, so painting it only makes the picture worse until the
      // decode lands. That coarse copy sits exactly
      // as far from the target as the crisp frame already on screen, so
      // painting it only makes the picture worse until the decode lands.
      // This is the slow-scrub flicker: a crisp frame replaced by a blurry
      // one at the same position, several times a second.
      scheduler.seekTo(asSec(1.4));
      await scheduler.idle();

      expect(cache.stats.previewHits).toBeGreaterThan(0);
      expect(frames.map((f) => f.quality)).not.toContain("preview");
      expect(frames.map((f) => f.quality)).toContain("exact");
    });

    it("next is a no-op while paused (no iterator attached)", async () => {
      const { scheduler } = setup({ frames: [0, 1, 2, 3] });
      await scheduler.open();
      const frames = record(scheduler);
      frames.length = 0;

      scheduler.next();
      await tick();

      expect(frames).toHaveLength(0);
    });

    it("isIdle tracks the seek lifecycle", async () => {
      const { scheduler } = setup();
      await scheduler.open();
      expect(scheduler.isIdle).toBe(true);

      scheduler.seekTo(asSec(1));
      expect(scheduler.isIdle).toBe(false);
      await scheduler.idle();
      expect(scheduler.isIdle).toBe(true);
    });

    it("close clears the cache, disposes the source, and goes inert", async () => {
      const { scheduler, cache, disposed } = setup();
      await scheduler.open();
      scheduler.seekTo(asSec(1));
      await scheduler.idle();
      expect(cache.stats.exactSize).toBeGreaterThan(0);

      await scheduler.close();

      expect(disposed).toHaveBeenCalledTimes(1);
      expect(cache.stats.exactSize).toBe(0);
      expect(scheduler.peekCached(1000)).toBeNull();
      expect(scheduler.state).toBe(ScrubCursorState.Closed);
    });
  });

  describe("seekSettled", () => {
    /** Parks every foreground decode past the seed until the test releases it,
     *  so a lap of the drain stays open while the gesture moves on. */
    function gated(): {
      scheduler: DecodeScheduler;
      releases: Array<() => void>;
    } {
      const releases: Array<() => void> = [];
      const { scheduler } = setup({
        gateDecode: async (timestampS) => {
          if (timestampS === 0) return;
          await new Promise<void>((release) => releases.push(release));
        },
      });
      return { scheduler, releases };
    }

    it("answers on the decode in flight while a drag keeps re-arming the drain", async () => {
      const { scheduler, releases } = gated();
      await scheduler.open();

      scheduler.seekTo(asSec(1));
      await tick();

      let committed = false;
      const commit = scheduler.seekSettled().then(() => {
        committed = true;
      });
      let wentIdle = false;
      const idle = scheduler.idle().then(() => {
        wentIdle = true;
      });

      for (let move = 0; move < 8; move++) {
        scheduler.seekTo(asSec(2 + move));
        releases.shift()?.();
        await tick();
        expect(wentIdle).toBe(false);
        expect(committed).toBe(true);
      }
      await commit;

      for (let i = 0; i < 8 && !wentIdle; i++) {
        releases.shift()?.();
        await tick();
      }
      await idle;
      expect(releases).toHaveLength(0);
      expect(scheduler.isIdle).toBe(true);
      await scheduler.whenSettled();
    });

    it("a closed cursor answers instead of waiting on a target nothing will drain", async () => {
      const { scheduler } = setup();
      await scheduler.open();
      await scheduler.close();
      scheduler.seekTo(asSec(1));

      await expect(scheduler.seekSettled()).resolves.toBeUndefined();
    });
  });

  describe("prefetch window", () => {
    it("a settled scrub prefetches a window of neighbor frames", async () => {
      const { scheduler, sink, cache } = setup();
      await scheduler.open();
      await scheduler.whenSettled();

      scheduler.seekTo(asSec(5));
      await scheduler.whenSettled();

      // Scrub window is 6 frames each side; neighbors decode via the batch
      // path, not getCanvas, and land in the exact tier.
      expect(sink.atTimestampsCalls.length).toBeGreaterThanOrEqual(12);
      expect(cache.stats.exactSize).toBeGreaterThanOrEqual(10);
    });

    it("stepping prefetches a tighter window than scrubbing", async () => {
      const { scheduler, sink } = setup({ frames: [0, 1, 2, 3, 4] });
      await scheduler.open();
      await scheduler.whenSettled();
      const before = sink.atTimestampsCalls.length;

      await scheduler.seekToFrame(TIMELINE.idAt(60));
      await scheduler.whenSettled();

      // Step window is 2 frames each side: 4 neighbors, no center.
      expect(sink.atTimestampsCalls.length - before).toBe(4);
    });

    it("pausing runs a keyframe sweep into the preview tier", async () => {
      const { scheduler, cache } = setup({ keyframes: [0, 2, 4, 6, 8] });
      await scheduler.open();
      await scheduler.whenSettled();
      const previewFillsBefore = scheduler.getStats().decode.prefetchPreview;

      // Pause with the playhead near the seed: the detach drops to Idle and
      // runs a keyframe preview sweep around the current position.
      scheduler.attachPlay(0);
      scheduler.detachPlay();
      await scheduler.whenSettled();

      // The sweep ran and fed the preview tier (whether or not the slots
      // were already warm), and the tier holds coarse keyframes.
      expect(scheduler.getStats().decode.prefetchPreview).toBeGreaterThan(
        previewFillsBefore,
      );
      expect(cache.stats.previewSize).toBeGreaterThanOrEqual(1);
    });

    it("a short-GOP sweep decodes a bounded batch nearest the playhead", async () => {
      // A keyframe every 0.25s puts 17 of them inside the 4s sweep span, a
      // walk long enough that the next gesture always arrives mid-sweep.
      const keyframes = Array.from({ length: 41 }, (_, i) => i * 0.25);
      const { scheduler, sink } = setup({ keyframes });
      await scheduler.open();
      await scheduler.whenSettled();

      expect(sink.atTimestampsCalls).toEqual([
        0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75,
      ]);
    });

    it("scrubbing seeds preview coverage so a re-scrub finds a coarse frame", async () => {
      // Each emit seeds the preview tier, so coverage grows across scrubs
      // without an eager keyframe sweep after every settle (that sweep
      // flooded the decoder and stalled the next scrub and play).
      const { scheduler, cache } = setup({ keyframes: [0, 2, 4, 6, 8] });
      await scheduler.open();

      scheduler.seekTo(asSec(5));
      await scheduler.whenSettled();

      expect(cache.stats.previewSize).toBeGreaterThanOrEqual(1);
    });

    it("every exact emit also seeds a preview entry", async () => {
      // A plain scrub used to write the exact tier only, so a re-scrub near a
      // visited spot had no preview to paint. Now each emit seeds preview too.
      const { scheduler, cache } = setup();
      await scheduler.open();

      // The seeded frame at 0 already seeded a preview on open.
      expect(cache.get(0, 50, 50)).not.toBeNull();
      const previewAfterOpen = cache.stats.previewSize;

      scheduler.seekTo(asSec(3));
      await scheduler.idle();

      // The exact decode at 3 also dropped a preview copy for it.
      expect(cache.stats.previewSize).toBeGreaterThan(previewAfterOpen);
    });

    it("playback runs no window prefetch; the stream iterator covers forward", async () => {
      const { scheduler, sink } = setup({ frames: [0, 1, 2, 3] });
      await scheduler.open();
      await scheduler.whenSettled();
      const before = sink.atTimestampsCalls.length;

      scheduler.attachPlay(0);
      scheduler.next();
      await tick();
      scheduler.next();
      await tick();

      expect(sink.atTimestampsCalls.length).toBe(before);
      scheduler.detachPlay();
      await scheduler.whenSettled();
    });

    it("a new gesture cancels an in-flight sweep without deadlocking", async () => {
      const { scheduler, sink } = setup();
      await scheduler.open();
      await scheduler.whenSettled();

      scheduler.seekTo(asSec(1));
      await scheduler.idle();
      scheduler.seekTo(asSec(5));
      await scheduler.whenSettled();

      expect(sink.getCanvasCalls).toContain(1);
      expect(sink.getCanvasCalls).toContain(5);
    });

    it("the window clamps to the exact capacity so it never self-evicts", async () => {
      // A 5-slot tier holds the center plus floor((5-1)/2)=2 each side. The
      // desired scrub window is 6 each side (13 frames total), which on an
      // unclamped path would overflow a 5-slot tier and evict the very
      // neighbors it just decoded. The clamp keeps the resident set within
      // the tier, so nothing the settle decoded is self-evicted.
      const { scheduler, cache } = setup({ cache: makeCacheWithCapacity(5) });
      await scheduler.open();
      await scheduler.whenSettled();

      scheduler.seekTo(asSec(5));
      await scheduler.whenSettled();

      expect(cache.stats.exactCapacity).toBe(5);
      expect(cache.stats.exactSize).toBeLessThanOrEqual(
        cache.stats.exactCapacity,
      );
      // The clamped neighbors all survive, so a re-scrub onto one is a hit.
      const neighbor = cache.get(Math.round((5 + 1 / 30) * 1000), 50, 50);
      expect(neighbor).not.toBeNull();
    });

    it("the just-shown center frame survives its own neighbor sweep", async () => {
      // A 5-slot tier: without the center bump the center (inserted first)
      // would be the LRU victim once the 4 neighbors land.
      const { scheduler, cache } = setup({ cache: makeCacheWithCapacity(5) });
      await scheduler.open();
      await scheduler.whenSettled();

      scheduler.seekTo(asSec(5));
      await scheduler.whenSettled();

      // The center is still an exact hit after the sweep filled the tier.
      const hit = cache.get(5000, 50, 50);
      expect(hit?.timestampMs).toBe(5000);
    });
  });

  describe("prefetch generation", () => {
    it("play pulls leave the generation where it is", async () => {
      const { scheduler } = setup({ frames: [0, 1, 2, 3] });
      await scheduler.open();
      await scheduler.whenSettled();

      scheduler.attachPlay(0);
      const before = scheduler.getStats().prefetchState.generation;
      scheduler.next();
      await tick();
      scheduler.next();
      await tick();

      expect(scheduler.getStats().prefetchState.generation).toBe(before);

      scheduler.detachPlay();
      await scheduler.whenSettled();
    });

    it("a sweep cancelled before it finishes moves the generation", async () => {
      // A keyframe every 0.25s puts 17 of them inside the sweep span, so the
      // sweep opened by the seed is still walking when the seek arrives.
      const keyframes = Array.from({ length: 41 }, (_, index) => index * 0.25);
      const { scheduler } = setup({ keyframes });
      await scheduler.open();
      const before = scheduler.getStats().prefetchState.generation;

      scheduler.seekTo(asSec(5));
      await scheduler.whenSettled();

      expect(scheduler.getStats().prefetchState.generation).toBeGreaterThan(
        before,
      );
    });
  });

  describe("gesture-shaped prefetch window", () => {
    it("a reversal aims the window behind the playhead within one gesture", async () => {
      const h = setup({ now: tickingClock(200) });
      await h.scheduler.open();
      await h.scheduler.whenSettled();

      await drag(h, [4, 5, 6, 7]);

      // A few steps the other way, not one: a single step against the
      // heading is what pointer jitter produces, and taking it as a new
      // gesture would aim the whole window backward behind a hand that is
      // still going forward.
      const reversed = await drag(h, [6, 5, 4]);
      const behind = reversed.filter((t) => t < 4).length;

      expect(behind).toBeGreaterThan(reversed.length * 0.6);
    });

    it("a drag that comes to rest spreads the window evenly again", async () => {
      const h = setup({ now: tickingClock(200) });
      await h.scheduler.open();
      await h.scheduler.whenSettled();

      await drag(h, [1, 2, 3, 4]);
      // Held still long enough for the whole sample ring to describe rest.
      const window = await drag(h, [4, 4, 4, 4, 4, 4, 4, 4]);

      expect(Math.min(...window)).toBeCloseTo(4 - 6 / 30, 6);
      expect(Math.max(...window)).toBeCloseTo(4 + 6 / 30, 6);
    });

    it("playback ends the gesture, so the next scrub starts symmetric", async () => {
      const h = setup({ frames: [4, 5], now: tickingClock(200) });
      await h.scheduler.open();
      await h.scheduler.whenSettled();
      await drag(h, [1, 2, 3, 4]);

      h.scheduler.attachPlay(4);
      h.scheduler.detachPlay();
      await h.scheduler.whenSettled();
      const window = await seekAndSweep(h, 4);

      expect(Math.min(...window)).toBeCloseTo(4 - 6 / 30, 6);
      expect(Math.max(...window)).toBeCloseTo(4 + 6 / 30, 6);
    });

    it("a slow forward drag spends most of the window ahead of the pointer", async () => {
      const h = setup({ now: tickingClock(200) });
      await h.scheduler.open();
      await h.scheduler.whenSettled();

      const window = await drag(h, [1, 1.05, 1.1, 1.15]);
      const ahead = window.filter((t) => t > 1.15).length;

      // An even split puts half the sweep behind a hand moving away from
      // there, and those frames are stale before they land.
      expect(window.length).toBeGreaterThan(4);
      expect(ahead).toBeGreaterThan(window.length * 0.6);
    });

    it("a backward drag spends most of the window behind the pointer", async () => {
      const h = setup({ now: tickingClock(200) });
      await h.scheduler.open();
      await h.scheduler.whenSettled();

      const window = await drag(h, [4, 3.95, 3.9, 3.85]);
      const behind = window.filter((t) => t < 3.85).length;

      // The bias follows the gesture, it is not a preference for forward.
      expect(behind).toBeGreaterThan(window.length * 0.6);
    });

    it("a run of jumps does not aim the window where the jumps were heading", async () => {
      const h = setup({ now: tickingClock(200) });
      await h.scheduler.open();
      await h.scheduler.whenSettled();

      // The same positions as the forward-drag case above, which spends
      // over 60% of its window ahead. Pressing a next-marker button three
      // times produces no hand and no heading to read.
      let window: number[] = [];
      for (const p of [1, 1.05, 1.1, 1.15]) {
        const before = h.sink.atTimestampsCalls.length;
        h.scheduler.seekTo(asSec(p), "jump");
        await h.scheduler.whenSettled();
        window = h.sink.atTimestampsCalls.slice(before);
      }

      expect(window.length).toBeGreaterThan(4);
      expect(window.filter((t) => t > 1.15).length).toBeLessThanOrEqual(
        Math.ceil(window.length / 2),
      );
    });

    it("the reported mode separates a hand on the timeline from a jump", async () => {
      const h = setup();
      await h.scheduler.open();
      await h.scheduler.whenSettled();

      h.scheduler.seekTo(asSec(1));
      expect(h.scheduler.getStats().mode).toBe("scrubbing");

      h.scheduler.seekTo(asSec(2), "jump");
      expect(h.scheduler.getStats().mode).toBe("seeking");
    });

    it("a forward drag still keeps slots behind the pointer", async () => {
      const h = setup({ now: tickingClock(200) });
      await h.scheduler.open();
      await h.scheduler.whenSettled();

      const window = await drag(h, [1, 2, 3, 4]);
      const behind = window.filter((t) => t < 4);

      // A reversal lands near where the hand is, so the minority of slots
      // that cover one have to sit on the ground just behind it.
      expect(behind.length).toBeGreaterThan(0);
      expect(Math.max(...behind)).toBeLessThan(4);
    });
  });

  describe("stats", () => {
    it("reports a cache hit once a decoded frame is revisited", async () => {
      const { scheduler } = setup();
      await scheduler.open();
      await scheduler.whenSettled();

      scheduler.seekTo(asSec(1));
      await scheduler.whenSettled();
      scheduler.seekTo(asSec(1));
      await scheduler.whenSettled();

      expect(scheduler.getStats().cache.exactHits).toBeGreaterThanOrEqual(1);
    });

    it("an exact-hit scrub records a ~0ms latency sample", async () => {
      const { scheduler } = setup();
      await scheduler.open();
      await scheduler.whenSettled();

      // First seek is a fresh decode (one sample).
      scheduler.seekTo(asSec(1));
      await scheduler.whenSettled();
      const afterMiss = scheduler.getStats().scrub.samples;

      // Re-seeking the same target is an instant exact hit; it must still
      // contribute a sample (~0ms) so the average reflects every felt scrub
      // rather than excluding the instant ones and staying pinned high.
      scheduler.seekTo(asSec(1));
      await scheduler.whenSettled();
      const stats = scheduler.getStats();
      expect(stats.scrub.samples).toBe(afterMiss + 1);
      // The instant hit pulls the average down toward the felt-instant truth.
      expect(stats.scrub.avgMs).toBeLessThan(stats.scrub.lastMs + 1);
      expect(stats.scrub.lastMs).toBe(0);
    });

    it("reports the live access mode", async () => {
      const { scheduler } = setup();
      await scheduler.open();
      expect(scheduler.getStats().mode).toBe("idle");

      // Scrubbing is the live mode while and after the seek. The scheduler
      // does not auto-reset to idle on settle; that eager reset kicked a
      // heavy preview sweep that flooded the decoder.
      scheduler.seekTo(asSec(1));
      expect(scheduler.getStats().mode).toBe("scrubbing");
      await scheduler.whenSettled();
      expect(scheduler.getStats().mode).toBe("scrubbing");
    });

    it("surfaces discovered keyframes, the prefetch window, and tolerances", async () => {
      const { scheduler } = setup({ keyframes: [0, 2, 4, 6, 8] });
      await scheduler.open();
      await scheduler.whenSettled();

      scheduler.seekTo(asSec(1));
      await scheduler.idle();

      const stats = scheduler.getStats();
      expect(stats.keyframesMs.length).toBeGreaterThan(0);
      expect(stats.prefetch).not.toBeNull();
      expect(stats.exactToleranceMs).toBe(50);
      expect(stats.previewToleranceMs).toBe(250);
    });

    it("the idle prefetch plan lists the keyframe targets it would decode", async () => {
      const { scheduler } = setup({ keyframes: [0, 2, 4, 6, 8] });
      await scheduler.open();
      await scheduler.whenSettled();

      // Position 0, idle: the discovered keyframes inside the sweep span,
      // each its own target. A lo/hi band here would claim 0..4s solid
      // and could not represent a hole between them.
      expect(scheduler.getStats().prefetch?.targetsMs).toEqual([0, 2000, 4000]);
    });

    it("framesOut counts every frame the provider produced", async () => {
      const { scheduler } = setup();
      await scheduler.open();
      await scheduler.whenSettled();
      const atOpen = scheduler.getStats().decode.framesOut;
      expect(atOpen).toBeGreaterThan(0);

      scheduler.seekTo(asSec(1));
      await scheduler.idle();
      expect(scheduler.getStats().decode.framesOut).toBeGreaterThan(atOpen);
    });

    it("records scrub-decode latency from the injected clock", async () => {
      // Per seek: the gesture sample, then the decode's start and finish.
      const times = [5, 10, 18, 95, 100, 130];
      let i = 0;
      const now = (): number => times[Math.min(i++, times.length - 1)];
      const { scheduler } = setup({ now });
      await scheduler.open();
      await scheduler.whenSettled();

      scheduler.seekTo(asSec(1));
      await scheduler.whenSettled();
      scheduler.seekTo(asSec(5));
      await scheduler.whenSettled();

      const { scrub } = scheduler.getStats();
      expect(scrub.samples).toBe(2);
      expect(scrub.lastMs).toBe(30);
      expect(scrub.maxMs).toBe(30);
      expect(scrub.avgMs).toBe(19);
    });
  });

  describe("diagnostics counters", () => {
    it("splits foreground decodes from background prefetch fills", async () => {
      const { scheduler } = setup();
      await scheduler.open();
      await scheduler.whenSettled();

      scheduler.seekTo(asSec(5));
      await scheduler.whenSettled();

      const { decode } = scheduler.getStats();
      // The seek itself is a foreground decode; the neighbor window is prefetch.
      expect(decode.foreground).toBeGreaterThanOrEqual(1);
      expect(decode.prefetchExact).toBeGreaterThanOrEqual(1);
    });

    it("counts exact seeks and key seeks on their own paths", async () => {
      const { scheduler } = setup({ keyframes: [0, 2, 4, 6, 8] });
      await scheduler.open();
      await scheduler.whenSettled();

      scheduler.seekTo(asSec(1));
      await scheduler.whenSettled();
      scheduler.seekToKey(asSec(7));
      await scheduler.whenSettled();

      const { seek, decode } = scheduler.getStats();
      expect(seek.exact).toBe(1);
      expect(seek.key).toBe(1);
      // The key seek lands on an anchor, marked as a keyframe emit.
      expect(decode.keyframeAnchored).toBeGreaterThanOrEqual(1);
    });

    it("seekCoalesceDepth counts pending targets overwritten in a burst", async () => {
      const { scheduler } = setup();
      await scheduler.open();
      await scheduler.whenSettled();

      // Three seeks dispatched before the drain begins: the first two are
      // overwritten while still pending, so two coalesce overwrites.
      scheduler.seekTo(asSec(1));
      scheduler.seekTo(asSec(2));
      scheduler.seekTo(asSec(3));
      await scheduler.whenSettled();

      expect(scheduler.getStats().seek.coalesceDepth).toBe(2);
    });

    it("targetVsLandedMs is the requested-minus-landed gap on an exact seek", async () => {
      // Keyframes far apart force getCanvas to land on the anchor, not the
      // requested time. The fake sink echoes the requested time, so to model
      // a short landing we drive an exact seek and read the gap, which is 0
      // here because the fake echoes back; assert the field is present and 0.
      const { scheduler } = setup();
      await scheduler.open();
      await scheduler.whenSettled();

      scheduler.seekTo(asSec(2.5));
      await scheduler.whenSettled();

      const { scrub } = scheduler.getStats();
      // The fake sink echoes the requested time (ms-rounded), so the landed
      // frame matches the target and the gap is zero.
      expect(scrub.targetVsLandedMs).toBe(0);
    });

    it("the p95 ring stays bounded and yields a plausible percentile", async () => {
      // A monotonically rising clock makes every decode latency 5ms, so the
      // percentiles are deterministic regardless of how the ring wraps.
      let t = 0;
      const now = (): number => {
        t += 5;
        return t;
      };
      const { scheduler } = setup({ now });
      await scheduler.open();
      await scheduler.whenSettled();

      // Each target is unique and 1s apart, starting past the seeded frame
      // at 0, so every seek is a fresh decode (a cache miss) recording one
      // latency sample. More seeks than the 64-sample ring, which must not
      // grow unbounded.
      for (let i = 1; i <= 80; i++) {
        scheduler.seekTo(asSec(i * 1));
        await scheduler.whenSettled();
      }

      const { scrub } = scheduler.getStats();
      expect(scrub.samples).toBe(80);
      expect(scrub.p50Ms).toBeGreaterThan(0);
      expect(scrub.p95Ms).toBeGreaterThanOrEqual(scrub.p50Ms);
    });

    it("getStats exposes every new diagnostics field", async () => {
      const { scheduler } = setup({ keyframes: [0, 2, 4, 6, 8] });
      await scheduler.open();
      await scheduler.whenSettled();
      scheduler.seekTo(asSec(3));
      await scheduler.whenSettled();

      const stats = scheduler.getStats();
      expect(stats.scrub).toMatchObject({
        p50Ms: expect.any(Number),
        p95Ms: expect.any(Number),
        targetVsLandedMs: expect.any(Number),
        timeToCrispMs: expect.any(Number),
      });
      expect(stats.decode).toMatchObject({
        foreground: expect.any(Number),
        prefetchExact: expect.any(Number),
        prefetchPreview: expect.any(Number),
        keyframeAnchored: expect.any(Number),
        nextPending: expect.any(Number),
      });
      expect(stats.seek).toMatchObject({
        exact: expect.any(Number),
        key: expect.any(Number),
        coalesceDepth: expect.any(Number),
      });
      expect(stats.gop.count).toBeGreaterThan(0);
      expect(stats.probeRoundTrips).toBeGreaterThan(0);
      expect(stats.prefetchState).toMatchObject({
        inFlight: expect.any(Boolean),
        generation: expect.any(Number),
      });
    });
  });

  describe("non-zero track origin (T4b)", () => {
    function offsetSetup(): { scheduler: DecodeScheduler; sink: FakeSink } {
      const sink = new FakeSink([]);
      const source: DecodeSourceHandle = {
        track: { ...TRACK, firstTimestampS: asSec(2) },
        sink,
        keyframeProbe: new FakeKeyframeProbe([0, 2, 4, 6, 8]),
        dispose: async () => undefined,
      };
      return {
        scheduler: new DecodeScheduler({ source, cache: makeCache() }),
        sink,
      };
    }

    it("open seeds at the first timestamp, not 0", async () => {
      const { scheduler, sink } = offsetSetup();
      const frames = record(scheduler);
      await scheduler.open();
      expect(sink.getCanvasCalls[0]).toBe(2);
      expect(frames[0].timestampS).toBe(2);
    });

    it("a seek below the origin clamps up to the first timestamp", async () => {
      const { scheduler } = offsetSetup();
      await scheduler.open();
      await scheduler.whenSettled();
      const frames = record(scheduler);
      frames.length = 0;
      scheduler.seekTo(asSec(0.5));
      await scheduler.idle();
      // The clamp floors the target to the origin (2), never below it.
      expect(frames.at(-1)?.timestampS).toBe(2);
    });
  });

  describe("attachPlay nextPending hardening (FIX 5)", () => {
    /** A sink whose play stream gates its first pull on a manual release, so a
     *  test can swap the iterator (a scrub during play) while an old-iterator
     *  pull is still in flight. */
    class GatedStreamSink implements CanvasFrameSource {
      private release: (() => void) | null = null;
      private gateReached: (() => void) | null = null;

      async getCanvas(timestampS: number): Promise<WrappedCanvasLike | null> {
        return makeWrapped(timestampS);
      }

      whenGated(): Promise<void> {
        return new Promise<void>((resolve) => {
          this.gateReached = resolve;
        });
      }

      releaseGate(): void {
        this.release?.();
        this.release = null;
      }

      async *canvases(): AsyncGenerator<WrappedCanvasLike, void, unknown> {
        await new Promise<void>((resolve) => {
          this.release = resolve;
          this.gateReached?.();
          this.gateReached = null;
        });
        yield makeWrapped(0);
      }

      async *canvasesAtTimestamps(): AsyncGenerator<
        WrappedCanvasLike | null,
        void,
        unknown
      > {}
    }

    function gatedStreamSetup(): {
      scheduler: DecodeScheduler;
      sink: GatedStreamSink;
    } {
      const sink = new GatedStreamSink();
      const source: DecodeSourceHandle = {
        track: TRACK,
        sink,
        keyframeProbe: new FakeKeyframeProbe([0, 2, 4, 6, 8]),
        dispose: async () => undefined,
      };
      return {
        scheduler: new DecodeScheduler({ source, cache: makeCache() }),
        sink,
      };
    }

    it("attachPlay resets nextPending to zero for the new session", async () => {
      const { scheduler, sink } = gatedStreamSetup();
      scheduler.attachPlay(0);
      scheduler.next();
      await sink.whenGated();
      expect(scheduler.getStats().decode.nextPending).toBe(1);

      // A scrub-during-play swaps the iterator; the latch resets so the new
      // session starts clean.
      scheduler.attachPlay(2);
      expect(scheduler.getStats().decode.nextPending).toBe(0);
      sink.releaseGate();
      scheduler.detachPlay();
      await scheduler.close();
    });

    it("play pulls queue to the read-ahead depth rather than one at a time", async () => {
      const { scheduler, sink } = gatedStreamSetup();
      scheduler.attachPlay(0);

      // The consumer chains its refill from inside the pull it is answering,
      // so a ceiling of one would refuse every refill and pin the queue at a
      // single frame however deep the consumer asks.
      scheduler.next();
      await sink.whenGated();
      scheduler.next();
      scheduler.next();

      expect(scheduler.getStats().decode.nextPending).toBe(
        PLAYBACK.READ_AHEAD_CANVAS,
      );

      sink.releaseGate();
      scheduler.detachPlay();
      await scheduler.close();
    });

    it("an orphaned old-iterator pull does not drive nextPending negative", async () => {
      const { scheduler, sink } = gatedStreamSetup();
      scheduler.attachPlay(0);
      scheduler.next();
      await sink.whenGated();

      // Swap the iterator while the first pull is gated, then let the old
      // pull settle: its identity-aware finally must not decrement the fresh
      // counter, so it stays at 0 rather than going to -1.
      scheduler.attachPlay(2);
      sink.releaseGate();
      await tick();

      expect(scheduler.getStats().decode.nextPending).toBe(0);
      // The latch is intact: a fresh pull on the new session is admitted.
      scheduler.next();
      await sink.whenGated();
      expect(scheduler.getStats().decode.nextPending).toBe(1);
      sink.releaseGate();
      scheduler.detachPlay();
      await scheduler.close();
    });
  });

  describe("decode watchdog (hang recovery)", () => {
    /** A sink whose getCanvas never settles: models a hung mediabunny decode
     *  that takes no AbortSignal and cannot be cancelled. canvasesAtTimestamps
     *  yields nothing so the open-time prefetch sweep does not also hang. */
    class HangingSink implements CanvasFrameSource {
      getCanvasCalls = 0;
      async getCanvas(): Promise<WrappedCanvasLike | null> {
        this.getCanvasCalls += 1;
        return new Promise<WrappedCanvasLike | null>(() => undefined);
      }
      async *canvases(): AsyncGenerator<WrappedCanvasLike, void, unknown> {
        // The first pull never resolves, modeling a hung play decode.
        await new Promise<void>(() => undefined);
      }
      async *canvasesAtTimestamps(): AsyncGenerator<
        WrappedCanvasLike | null,
        void,
        unknown
      > {}
    }

    function hangSetup(
      opts: { reopen?: (() => Promise<AnySourceHandle>) | null } = {},
    ): {
      scheduler: DecodeScheduler;
      hangingSink: HangingSink;
    } {
      const hangingSink = new HangingSink();
      const source: DecodeSourceHandle = {
        track: TRACK,
        sink: hangingSink,
        keyframeProbe: new FakeKeyframeProbe([0, 2, 4, 6, 8]),
        dispose: async () => undefined,
      };
      const scheduler = new DecodeScheduler({
        source,
        cache: makeCache(),
        decodeHangTimeoutMs: 1500,
        reopen: opts.reopen ?? null,
      });
      return { scheduler, hangingSink };
    }

    it("a hung seek clears seekDraining after the watchdog, unfreezing later seeks", async () => {
      vi.useFakeTimers();
      try {
        // No reopen: the watchdog still frees the drain so the engine is
        // not permanently dead, and the decoder degrades.
        const { scheduler } = hangSetup();
        // open() seeds via getCanvas, which also hangs, so do not await it;
        // the seeded seek is the hang under test.
        void scheduler.open().catch(() => undefined);
        scheduler.seekTo(asSec(1));
        expect(scheduler.isIdle).toBe(false);

        // Fire the watchdog and let the drain finally run.
        await vi.advanceTimersByTimeAsync(1500);

        // seekDraining cleared: a fresh seek is no longer blocked.
        expect(scheduler.getStats().decoderDead).toBe(true);
        scheduler.seekTo(asSec(2));
        await vi.advanceTimersByTimeAsync(1500);
        // The degraded decoder no-ops decodes rather than hanging, so idle
        // resolves rather than the seek wedging forever.
        await expect(scheduler.idle()).resolves.toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it("a hung seek rebuilds the provider so a later seek decodes", async () => {
      vi.useFakeTimers();
      try {
        const goodSink = new FakeSink([]);
        const rebuilt: DecodeSourceHandle = {
          track: TRACK,
          sink: goodSink,
          keyframeProbe: new FakeKeyframeProbe([0, 2, 4, 6, 8]),
          dispose: async () => undefined,
        };
        const reopen = vi.fn(async (): Promise<AnySourceHandle> => rebuilt);
        const { scheduler } = hangSetup({ reopen });

        void scheduler.open().catch(() => undefined);
        scheduler.seekTo(asSec(1));
        await vi.advanceTimersByTimeAsync(1500);

        // The watchdog rebuilt from the reopen seam; the decoder is alive.
        expect(reopen).toHaveBeenCalledTimes(1);
        expect(scheduler.getStats().decoderDead).toBe(false);

        // A fresh seek now decodes through the rebuilt working sink.
        const frames = record(scheduler);
        scheduler.seekTo(asSec(2));
        await vi.advanceTimersByTimeAsync(0);
        await scheduler.idle();
        expect(goodSink.getCanvasCalls).toContain(2);
        expect(frames.map((f) => f.timestampS)).toContain(2);

        // The rebuild repoints the index at the new probe, which starts
        // empty. Nothing else re-walks it, so without one here the source
        // reads as having no keyframes for the rest of the session.
        await vi.advanceTimersByTimeAsync(0);
        expect(scheduler.getStats().keyframesMs).toEqual([
          0, 2000, 4000, 6000, 8000,
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a hung play pull clears so the pump can re-pull", async () => {
      vi.useFakeTimers();
      try {
        const { scheduler } = hangSetup();
        void scheduler.open();
        scheduler.attachPlay(0);
        scheduler.next();
        expect(scheduler.getStats().decode.nextPending).toBe(1);

        // The play decode hangs; the watchdog frees the latch.
        await vi.advanceTimersByTimeAsync(1500);
        expect(scheduler.getStats().decode.nextPending).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a hung play pull recovers onto an iterator that still yields", async () => {
      vi.useFakeTimers();
      try {
        const goodSink = new FakeSink([0, 1, 2, 3]);
        const rebuilt: DecodeSourceHandle = {
          track: TRACK,
          sink: goodSink,
          keyframeProbe: new FakeKeyframeProbe([0, 2, 4, 6, 8]),
          dispose: async () => undefined,
        };
        const { scheduler } = hangSetup({ reopen: async () => rebuilt });
        void scheduler.open();
        const frames = record(scheduler);

        scheduler.attachPlay(0);
        scheduler.next();
        await vi.advanceTimersByTimeAsync(1500);
        expect(scheduler.getStats().decoderDead).toBe(false);

        // Recovery disposed the input the play iterator streams from, so a
        // pump that kept the old iterator would pull a dead generator here.
        scheduler.next();
        await vi.advanceTimersByTimeAsync(0);
        expect(frames.map((f) => f.timestampS)).toContain(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  /**
   * A decoder that cannot decode at all fails exactly like a slow one at every
   * point the runtime can see: the seek drains, the pump ticks, the clock runs.
   * The recovery a slow decoder earns is a rebuild, and rebuilding one that was
   * never going to start runs the same failure forever while every surface
   * reads as healthy, which is what made this invisible in the field.
   */
  describe("decoder stall surfacing", () => {
    /** A sink that refuses every decode the way a decoder with no session
     *  left to hand out does: promptly, and the same way every time. */
    class RefusingSink implements CanvasFrameSource {
      getCanvasCalls = 0;
      async getCanvas(): Promise<WrappedCanvasLike | null> {
        this.getCanvasCalls += 1;
        throw new VideoEngineError(
          VideoEngineErrorCode.DecoderStalled,
          "DecodeSession: the decoder refused to configure",
        );
      }
      async *canvases(): AsyncGenerator<WrappedCanvasLike, void, unknown> {
        throw new VideoEngineError(
          VideoEngineErrorCode.DecoderStalled,
          "DecodeSession: the decoder refused to configure",
        );
      }
      async *canvasesAtTimestamps(): AsyncGenerator<
        WrappedCanvasLike | null,
        void,
        unknown
      > {}
    }

    /** A sink that never answers a decode, and never says why. */
    class SilentSink implements CanvasFrameSource {
      getCanvasCalls = 0;
      async getCanvas(): Promise<WrappedCanvasLike | null> {
        this.getCanvasCalls += 1;
        return new Promise<WrappedCanvasLike | null>(() => undefined);
      }
      async *canvases(): AsyncGenerator<WrappedCanvasLike, void, unknown> {
        await new Promise<void>(() => undefined);
      }
      async *canvasesAtTimestamps(): AsyncGenerator<
        WrappedCanvasLike | null,
        void,
        unknown
      > {}
    }

    /** Answers the first-frame seed and nothing after it: a decoder that
     *  started, so the seed guard has no claim on it, and an engine that is
     *  merely sitting there rather than one that never worked. */
    class SilentAfterSeedSink implements CanvasFrameSource {
      private seeded = false;
      async getCanvas(timestampS: number): Promise<WrappedCanvasLike | null> {
        if (this.seeded)
          return new Promise<WrappedCanvasLike | null>(() => undefined);
        this.seeded = true;
        return makeWrapped(timestampS);
      }
      async *canvases(): AsyncGenerator<WrappedCanvasLike, void, unknown> {
        await new Promise<void>(() => undefined);
      }
      async *canvasesAtTimestamps(): AsyncGenerator<
        WrappedCanvasLike | null,
        void,
        unknown
      > {}
    }

    /** Answers every `answerEvery`-th decode and hangs on the rest: a decoder
     *  that is working, badly. Nothing here may ever be called stalled. */
    class FlakySink implements CanvasFrameSource {
      private calls = 0;
      constructor(private readonly answerEvery: number) {}
      async getCanvas(timestampS: number): Promise<WrappedCanvasLike | null> {
        this.calls += 1;
        if (this.calls % this.answerEvery === 0) return makeWrapped(timestampS);
        return new Promise<WrappedCanvasLike | null>(() => undefined);
      }
      async *canvases(): AsyncGenerator<WrappedCanvasLike, void, unknown> {}
      async *canvasesAtTimestamps(): AsyncGenerator<
        WrappedCanvasLike | null,
        void,
        unknown
      > {}
    }

    const HANG_MS = 1500;

    function stallSetup(sink: CanvasFrameSource): {
      scheduler: DecodeScheduler;
      failures: VideoEngineError[];
      reopens: Mock;
    } {
      const failures: VideoEngineError[] = [];
      const handle = (): DecodeSourceHandle => ({
        track: TRACK,
        sink,
        keyframeProbe: new FakeKeyframeProbe([0, 2, 4, 6, 8]),
        dispose: async () => undefined,
      });
      const reopens = vi.fn(async (): Promise<AnySourceHandle> => handle());
      const scheduler = new DecodeScheduler({
        source: handle(),
        cache: makeCache(),
        decodeHangTimeoutMs: HANG_MS,
        reopen: reopens,
        onDecodeFailure: (error) => failures.push(error),
      });
      return { scheduler, failures, reopens };
    }

    it("a decoder that refuses outright is reported at once and not rebuilt", async () => {
      vi.useFakeTimers();
      try {
        const sink = new RefusingSink();
        const { scheduler, failures, reopens } = stallSetup(sink);
        // The seed decode refuses too; load() is where that one surfaces.
        void scheduler.open().catch(() => undefined);

        scheduler.seekTo(asSec(1));
        await vi.advanceTimersByTimeAsync(0);

        expect(failures).toHaveLength(1);
        expect(failures[0].code).toBe(VideoEngineErrorCode.DecoderStalled);
        expect(scheduler.getStats().decoderStalled).toBe(true);
        // The decoder said what is wrong with it; re-opening the source
        // cannot answer that, and doing it anyway is the forever-loop.
        expect(reopens).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("a stalled decoder is reported once, and later seeks settle instead of wedging", async () => {
      vi.useFakeTimers();
      try {
        const { scheduler, failures, reopens } = stallSetup(new RefusingSink());
        void scheduler.open().catch(() => undefined);
        scheduler.seekTo(asSec(1));
        await vi.advanceTimersByTimeAsync(0);

        scheduler.seekTo(asSec(3));
        scheduler.seekTo(asSec(5));
        await vi.advanceTimersByTimeAsync(0);

        // One failure, however many times it is asked again: the consumer
        // already knows, and the seeks settle rather than latching the
        // drain that refuses every play pull behind it.
        expect(failures).toHaveLength(1);
        expect(reopens).not.toHaveBeenCalled();
        await expect(scheduler.idle()).resolves.toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it("a decoder answering nothing is reported once the request budget runs out", async () => {
      vi.useFakeTimers();
      try {
        const { scheduler, failures, reopens } = stallSetup(new SilentSink());
        void scheduler.open();
        scheduler.attachPlay(0);

        // One unanswered pull is a decoder having a bad moment, and the
        // rebuild it earns is the existing recovery.
        scheduler.next();
        await vi.advanceTimersByTimeAsync(HANG_MS);
        expect(scheduler.getStats().decoderStalled).toBe(false);
        expect(reopens).toHaveBeenCalledTimes(1);

        // Rebuilt sources that go on answering nothing are the same
        // failure, not new evidence. The budget is spent in requests, so
        // it is the asking that ends it, never the waiting.
        for (let i = 0; i < 8 && !scheduler.getStats().decoderStalled; i++) {
          scheduler.next();
          await vi.advanceTimersByTimeAsync(HANG_MS);
        }

        expect(failures).toHaveLength(1);
        expect(failures[0].code).toBe(VideoEngineErrorCode.DecoderStalled);
        expect(scheduler.getStats().decoderStalled).toBe(true);
        scheduler.detachPlay();
      } finally {
        vi.useRealTimers();
      }
    });

    it("an idle engine is never called stalled, however long it sits", async () => {
      vi.useFakeTimers();
      try {
        const { scheduler, failures } = stallSetup(new SilentAfterSeedSink());
        await scheduler.open();

        // An hour with nothing asked of the decoder. A wall-clock guard
        // would have condemned it; a request budget has nothing to count.
        await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

        expect(failures).toEqual([]);
        expect(scheduler.getStats().decoderStalled).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a decode that lands clears the budget, so a working decoder is never condemned", async () => {
      vi.useFakeTimers();
      try {
        // Every other seek hangs: far past the budget in total failures,
        // but never a run of them, which is the distinction the guard is
        // keyed on. A stale-timer guard would have torn this decoder down.
        const { scheduler, failures } = stallSetup(new FlakySink(2));
        void scheduler.open();

        for (let i = 1; i <= 4 * 6; i++) {
          scheduler.seekTo(asSec(i % 8));
          await vi.advanceTimersByTimeAsync(HANG_MS);
        }

        expect(failures).toEqual([]);
        expect(scheduler.getStats().decoderStalled).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  /**
   * The seed decode is the one request nothing else can judge: it is the first,
   * so no run of unanswered decodes exists to count, and open() is what the load
   * path awaits, so a decoder that accepts it and never answers leaves the load
   * to be ended by whoever gave up first.
   */
  describe("first-frame seed guard", () => {
    /** Answers the seed after `answerAfterMs`, or never when that is null. */
    class SeedSink implements CanvasFrameSource {
      seedCalls = 0;
      constructor(private readonly answerAfterMs: number | null) {}
      async getCanvas(timestampS: number): Promise<WrappedCanvasLike | null> {
        this.seedCalls += 1;
        const answerAfterMs = this.answerAfterMs;
        if (answerAfterMs === null) {
          return new Promise<WrappedCanvasLike | null>(() => undefined);
        }
        await new Promise<void>((resolve) =>
          setTimeout(resolve, answerAfterMs),
        );
        return makeWrapped(timestampS);
      }
      async *canvases(): AsyncGenerator<WrappedCanvasLike, void, unknown> {}
      async *canvasesAtTimestamps(): AsyncGenerator<
        WrappedCanvasLike | null,
        void,
        unknown
      > {}
    }

    function seedSetup(
      sink: SeedSink,
      opts: { seedHangTimeoutMs?: number; reopen?: boolean } = {},
    ): {
      scheduler: DecodeScheduler;
      failures: VideoEngineError[];
      reopens: Mock;
    } {
      const failures: VideoEngineError[] = [];
      const handle = (): DecodeSourceHandle => ({
        track: TRACK,
        sink,
        keyframeProbe: new FakeKeyframeProbe([0, 2, 4, 6, 8]),
        dispose: async () => undefined,
      });
      const reopens = vi.fn(async (): Promise<AnySourceHandle> => handle());
      const scheduler = new DecodeScheduler({
        source: handle(),
        cache: makeCache(),
        seedHangTimeoutMs: opts.seedHangTimeoutMs,
        reopen: opts.reopen === false ? null : reopens,
        onDecodeFailure: (error) => failures.push(error),
      });
      return { scheduler, failures, reopens };
    }

    const SEED_MS = HANG_RECOVERY.SEED_HANG_TIMEOUT_MS;
    const ATTEMPTS = HANG_RECOVERY.SEED_DECODE_ATTEMPTS;

    it("a seed the decoder never answers fails the open with a classified stall", async () => {
      vi.useFakeTimers();
      try {
        const sink = new SeedSink(null);
        const { scheduler, failures, reopens } = seedSetup(sink);
        const opened = scheduler.open();
        const settled = opened.catch((error: unknown) => error);

        await vi.advanceTimersByTimeAsync(SEED_MS * ATTEMPTS);

        const error = await settled;
        expect(error).toBeInstanceOf(VideoEngineError);
        expect((error as VideoEngineError).code).toBe(
          VideoEngineErrorCode.DecoderStalled,
        );
        // The failure the caller is handed is the one the consumer was
        // told about, not a second account of the same silence.
        expect(failures).toEqual([error]);
        expect(scheduler.getStats().decoderStalled).toBe(true);
        // Every attempt was spent, and a rebuild ran between them, so the
        // silence was the decoder's and not one unlucky source handle.
        expect(sink.seedCalls).toBe(ATTEMPTS);
        expect(reopens.mock.calls.length).toBe(ATTEMPTS);
      } finally {
        vi.useRealTimers();
      }
    });

    it("the seed fails far sooner than the timeout the facade would end it on", async () => {
      vi.useFakeTimers();
      try {
        const { scheduler } = seedSetup(new SeedSink(null));
        const startedAt = Date.now();
        let failedAt = -1;
        const settled = scheduler.open().catch(() => {
          failedAt = Date.now();
          return "failed";
        });

        await vi.advanceTimersByTimeAsync(
          HANG_RECOVERY.WORKER_COMMAND_TIMEOUT_MS,
        );

        expect(await settled).toBe("failed");
        const spent = failedAt - startedAt;
        expect(spent).toBe(SEED_MS * ATTEMPTS);
        // The whole budget leaves the facade's ceiling most of its length
        // still unspent, which is the room the rebuilds between attempts
        // and the reply back to the caller run in.
        expect(
          HANG_RECOVERY.WORKER_COMMAND_TIMEOUT_MS - spent,
        ).toBeGreaterThanOrEqual(SEED_MS * 2);
      } finally {
        vi.useRealTimers();
      }
    });

    /**
     * The seed is the decoder's cold start: it configures hardware it has not
     * used yet, which no later decode pays. It is also the cheapest decode the
     * runtime ever asks for, since the track's first timestamp is its own
     * anchor and there is no GOP prefix to walk; a re-anchored decode that does
     * walk one measured 49ms mean / 80ms worst on a 2840x2840 source. So the
     * ceiling has to clear that measured cost by whatever a cold start can
     * plausibly add, and 2.5 seconds of it is already an order of magnitude
     * past anything measured.
     */
    it("a seed that takes seconds to land still opens", async () => {
      vi.useFakeTimers();
      try {
        const coldStartMs = 2_500;
        expect(coldStartMs).toBeLessThan(SEED_MS);
        const { scheduler, failures } = seedSetup(new SeedSink(coldStartMs));
        const frames = record(scheduler);

        const opened = scheduler.open();
        await vi.advanceTimersByTimeAsync(coldStartMs);
        await expect(opened).resolves.toBeUndefined();

        expect(failures).toEqual([]);
        expect(scheduler.getStats().decoderStalled).toBe(false);
        expect(scheduler.state).toBe(ScrubCursorState.Idle);
        expect(frames.map((f) => f.timestampS)).toEqual([0]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a source that cannot be re-opened fails the open without waiting out every attempt", async () => {
      vi.useFakeTimers();
      try {
        const startedAt = Date.now();
        let failedAt = -1;
        const { scheduler, failures } = seedSetup(new SeedSink(null), {
          reopen: false,
        });
        const settled = scheduler.open().catch((error: unknown) => {
          failedAt = Date.now();
          return error;
        });

        await vi.advanceTimersByTimeAsync(SEED_MS * ATTEMPTS);

        expect((await settled) as VideoEngineError).toBeInstanceOf(
          VideoEngineError,
        );
        expect(failures).toHaveLength(1);
        // One ceiling, not three: with nothing to rebuild toward, the
        // attempts left have no fresh decoder to spend themselves on.
        expect(failedAt - startedAt).toBe(SEED_MS);
      } finally {
        vi.useRealTimers();
      }
    });

    /**
     * The long-lived decode session bounds its own wait for output, and it
     * knows something the outer guard cannot: a decoder that acknowledged a
     * pipeline of chunks and produced no frame at all never started, so
     * rebuilding it runs the same failure again. It says so with a stalled
     * code, which is the runtime's word for "do not rebuild this", and the
     * seed's own ceiling and attempts are spent on nothing as a result.
     *
     * So the seed budget is the sink paths' budget. Nothing here is allowed
     * to drift without the other side moving with it: a session ceiling
     * raised past the seed's would put the guard back in charge of a failure
     * the session classifies better, and dropping the stalled arm in
     * noteUnanswered would rebuild a decoder already known not to start.
     */
    class NeverStartingSession implements SessionFrameSource {
      frameAtCalls = 0;
      readonly reachableFromS = -Infinity;
      readonly framesDecoded = 0;

      constructor(private readonly ceilingMs: number) {}

      async frameAt(): Promise<VideoSampleLike | null> {
        this.frameAtCalls += 1;
        await new Promise<void>((resolve) =>
          setTimeout(resolve, this.ceilingMs),
        );
        throw new VideoEngineError(
          VideoEngineErrorCode.DecoderStalled,
          "DecodeSession: the decoder acknowledged 4 decode requests and produced no frame",
        );
      }
      async *framesFrom(): AsyncGenerator<VideoSampleLike, void, unknown> {}
      async *framesCovering(): AsyncGenerator<VideoSampleLike, void, unknown> {}
    }

    it("a session that classifies its own silence ends the seed on its ceiling, not the seed's", async () => {
      vi.useFakeTimers();
      try {
        const SESSION_CEILING_MS = SEED_MS / 2;
        const session = new NeverStartingSession(SESSION_CEILING_MS);
        const failures: VideoEngineError[] = [];
        const handle = (): AnySourceHandle => ({
          track: TRACK,
          session,
          keyframeProbe: new FakeKeyframeProbe([0, 2, 4, 6, 8]),
          dispose: async () => undefined,
        });
        const reopens = vi.fn(async (): Promise<AnySourceHandle> => handle());
        const scheduler = new DecodeScheduler({
          source: handle(),
          cache: makeCache(),
          reopen: reopens,
          onDecodeFailure: (error) => failures.push(error),
        });

        const startedAt = Date.now();
        let failedAt = -1;
        const settled = scheduler.open().catch((error: unknown) => {
          failedAt = Date.now();
          return error;
        });
        await vi.advanceTimersByTimeAsync(SEED_MS * ATTEMPTS);

        const error = (await settled) as VideoEngineError;
        expect(error.code).toBe(VideoEngineErrorCode.DecoderStalled);
        expect(error.message).toContain("produced no frame");
        expect(failures).toEqual([error]);
        expect(failedAt - startedAt).toBe(SESSION_CEILING_MS);
        expect(session.frameAtCalls).toBe(1);
        expect(reopens).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("background sweep never blocks foreground decode", () => {
    /** A sink whose sweep generator never yields, while random access and
     *  playback decode normally: models a prefetch holding the decoder. */
    class SweepHangingSink implements CanvasFrameSource {
      readonly getCanvasCalls: number[] = [];

      constructor(private readonly frames: number[] = []) {}

      async getCanvas(timestampS: number): Promise<WrappedCanvasLike | null> {
        this.getCanvasCalls.push(timestampS);
        return makeWrapped(timestampS);
      }

      async *canvases(
        startS: number,
      ): AsyncGenerator<WrappedCanvasLike, void, unknown> {
        for (const t of this.frames) {
          if (t >= startS) yield makeWrapped(t);
        }
      }

      async *canvasesAtTimestamps(): AsyncGenerator<
        WrappedCanvasLike | null,
        void,
        unknown
      > {
        await new Promise<void>(() => undefined);
      }
    }

    function sweepSetup(frames: number[] = []): {
      scheduler: DecodeScheduler;
      sink: SweepHangingSink;
    } {
      const sink = new SweepHangingSink(frames);
      const source: DecodeSourceHandle = {
        track: TRACK,
        sink,
        keyframeProbe: new FakeKeyframeProbe([0, 2, 4, 6, 8]),
        dispose: async () => undefined,
      };
      const scheduler = new DecodeScheduler({
        source,
        cache: makeCache(),
        decodeHangTimeoutMs: 1500,
        reopen: null,
      });
      return { scheduler, sink };
    }

    it("a seek settles without waiting out the sweep's hang ceiling", async () => {
      vi.useFakeTimers();
      try {
        const { scheduler, sink } = sweepSetup();
        void scheduler.open();
        // Let the sweep reach its hung decode, past the generation check
        // that would otherwise let it bail before touching the decoder.
        await vi.advanceTimersByTimeAsync(0);

        scheduler.seekTo(asSec(3));
        await vi.advanceTimersByTimeAsync(0);

        expect(sink.getCanvasCalls).toContain(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a play pull emits without waiting out the sweep's hang ceiling", async () => {
      vi.useFakeTimers();
      try {
        // Play frames start past the seek open() seeds, so a replayed
        // last-emitted frame cannot stand in for a real pull.
        const { scheduler } = sweepSetup([5, 6, 7]);
        void scheduler.open();
        await vi.advanceTimersByTimeAsync(0);
        const frames = record(scheduler);

        scheduler.attachPlay(5);
        scheduler.next();
        await vi.advanceTimersByTimeAsync(0);

        expect(frames.map((f) => f.timestampS)).toContain(5);
      } finally {
        vi.useRealTimers();
      }
    });

    /** A sink whose sweep parks mid-walk and records whether it was ever
     *  resumed, so a test can tell a sweep that unwound at the gesture from
     *  one that unwound only once its walk finished. */
    class ParkedSweepSink implements CanvasFrameSource {
      sweepPulls = 0;
      walkFinished = false;
      private parked: Array<() => void> = [];
      private parking = true;

      async getCanvas(timestampS: number): Promise<WrappedCanvasLike | null> {
        return makeWrapped(timestampS);
      }

      /** Lets every walk run to completion and stops parking new ones, so no
       *  abandoned decode is left holding a hang timer past the test. */
      finishWalks(): void {
        this.parking = false;
        const parked = this.parked;
        this.parked = [];
        parked.forEach((r) => r());
      }

      async *canvasesAtTimestamps(
        timestamps: Iterable<number>,
      ): AsyncGenerator<WrappedCanvasLike | null, void, unknown> {
        for (const t of timestamps) {
          this.sweepPulls += 1;
          if (this.parking) {
            await new Promise<void>((resolve) => this.parked.push(resolve));
          }
          this.walkFinished = true;
          yield makeWrapped(t);
        }
      }

      async *canvases(): AsyncGenerator<WrappedCanvasLike, void, unknown> {}
    }

    function parkedSweepSetup(): {
      scheduler: DecodeScheduler;
      sink: ParkedSweepSink;
    } {
      const sink = new ParkedSweepSink();
      const source: DecodeSourceHandle = {
        track: TRACK,
        sink,
        keyframeProbe: new FakeKeyframeProbe([0, 2, 4, 6, 8]),
        dispose: async () => undefined,
      };
      const scheduler = new DecodeScheduler({
        source,
        cache: makeCache(),
        // Far past anything these tests wait for, so only cancellation can
        // end a sweep; the hang watchdog must not stand in for it.
        decodeHangTimeoutMs: 600_000,
        reopen: null,
      });
      return { scheduler, sink };
    }

    it("a gesture unwinds a parked sweep without waiting out its walk", async () => {
      const { scheduler, sink } = parkedSweepSetup();
      await scheduler.open();
      await tick();
      expect(sink.sweepPulls).toBe(1);

      scheduler.seekTo(asSec(3));
      await tick();

      // Sweeps are serialized on the previous one's teardown, so a second
      // walk being underway is only reachable if the first already unwound.
      expect(sink.sweepPulls).toBe(2);
      expect(sink.walkFinished).toBe(false);

      sink.finishWalks();
      await tick();
      await scheduler.close();
    });

    it("close resolves before a parked sweep's walk finishes", async () => {
      const { scheduler, sink } = parkedSweepSetup();
      await scheduler.open();
      await tick();
      expect(sink.sweepPulls).toBe(1);

      await scheduler.close();

      expect(sink.walkFinished).toBe(false);
      sink.finishWalks();
      await tick();
    });

    it("close resolves while a sweep is still decoding", async () => {
      vi.useFakeTimers();
      try {
        const { scheduler } = sweepSetup();
        await vi.advanceTimersByTimeAsync(0);
        void scheduler.open();
        await vi.advanceTimersByTimeAsync(0);

        const closed = scheduler.close();
        await vi.advanceTimersByTimeAsync(1500);

        await expect(closed).resolves.toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("ensureKeyframeIndex (T6)", () => {
    /** Counts every decode and packet call so a test can prove the walk is
     *  metadata-only (no frame decode) and idempotent (one walk only). */
    class CountingProbe implements KeyframeProbe {
      keyPacketCalls = 0;
      nextKeyPacketCalls = 0;
      constructor(private readonly keyframes: number[]) {}
      async getKeyPacket(
        timestamp: number,
      ): Promise<KeyframePacketLike | null> {
        this.keyPacketCalls += 1;
        let found: number | null = null;
        for (const k of this.keyframes) {
          if (k <= timestamp) found = k;
          else break;
        }
        return found === null ? null : { timestamp: found };
      }
      async getNextKeyPacket(
        packet: KeyframePacketLike,
      ): Promise<KeyframePacketLike | null> {
        this.nextKeyPacketCalls += 1;
        const i = this.keyframes.indexOf(packet.timestamp);
        if (i === -1 || i + 1 >= this.keyframes.length) return null;
        return { timestamp: this.keyframes[i + 1] };
      }
    }

    function indexSetup(keyframes: number[]): {
      scheduler: DecodeScheduler;
      sink: FakeSink;
      probe: CountingProbe;
    } {
      const sink = new FakeSink([]);
      const probe = new CountingProbe(keyframes);
      const source: DecodeSourceHandle = {
        track: TRACK,
        sink,
        keyframeProbe: probe,
        dispose: async () => undefined,
      };
      return {
        scheduler: new DecodeScheduler({ source, cache: makeCache() }),
        sink,
        probe,
      };
    }

    it("enumerates every keyframe in the file", async () => {
      const { scheduler } = indexSetup([0, 2, 4, 6, 8]);
      await scheduler.open();
      await scheduler.ensureKeyframeIndex();
      expect(scheduler.getStats().keyframesMs).toEqual([
        0, 2000, 4000, 6000, 8000,
      ]);
    });

    it("decodes nothing: the frame sink is never touched by the walk", async () => {
      const { scheduler, sink } = indexSetup([0, 2, 4, 6, 8]);
      await scheduler.open();
      // Let the open-time prefetch sweep finish so its sink calls do not bleed
      // into the measurement; the walk under test must add none of its own.
      await scheduler.whenSettled();
      const decodesBefore =
        sink.getCanvasCalls.length + sink.atTimestampsCalls.length;
      await scheduler.ensureKeyframeIndex();
      const decodesAfter =
        sink.getCanvasCalls.length + sink.atTimestampsCalls.length;
      expect(decodesAfter).toBe(decodesBefore);
    });

    it("is idempotent: a second call walks no further packets", async () => {
      const { scheduler, probe } = indexSetup([0, 2, 4, 6, 8]);
      await scheduler.open();
      await scheduler.whenSettled();
      await scheduler.ensureKeyframeIndex();
      const keyAfterFirst = probe.keyPacketCalls;
      const nextAfterFirst = probe.nextKeyPacketCalls;
      await scheduler.ensureKeyframeIndex();
      expect(probe.keyPacketCalls).toBe(keyAfterFirst);
      expect(probe.nextKeyPacketCalls).toBe(nextAfterFirst);
      expect(scheduler.getStats().keyframesMs).toEqual([
        0, 2000, 4000, 6000, 8000,
      ]);
    });
  });
});
