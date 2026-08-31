import { beforeAll, describe, expect, it } from "vitest";

import {
  FrameCache,
  type FrameCacheOptions,
  FrameTier,
  TierStore,
} from "./frame-cache";
import { type FrameId, FrameTimeline } from "./frame-timeline";
import { installWorkerGlobals } from "../test/fake-engine-deps";

beforeAll(() => {
  installWorkerGlobals();
});

const MB = 1024 * 1024;

/** Source handle for puts; the fake 2D context ignores it, so any shape works. */
const SRC = { width: 4, height: 4 } as unknown as OffscreenCanvas;

const BASE: FrameCacheOptions = {
  exactWidth: 320,
  exactHeight: 180,
  previewWidth: 320,
  exactBudgetBytes: 0,
  previewCapacity: 0,
  bucketMs: 1,
};

function makeCache(overrides: Partial<FrameCacheOptions> = {}): FrameCache {
  return new FrameCache({ ...BASE, ...overrides });
}

/**
 * Frame identity on a millisecond tick grid, which is what these cases assume
 * of their source: two puts a fraction of a millisecond apart are the one frame
 * a decoder answered twice, and anything further apart is two frames. The cases
 * that need a finer grid build a real timeline and take identities from it.
 */
const frameAt = (timestampMs: number): FrameId => ({
  index: Math.round(timestampMs),
  ticks: Math.round(timestampMs),
});

describe("FrameCache", () => {
  describe("preview tier", () => {
    it("stores a downscaled copy and tags the hit Preview", () => {
      const cache = makeCache({ previewWidth: 160, previewCapacity: 4 });
      cache.putPreview(1000, SRC, 320, 180);

      const hit = cache.get(1000, 50, 50);
      expect(hit).not.toBeNull();
      expect(hit?.tier).toBe(FrameTier.Preview);
      expect(hit?.timestampMs).toBe(1000);
      // Downscaled into the tier's own canvas, not aliasing the source.
      expect(hit?.canvas).not.toBe(SRC);
      expect(hit?.canvas.width).toBe(160);
      expect(hit?.canvas.height).toBe(90);
    });

    it("returns null past tolerance", () => {
      const cache = makeCache({ previewCapacity: 4 });
      cache.putPreview(1000, SRC, 320, 180);
      expect(cache.get(1100, 50, 50)).toBeNull();
    });

    it("returns the nearest entry within tolerance", () => {
      const cache = makeCache({ previewCapacity: 5 });
      cache.putPreview(1000, SRC, 320, 180);
      cache.putPreview(1080, SRC, 320, 180);

      const hit = cache.get(1030, 60, 60);
      expect(hit?.timestampMs).toBe(1000);
    });

    it("evicts the least-recently-used entry past capacity", () => {
      const cache = makeCache({ previewCapacity: 2 });
      cache.putPreview(0, SRC, 320, 180);
      cache.putPreview(1000, SRC, 320, 180);
      cache.putPreview(2000, SRC, 320, 180);

      expect(cache.stats.previewSize).toBe(2);
      expect(cache.get(0, 50, 50)).toBeNull();
      expect(cache.get(1000, 50, 50)?.tier).toBe(FrameTier.Preview);
      expect(cache.get(2000, 50, 50)?.tier).toBe(FrameTier.Preview);
    });

    it("a get bumps recency so a later entry evicts first", () => {
      const cache = makeCache({ previewCapacity: 2 });
      cache.putPreview(0, SRC, 320, 180);
      cache.putPreview(1000, SRC, 320, 180);
      // Touch 0 so 1000 becomes the least-recently-used slot.
      cache.get(0, 50, 50);
      cache.putPreview(2000, SRC, 320, 180);

      expect(cache.get(1000, 50, 50)).toBeNull();
      expect(cache.get(0, 50, 50)?.tier).toBe(FrameTier.Preview);
      expect(cache.get(2000, 50, 50)?.tier).toBe(FrameTier.Preview);
    });

    it("collapses re-decodes of one frame onto one slot", () => {
      const cache = makeCache({ previewCapacity: 5, bucketMs: 33 });
      // The same frame, twice, with the float slop a re-decode carries.
      cache.putPreview(1000.2, SRC, 320, 180);
      cache.putPreview(1000.4, SRC, 320, 180);

      expect(cache.stats.previewSize).toBe(1);
      expect(cache.get(1000, 50, 50)?.tier).toBe(FrameTier.Preview);
    });

    it("keeps two frames a few milliseconds apart in their own slots", () => {
      const cache = makeCache({ previewCapacity: 5, bucketMs: 33 });
      cache.putPreview(0, SRC, 320, 180);
      cache.putPreview(10, SRC, 320, 180);

      expect(cache.stats.previewSize).toBe(2);
      expect(cache.get(0, 50, 50)?.timestampMs).toBe(0);
      expect(cache.get(10, 50, 50)?.timestampMs).toBe(10);
    });
  });

  describe("exact tier", () => {
    it("stores a full-resolution copy and tags the hit Exact", () => {
      const cache = makeCache({ exactBudgetBytes: 64 * MB });
      cache.putExact(frameAt(1000), 1000, SRC, 320, 180);

      const hit = cache.get(1000, 50, 50);
      expect(hit?.tier).toBe(FrameTier.Exact);
      expect(hit?.timestampMs).toBe(1000);
      expect(hit?.canvas.width).toBe(320);
      expect(hit?.canvas.height).toBe(180);
    });

    it("answers with the frame at or before the target, never the one after", () => {
      // A 30fps grid: frames 33ms apart, and a 50ms tolerance reaches both
      // neighbours of a target between them.
      const cache = makeCache({ exactBudgetBytes: 64 * MB, bucketMs: 33 });
      cache.putExact(frameAt(1000), 1000, SRC, 320, 180);
      cache.putExact(frameAt(1033), 1033, SRC, 320, 180);

      // A decode for 1010 returns the frame at 1000. The cache has to agree,
      // or the same pointer position paints a different frame depending on
      // which one served it, and the picture steps forward then back as the
      // two alternate.
      expect(cache.get(1010, 50, 50)?.timestampMs).toBe(1000);
      expect(cache.get(1030, 50, 50)?.timestampMs).toBe(1000);
      expect(cache.get(1033, 50, 50)?.timestampMs).toBe(1033);
    });

    it("derives slot count from the RAM budget and evicts past it", () => {
      // 100x100x4 = 40_000 bytes/frame; a 100_000-byte budget yields 2 slots.
      const cache = makeCache({
        exactWidth: 100,
        exactHeight: 100,
        exactBudgetBytes: 100000,
      });
      cache.putExact(frameAt(0), 0, SRC, 100, 100);
      cache.putExact(frameAt(1000), 1000, SRC, 100, 100);
      cache.putExact(frameAt(2000), 2000, SRC, 100, 100);

      expect(cache.stats.exactCapacity).toBe(2);
      expect(cache.stats.exactSize).toBe(2);
      expect(cache.get(0, 50, 50)).toBeNull();
      expect(cache.get(2000, 50, 50)?.tier).toBe(FrameTier.Exact);
    });

    it("an evicted slot's canvas is refilled rather than reallocated", () => {
      const cache = makeCache({
        exactWidth: 100,
        exactHeight: 100,
        exactBudgetBytes: 100000,
      });
      cache.putExact(frameAt(0), 0, SRC, 100, 100);
      const first = cache.get(0, 50, 50)?.canvas;
      cache.putExact(frameAt(1000), 1000, SRC, 100, 100);
      // Evicts bucket 0, releasing its canvas after this put took its own.
      cache.putExact(frameAt(2000), 2000, SRC, 100, 100);
      cache.putExact(frameAt(3000), 3000, SRC, 100, 100);

      expect(cache.get(0, 50, 50)).toBeNull();
      expect(cache.get(3000, 50, 50)?.canvas).toBe(first);
    });

    it("keeps at least one slot for a tiny non-zero budget", () => {
      const cache = makeCache({
        exactWidth: 100,
        exactHeight: 100,
        exactBudgetBytes: 1,
      });
      expect(cache.stats.exactCapacity).toBe(1);
      cache.putExact(frameAt(0), 0, SRC, 100, 100);
      cache.putExact(frameAt(1000), 1000, SRC, 100, 100);

      expect(cache.get(0, 50, 50)).toBeNull();
      expect(cache.get(1000, 50, 50)?.tier).toBe(FrameTier.Exact);
    });

    it("the slot floor raises capacity above what the byte budget alone gives", () => {
      // 100x100x4 = 40_000 bytes/frame; a 100_000-byte budget gives 2 slots,
      // but a floor of 13 must win so a full prefetch window fits.
      const cache = makeCache({
        exactWidth: 100,
        exactHeight: 100,
        exactBudgetBytes: 100000,
        minExactSlots: 13,
      });
      expect(cache.stats.exactCapacity).toBe(13);
    });

    it("the floor never binds when the byte budget already exceeds it", () => {
      const cache = makeCache({
        exactWidth: 100,
        exactHeight: 100,
        exactBudgetBytes: 64 * MB,
        minExactSlots: 13,
      });
      // 64MiB / 40_000 ~= 1677 slots, far above the floor.
      expect(cache.stats.exactCapacity).toBeGreaterThan(13);
    });

    it("the floor leaves a zero budget at zero slots (disabled tier)", () => {
      const cache = makeCache({ exactBudgetBytes: 0, minExactSlots: 13 });
      expect(cache.stats.exactCapacity).toBe(0);
    });

    it("the reported budget grows so the fill percentage stays <= 100", () => {
      // The floor holds 13 frames at 40_000 bytes = 520_000 bytes, well past
      // the configured 100_000-byte budget. The stats budget must reflect the
      // real resident ceiling so exactBytesPct never reads above 100.
      const cache = makeCache({
        exactWidth: 100,
        exactHeight: 100,
        exactBudgetBytes: 100000,
        minExactSlots: 13,
      });
      const frameBytes = 100 * 100 * 4;
      expect(cache.stats.exactBudgetBytes).toBe(13 * frameBytes);

      for (let i = 0; i < 13; i++)
        cache.putExact(frameAt(i * 1000), i * 1000, SRC, 100, 100);
      const stats = cache.stats;
      const residentBytes = stats.exactSize * frameBytes;
      const pct = (residentBytes / stats.exactBudgetBytes) * 100;
      expect(pct).toBeLessThanOrEqual(100);
    });
  });

  describe("frame identity", () => {
    it("adjacent frames keep a slot each where a bucket grid rounds two into one", () => {
      // 15fps frames sit 66.67ms apart, so a 67ms grid rounds frames 100 and
      // 101 onto one key and the second overwrites the first.
      const cache = makeCache({ exactBudgetBytes: 64 * MB, bucketMs: 67 });
      cache.putExact(frameAt(6667), 6667, SRC, 320, 180);
      cache.putExact(frameAt(6733), 6733, SRC, 320, 180);

      expect(cache.stats.exactSize).toBe(2);
      expect(cache.stats.bucketCollapses).toBe(0);
      expect(cache.get(6667, 50, 50)?.timestampMs).toBe(6667);
      expect(cache.get(6733, 50, 50)?.timestampMs).toBe(6733);
    });

    it("two frames under a millisecond apart keep a slot each", () => {
      // Nothing in the engine rejects a source past 1000fps, and both of these
      // frames round to the same millisecond.
      const timeline = FrameTimeline.uniform(2000, 8);
      const first = timeline.landingAt(1);
      const second = timeline.landingAt(2);
      const cache = makeCache({ exactBudgetBytes: 64 * MB });
      cache.putExact(first.frame, first.mediaTimeS * 1000, SRC, 320, 180);
      cache.putExact(second.frame, second.mediaTimeS * 1000, SRC, 320, 180);

      expect(cache.stats.exactSize).toBe(2);
      expect(cache.stats.bucketCollapses).toBe(0);
      expect(cache.get(0.5, 50, 50)?.timestampMs).toBe(0.5);
      expect(cache.get(1, 50, 50)?.timestampMs).toBe(1);
    });

    it("learns a frame span narrower than a millisecond", () => {
      const timeline = FrameTimeline.uniform(2000, 8);
      const first = timeline.landingAt(1);
      const second = timeline.landingAt(2);
      const cache = makeCache({ exactBudgetBytes: 64 * MB });
      cache.putExact(first.frame, first.mediaTimeS * 1000, SRC, 320, 180);
      cache.putExact(second.frame, second.mediaTimeS * 1000, SRC, 320, 180);

      // 1.6ms is past the span of the last resident frame, so it belongs to
      // one the cache does not hold.
      expect(cache.get(1.6, 50, 50)).toBeNull();
    });

    it("a frame keeps its own timestamp when it is not a whole millisecond", () => {
      // A 1/600-timebase source puts frames at 33.3333ms, and a cache-served
      // paint is what most scrub positions read.
      const cache = makeCache({ exactBudgetBytes: 64 * MB, bucketMs: 33 });
      cache.putExact(frameAt(100 / 3), 100 / 3, SRC, 320, 180);

      expect(cache.get(100 / 3, 5, 5)?.timestampMs).toBe(100 / 3);
    });

    it("a 30fps frame never answers for the next frame's timestamp", () => {
      // 33.33ms apart, so a neighbour's timestamp sits well inside a 50ms
      // reach of this one.
      const cache = makeCache({ exactBudgetBytes: 64 * MB, bucketMs: 33 });
      cache.putExact(frameAt(1000), 1000, SRC, 320, 180);
      cache.putExact(frameAt(1033), 1033, SRC, 320, 180);

      expect(cache.get(1000, 50, 50)?.timestampMs).toBe(1000);
      expect(cache.get(1033, 50, 50)?.timestampMs).toBe(1033);
      // The frame at 1067 is not resident, and no other frame is it.
      expect(cache.get(1067, 50, 50)).toBeNull();
    });

    it("falls back to the caller's tolerance until a second frame reveals the spacing", () => {
      const cache = makeCache({ exactBudgetBytes: 64 * MB, bucketMs: 33 });
      cache.putExact(frameAt(1000), 1000, SRC, 320, 180);

      // A lone frame is no evidence of how far apart frames are.
      expect(cache.get(1040, 50, 50)?.timestampMs).toBe(1000);

      // Its neighbour puts the source's 33ms spacing on the record, and
      // 1040 is a frame past 1000.
      cache.putExact(frameAt(967), 967, SRC, 320, 180);
      expect(cache.get(1040, 50, 50)).toBeNull();
    });

    it("learns the spacing from stored timestamps, not the declared interval", () => {
      // The declared interval claims 30fps; the frames are 15fps, where a
      // target 50ms past a frame is still that frame's.
      const cache = makeCache({ exactBudgetBytes: 64 * MB, bucketMs: 33 });
      cache.putExact(frameAt(0), 0, SRC, 320, 180);
      cache.putExact(frameAt(67), 67, SRC, 320, 180);

      expect(cache.get(50, 50, 50)?.timestampMs).toBe(0);
    });

    it("a target between two frames answers with the one behind it", () => {
      // 24fps, where no frame lands on a whole millisecond. The peek path is
      // handed a raw pointer position, so most lookups fall between frames.
      const cache = makeCache({ exactBudgetBytes: 64 * MB, bucketMs: 42 });
      cache.putExact(frameAt(1000 / 24), 1000 / 24, SRC, 320, 180);
      cache.putExact(frameAt(2000 / 24), 2000 / 24, SRC, 320, 180);

      // 83ms is a fraction of a millisecond short of the second frame, which
      // the position has not reached: a decode for it returns the first.
      expect(cache.get(83, 50, 50)?.timestampMs).toBe(1000 / 24);
    });

    it("a frame answers for its own fractional timestamp with a neighbour resident", () => {
      // The seek path queries at the frame time the tick table produced, so
      // the target equals the stored timestamp to the bit. Excluding it would
      // send every on-frame seek to the previous frame.
      const cache = makeCache({ exactBudgetBytes: 64 * MB, bucketMs: 42 });
      cache.putExact(frameAt(1000 / 24), 1000 / 24, SRC, 320, 180);
      cache.putExact(frameAt(2000 / 24), 2000 / 24, SRC, 320, 180);

      expect(cache.get(2000 / 24, 50, 50)?.timestampMs).toBe(2000 / 24);
    });

    it("the caller's tolerance still bounds a lookup inside one frame's span", () => {
      // 15fps: the frame span is wider than the 50ms constant, so the
      // constant is what binds.
      const cache = makeCache({ exactBudgetBytes: 64 * MB, bucketMs: 67 });
      cache.putExact(frameAt(0), 0, SRC, 320, 180);
      cache.putExact(frameAt(67), 67, SRC, 320, 180);

      expect(cache.get(40, 50, 50)?.timestampMs).toBe(0);
      expect(cache.get(60, 50, 50)).toBeNull();
    });
  });

  describe("variable frame rate", () => {
    /**
     * Frames at 0, 10, 1000, 1010: two tight pairs a second apart, the shape a
     * source takes when it holds on a still and then resumes. The tier learns
     * the smallest gap it has seen, which the tight pairs put at 10ms, and the
     * frame at 10 is on screen for the whole second after it. The 10ms comes
     * from those timestamps alone; `bucketMs` reaches diagnostics and keys
     * nothing, so it is a parameter here rather than the source of the spacing.
     */
    function vfrCache(bucketMs = 1): FrameCache {
      const cache = makeCache({ exactBudgetBytes: 64 * MB, bucketMs });
      for (const timestampMs of [0, 10, 1000, 1010]) {
        cache.putExact(frameAt(timestampMs), timestampMs, SRC, 320, 180);
      }
      return cache;
    }

    it("a frame reaches the shortest spacing learned, not its own span", () => {
      const cache = vfrCache();

      // 1000ms of tolerance covers every target's distance to the frame at 10,
      // so the learned 10ms spacing is the only thing left that can reject one.
      // The frame owns 990ms of this source and answers for the first 10 of
      // them: the frames at 0 and 10 together cover 20ms of [0, 1000), so a
      // sweep of that span is served 2.000% from the cache and decodes 98.000%.
      expect(cache.get(19.999, 1000, 1000)?.timestampMs).toBe(10);
      expect(cache.get(20, 1000, 1000)).toBeNull();
      expect(cache.get(500, 1000, 1000)).toBeNull();
      expect(cache.get(999.999, 1000, 1000)).toBeNull();
    });

    it("what it does answer with is the frame at or before the target", () => {
      const cache = vfrCache();

      expect(cache.get(0, 50, 50)?.timestampMs).toBe(0);
      expect(cache.get(5, 50, 50)?.timestampMs).toBe(0);
      expect(cache.get(10, 50, 50)?.timestampMs).toBe(10);
      expect(cache.get(15, 50, 50)?.timestampMs).toBe(10);
      expect(cache.get(1000, 50, 50)?.timestampMs).toBe(1000);
      expect(cache.get(1005, 50, 50)?.timestampMs).toBe(1000);
      expect(cache.get(1010, 50, 50)?.timestampMs).toBe(1010);
      expect(cache.get(1015, 50, 50)?.timestampMs).toBe(1010);
    });

    it("a generous tolerance does not widen the reach past the spacing", () => {
      const cache = vfrCache();

      // The frame at 1000 sits 5ms ahead of this target and deep inside the
      // tolerance, and a decode for 995 would never return it.
      expect(cache.get(995, 5000, 5000)).toBeNull();
      expect(cache.get(500, 5000, 5000)).toBeNull();

      // The learned spacing is what rejects them. The same two frames with
      // the tight pairs never seen leave the 10ms gap unlearned, and the
      // frame at 0 answers across the whole second.
      const sparse = makeCache({ exactBudgetBytes: 64 * MB });
      sparse.putExact(frameAt(0), 0, SRC, 320, 180);
      sparse.putExact(frameAt(1000), 1000, SRC, 320, 180);
      expect(sparse.get(500, 5000, 5000)?.timestampMs).toBe(0);
    });

    it("bucketMs is a diagnostics mark width and keys nothing", () => {
      const narrow = vfrCache(1);
      const wide = vfrCache(999);

      // Both tiers bound lookups by the gap between the timestamps they were
      // handed, so bucketMs 999 and bucketMs 1 answer every probe alike and
      // differ only in the number stats reports.
      for (const probe of [0, 5, 10, 15, 19.999, 20, 500, 995, 1000, 1005]) {
        expect(wide.get(probe, 1000, 1000)?.timestampMs ?? null).toBe(
          narrow.get(probe, 1000, 1000)?.timestampMs ?? null,
        );
      }
      expect(wide.get(1005, 1000, 1000)?.timestampMs).toBe(1000);
      expect(wide.get(500, 1000, 1000)).toBeNull();
      expect(wide.stats.bucketMs).toBe(999);
      expect(narrow.stats.bucketMs).toBe(1);
    });
  });

  describe("peek", () => {
    it("returns the same hit as get but does not count it", () => {
      const cache = makeCache({
        exactBudgetBytes: 64 * MB,
        previewCapacity: 8,
      });
      cache.putExact(frameAt(1000), 1000, SRC, 320, 180);

      const peeked = cache.peek(1000, 50, 50);
      expect(peeked?.tier).toBe(FrameTier.Exact);
      expect(peeked?.timestampMs).toBe(1000);
      // The lookup is invisible to the hit/miss accounting.
      expect(cache.stats.exactHits).toBe(0);
      expect(cache.stats.misses).toBe(0);

      // get() on the same target still counts, so the two together book a
      // single hit per gesture rather than two.
      cache.get(1000, 50, 50);
      expect(cache.stats.exactHits).toBe(1);
    });

    it("a peek miss is not counted either", () => {
      const cache = makeCache({
        exactBudgetBytes: 64 * MB,
        previewCapacity: 8,
      });
      expect(cache.peek(5000, 50, 50)).toBeNull();
      expect(cache.stats.misses).toBe(0);
    });
  });

  describe("bumpExact", () => {
    it("promotes an entry so a later entry evicts first", () => {
      // 40_000 bytes/frame, 80_000-byte budget = 2 slots.
      const cache = makeCache({
        exactWidth: 100,
        exactHeight: 100,
        exactBudgetBytes: 80000,
      });
      cache.putExact(frameAt(0), 0, SRC, 100, 100);
      cache.putExact(frameAt(1000), 1000, SRC, 100, 100);
      // Touch 0 so 1000 becomes the LRU victim of the next put.
      cache.bumpExact(0);
      cache.putExact(frameAt(2000), 2000, SRC, 100, 100);

      expect(cache.get(1000, 50, 50)).toBeNull();
      expect(cache.get(0, 50, 50)?.tier).toBe(FrameTier.Exact);
      expect(cache.get(2000, 50, 50)?.tier).toBe(FrameTier.Exact);
    });

    it("protects the frame under an off-grid gesture position", () => {
      // 40_000 bytes/frame, 80_000-byte budget = 2 slots.
      const cache = makeCache({
        exactWidth: 100,
        exactHeight: 100,
        exactBudgetBytes: 80000,
      });
      cache.putExact(frameAt(0), 0, SRC, 100, 100);
      cache.putExact(frameAt(33), 33, SRC, 100, 100);
      // The scheduler bumps with the gesture's position, which is not a
      // frame timestamp.
      cache.bumpExact(10);
      cache.putExact(frameAt(67), 67, SRC, 100, 100);

      expect(cache.get(33, 50, 50)).toBeNull();
      expect(cache.get(0, 50, 50)?.timestampMs).toBe(0);
    });

    it("does not count as a hit", () => {
      const cache = makeCache({
        exactWidth: 100,
        exactHeight: 100,
        exactBudgetBytes: 64 * MB,
      });
      cache.putExact(frameAt(0), 0, SRC, 100, 100);
      cache.bumpExact(0);
      expect(cache.stats.exactHits).toBe(0);
    });

    it("is a no-op on a miss", () => {
      const cache = makeCache({
        exactWidth: 100,
        exactHeight: 100,
        exactBudgetBytes: 64 * MB,
      });
      cache.bumpExact(5000);
      expect(cache.stats.exactHits).toBe(0);
      expect(cache.stats.misses).toBe(0);
    });
  });

  describe("tier preference", () => {
    it("prefers an exact hit over a preview hit", () => {
      const cache = makeCache({
        exactBudgetBytes: 64 * MB,
        previewCapacity: 8,
      });
      cache.putExact(frameAt(1000), 1000, SRC, 320, 180);
      cache.putPreview(1000, SRC, 320, 180);

      const hit = cache.get(1000, 50, 50);
      expect(hit?.tier).toBe(FrameTier.Exact);
      expect(cache.stats.exactHits).toBe(1);
      expect(cache.stats.previewHits).toBe(0);
    });

    it("falls back to preview when the exact tier misses", () => {
      const cache = makeCache({
        exactBudgetBytes: 64 * MB,
        previewCapacity: 8,
      });
      cache.putExact(frameAt(1000), 1000, SRC, 320, 180);
      cache.putPreview(5000, SRC, 320, 180);

      const hit = cache.get(5000, 50, 50);
      expect(hit?.tier).toBe(FrameTier.Preview);
      expect(cache.stats.previewHits).toBe(1);
    });
  });

  describe("disabled tiers", () => {
    it("drops puts when both tiers are zero-capacity", () => {
      const cache = makeCache();
      cache.putExact(frameAt(1000), 1000, SRC, 320, 180);
      cache.putPreview(1000, SRC, 320, 180);

      expect(cache.stats.exactCapacity).toBe(0);
      expect(cache.stats.previewCapacity).toBe(0);
      expect(cache.stats.exactSize).toBe(0);
      expect(cache.stats.previewSize).toBe(0);
      expect(cache.get(1000, 50, 50)).toBeNull();
    });
  });

  describe("stats", () => {
    it("counts hits per tier and misses", () => {
      const cache = makeCache({
        exactBudgetBytes: 64 * MB,
        previewCapacity: 8,
      });
      cache.putExact(frameAt(1000), 1000, SRC, 320, 180);
      cache.putPreview(2000, SRC, 320, 180);

      cache.get(1000, 50, 50);
      cache.get(2000, 50, 50);
      cache.get(9000, 50, 50);

      expect(cache.stats.exactHits).toBe(1);
      expect(cache.stats.previewHits).toBe(1);
      expect(cache.stats.misses).toBe(1);
    });

    it("exposes resident timestamps and bucket size for diagnostics", () => {
      const cache = makeCache({ exactBudgetBytes: 64 * MB, bucketMs: 1 });
      cache.putExact(frameAt(1000), 1000, SRC, 320, 180);
      cache.putExact(frameAt(2000), 2000, SRC, 320, 180);

      const stats = cache.stats;
      expect([...stats.exactTimestampsMs].sort((a, b) => a - b)).toEqual([
        1000, 2000,
      ]);
      expect(stats.bucketMs).toBe(1);
    });

    it("reports sizes and derived capacities", () => {
      const cache = makeCache({
        exactWidth: 100,
        exactHeight: 100,
        exactBudgetBytes: 100000,
        previewCapacity: 5,
      });
      expect(cache.stats.exactCapacity).toBe(2);
      expect(cache.stats.previewCapacity).toBe(5);

      cache.putExact(frameAt(0), 0, SRC, 100, 100);
      cache.putPreview(0, SRC, 320, 180);
      expect(cache.stats.exactSize).toBe(1);
      expect(cache.stats.previewSize).toBe(1);
    });
  });

  describe("clear", () => {
    it("empties both tiers", () => {
      const cache = makeCache({
        exactBudgetBytes: 64 * MB,
        previewCapacity: 8,
      });
      cache.putExact(frameAt(1000), 1000, SRC, 320, 180);
      cache.putPreview(2000, SRC, 320, 180);
      cache.clear();

      expect(cache.stats.exactSize).toBe(0);
      expect(cache.stats.previewSize).toBe(0);
      expect(cache.get(1000, 50, 50)).toBeNull();
      expect(cache.get(2000, 50, 50)).toBeNull();
    });
  });

  describe("diagnostics counters", () => {
    it("exact eviction past capacity surfaces in stats", () => {
      // 100x100x4 = 40_000 bytes/frame; a 100_000-byte budget yields 2 slots.
      const cache = makeCache({
        exactWidth: 100,
        exactHeight: 100,
        exactBudgetBytes: 100000,
      });
      cache.putExact(frameAt(0), 0, SRC, 100, 100);
      cache.putExact(frameAt(1000), 1000, SRC, 100, 100);
      cache.putExact(frameAt(2000), 2000, SRC, 100, 100);

      expect(cache.stats.exactEvictions).toBe(1);
      expect(cache.stats.previewEvictions).toBe(0);
    });

    it("re-decoding one frame increments bucketCollapses", () => {
      const cache = makeCache({ exactBudgetBytes: 64 * MB, bucketMs: 100 });
      // One frame decoded twice: same identity, so one slot.
      cache.putExact(frameAt(1010.2), 1010.2, SRC, 320, 180);
      cache.putExact(frameAt(1010.4), 1010.4, SRC, 320, 180);

      expect(cache.stats.bucketCollapses).toBe(1);
      expect(cache.stats.exactSize).toBe(1);
    });

    it("distinct frames never count as a collapse", () => {
      const cache = makeCache({ exactBudgetBytes: 64 * MB, bucketMs: 100 });
      cache.putExact(frameAt(1010), 1010, SRC, 320, 180);
      cache.putExact(frameAt(1020), 1020, SRC, 320, 180);

      expect(cache.stats.bucketCollapses).toBe(0);
      expect(cache.stats.exactSize).toBe(2);
    });

    it("stats expose the budget and per-tier frame dimensions", () => {
      const cache = makeCache({
        exactWidth: 640,
        exactHeight: 360,
        previewWidth: 320,
        exactBudgetBytes: 64 * MB,
        previewCapacity: 8,
      });
      const stats = cache.stats;
      expect(stats.exactBudgetBytes).toBe(64 * MB);
      expect(stats.exactFrameWidth).toBe(640);
      expect(stats.exactFrameHeight).toBe(360);
      expect(stats.previewFrameWidth).toBe(320);
      expect(stats.previewFrameHeight).toBe(180);
    });

    it("resident bytes derive from size x width x height x 4", () => {
      const cache = makeCache({
        exactWidth: 100,
        exactHeight: 100,
        exactBudgetBytes: 64 * MB,
      });
      cache.putExact(frameAt(0), 0, SRC, 100, 100);
      cache.putExact(frameAt(1000), 1000, SRC, 100, 100);

      const stats = cache.stats;
      const exactBytes =
        stats.exactSize * stats.exactFrameWidth * stats.exactFrameHeight * 4;
      expect(exactBytes).toBe(2 * 100 * 100 * 4);
    });
  });
});

/** The grid the preview tier's keys land on, since `putPreview` keys by rounded
 *  millisecond. A tier keyed by frame identity passes 0. */
const ROUNDED_MS_KEY_GRID = 1;

/** What the exact tier passes: its keys are frame identities rather than
 *  rounded times, so no gap between two stored frames is a key-rounding
 *  artifact. */
const FRAME_IDENTITY_KEY_GRID = 0;

describe("TierStore spacing", () => {
  it("does not learn a gap under the key grid as the frame interval", () => {
    const tier = new TierStore(4, 32, 18, ROUNDED_MS_KEY_GRID);
    // One frame whose PTS lands on 1000.5ms, decoded twice with the
    // half-microsecond slop a WebCodecs timestamp carries: it rounds onto two
    // keys, so both copies are resident a thousandth of a millisecond apart.
    tier.put(1000, 1000.4995, SRC, 320, 180);
    tier.put(1001, 1000.5005, SRC, 320, 180);

    expect(tier.get(1000.6, 50, true)?.timestampMs).toBe(1000.5005);
  });

  it("bounds an at-or-before lookup by a learned interval", () => {
    const tier = new TierStore(4, 32, 18, ROUNDED_MS_KEY_GRID);
    tier.put(0, 0, SRC, 320, 180);
    tier.put(33, 33.367, SRC, 320, 180);

    expect(tier.get(40, 50, true)?.timestampMs).toBe(33.367);
    expect(tier.get(80, 50, true)).toBeNull();
  });

  it("holds a learned interval after every frame that taught it is evicted", () => {
    const tier = new TierStore(2, 32, 18, FRAME_IDENTITY_KEY_GRID);
    // A tight pair teaches a 10ms interval, then a pair five seconds later
    // fills both slots and evicts both of them. The interval only ever narrows,
    // so it outlives the frames that justified it: nothing 10ms apart is
    // resident, yet a 10ms bound still governs a lookup handed 5000ms.
    tier.put(0, 0, SRC, 320, 180);
    tier.put(10, 10, SRC, 320, 180);
    tier.put(5000, 5000, SRC, 320, 180);
    tier.put(6000, 6000, SRC, 320, 180);
    expect(tier.timestampsSnapshot()).toEqual([5000, 6000]);

    expect(tier.get(5009, 5000, true)?.timestampMs).toBe(5000);
    expect(tier.get(5010, 5000, true)).toBeNull();
    expect(tier.get(5500, 5000, true)).toBeNull();

    // The same two survivors in a tier that never saw the tight pair carry a
    // 1000ms interval, so the history and not the residents is what decides.
    const fresh = new TierStore(2, 32, 18, FRAME_IDENTITY_KEY_GRID);
    fresh.put(5000, 5000, SRC, 320, 180);
    fresh.put(6000, 6000, SRC, 320, 180);

    expect(fresh.get(5500, 5000, true)?.timestampMs).toBe(5000);
  });
});
