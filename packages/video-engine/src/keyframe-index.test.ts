import { describe, expect, it } from "vitest";

import { KeyframeIndex, type KeyframePacketLike } from "./keyframe-index";

/**
 * Fake probe over a fixed, ascending keyframe list. Packets are real objects
 * resolved by reference identity in getNextKeyPacket, so a test fails loudly if
 * the index ever reconstructs a packet from its timestamp instead of threading
 * the original object back through.
 */
class FakeKeyframeProbe {
  readonly metadataFlags: Array<boolean | undefined> = [];
  keyPacketCalls = 0;
  nextKeyPacketCalls = 0;
  private readonly packets: ReadonlyArray<KeyframePacketLike>;

  constructor(keyframeTimes: readonly number[]) {
    this.packets = keyframeTimes.map((timestamp) => ({ timestamp }));
  }

  getKeyPacket(
    timestamp: number,
    options?: { readonly metadataOnly?: boolean },
  ): Promise<KeyframePacketLike | null> {
    this.keyPacketCalls += 1;
    this.metadataFlags.push(options?.metadataOnly);
    let found: KeyframePacketLike | null = null;
    for (const packet of this.packets) {
      if (packet.timestamp <= timestamp) found = packet;
      else break;
    }
    return Promise.resolve(found);
  }

  getNextKeyPacket(
    packet: KeyframePacketLike,
    options?: { readonly metadataOnly?: boolean },
  ): Promise<KeyframePacketLike | null> {
    this.nextKeyPacketCalls += 1;
    this.metadataFlags.push(options?.metadataOnly);
    const idx = this.packets.indexOf(packet);
    if (idx < 0 || idx + 1 >= this.packets.length) return Promise.resolve(null);
    return Promise.resolve(this.packets[idx + 1]);
  }
}

const KEYFRAMES = [0, 2, 4, 6, 8];

describe("KeyframeIndex", () => {
  it("keyframeAtOrBefore returns the nearest keyframe at or before the target", async () => {
    const index = new KeyframeIndex(new FakeKeyframeProbe(KEYFRAMES));
    expect(await index.keyframeAtOrBefore(5)).toBe(4);
    expect(await index.keyframeAtOrBefore(4)).toBe(4);
    expect(await index.keyframeAtOrBefore(0)).toBe(0);
  });

  it("keyframeAtOrBefore returns null before the first keyframe", async () => {
    const index = new KeyframeIndex(new FakeKeyframeProbe([2, 4, 6]));
    expect(await index.keyframeAtOrBefore(1)).toBeNull();
  });

  it("nextKeyframeAfter returns the first keyframe strictly after the target", async () => {
    const index = new KeyframeIndex(new FakeKeyframeProbe(KEYFRAMES));
    expect(await index.nextKeyframeAfter(5)).toBe(6);
    expect(await index.nextKeyframeAfter(4)).toBe(6);
  });

  it("nextKeyframeAfter returns null past the last keyframe", async () => {
    const index = new KeyframeIndex(new FakeKeyframeProbe(KEYFRAMES));
    expect(await index.nextKeyframeAfter(8)).toBeNull();
    expect(await index.nextKeyframeAfter(9)).toBeNull();
  });

  it("nextKeyframeAfter returns null before the first keyframe", async () => {
    const index = new KeyframeIndex(new FakeKeyframeProbe([2, 4, 6]));
    expect(await index.nextKeyframeAfter(1)).toBeNull();
  });

  it("keyframesCovering spans the anchor at or before start through end", async () => {
    const index = new KeyframeIndex(new FakeKeyframeProbe(KEYFRAMES));
    expect(await index.keyframesCovering(3, 7)).toEqual([2, 4, 6]);
  });

  it("keyframesCovering returns a single anchor when the window fits one GOP", async () => {
    const index = new KeyframeIndex(new FakeKeyframeProbe(KEYFRAMES));
    expect(await index.keyframesCovering(4.2, 5.8)).toEqual([4]);
  });

  it("keyframesCovering is empty when the window starts before the first keyframe", async () => {
    const index = new KeyframeIndex(new FakeKeyframeProbe([2, 4, 6]));
    expect(await index.keyframesCovering(0, 1)).toEqual([]);
  });

  it("known stays ascending and deduplicated across overlapping probes", async () => {
    const index = new KeyframeIndex(new FakeKeyframeProbe(KEYFRAMES));
    await index.keyframesCovering(3, 7);
    await index.keyframeAtOrBefore(8);
    await index.keyframesCovering(1, 5);
    expect(index.known).toEqual([0, 2, 4, 6, 8]);
  });

  it("cachedAtOrBefore answers from memory without probing", async () => {
    const probe = new FakeKeyframeProbe(KEYFRAMES);
    const index = new KeyframeIndex(probe);
    await index.keyframesCovering(0, 8);
    const callsAfterWarmup = probe.keyPacketCalls;
    expect(index.cachedAtOrBefore(5)).toBe(4);
    expect(index.cachedAtOrBefore(8)).toBe(8);
    expect(probe.keyPacketCalls).toBe(callsAfterWarmup);
  });

  it("cachedAtOrBefore returns null until a keyframe at or before the target is known", () => {
    const index = new KeyframeIndex(new FakeKeyframeProbe(KEYFRAMES));
    expect(index.cachedAtOrBefore(5)).toBeNull();
  });

  it("every probe runs metadata-only", async () => {
    const probe = new FakeKeyframeProbe(KEYFRAMES);
    const index = new KeyframeIndex(probe);
    await index.keyframesCovering(1, 7);
    await index.nextKeyframeAfter(3);
    expect(probe.metadataFlags.every((flag) => flag === true)).toBe(true);
  });

  describe("ensureFullyIndexed (T6)", () => {
    it("enumerates every keyframe in the track", async () => {
      const index = new KeyframeIndex(new FakeKeyframeProbe(KEYFRAMES));
      await index.ensureFullyIndexed();
      expect(index.known).toEqual([0, 2, 4, 6, 8]);
    });

    it("anchors at a non-zero origin and still reaches the track end", async () => {
      // Offset clip: first keyframe at 2. getKeyPacket(0) would return null,
      // so the walk must anchor at the origin to enumerate the whole file.
      const index = new KeyframeIndex(new FakeKeyframeProbe([2, 4, 6, 8]));
      await index.ensureFullyIndexed(2);
      expect(index.known).toEqual([2, 4, 6, 8]);
    });

    it("walks metadata-only, decoding nothing", async () => {
      const probe = new FakeKeyframeProbe(KEYFRAMES);
      const index = new KeyframeIndex(probe);
      await index.ensureFullyIndexed();
      expect(probe.metadataFlags.every((flag) => flag === true)).toBe(true);
    });

    it("is idempotent: a second call probes no further packets", async () => {
      const probe = new FakeKeyframeProbe(KEYFRAMES);
      const index = new KeyframeIndex(probe);
      await index.ensureFullyIndexed();
      const keyAfterFirst = probe.keyPacketCalls;
      const nextAfterFirst = probe.nextKeyPacketCalls;
      await index.ensureFullyIndexed();
      expect(probe.keyPacketCalls).toBe(keyAfterFirst);
      expect(probe.nextKeyPacketCalls).toBe(nextAfterFirst);
      expect(index.known).toEqual([0, 2, 4, 6, 8]);
    });

    it("is a no-op on a track with no keyframes", async () => {
      const index = new KeyframeIndex(new FakeKeyframeProbe([]));
      await index.ensureFullyIndexed();
      expect(index.known).toEqual([]);
    });
  });

  describe("diagnostics", () => {
    it("probeCount counts container round-trips, not memory hits", async () => {
      const index = new KeyframeIndex(new FakeKeyframeProbe(KEYFRAMES));
      expect(index.probeCount).toBe(0);
      await index.keyframeAtOrBefore(5);
      const afterFirst = index.probeCount;
      expect(afterFirst).toBeGreaterThan(0);
      // cachedAtOrBefore resolves from memory, so the probe count holds.
      index.cachedAtOrBefore(5);
      expect(index.probeCount).toBe(afterFirst);
    });

    it("gopStats reports the gap distribution in one pass", async () => {
      const index = new KeyframeIndex(new FakeKeyframeProbe([0, 2, 4, 6, 8]));
      await index.keyframesCovering(0, 8);
      const stats = index.gopStats();
      expect(stats.count).toBe(5);
      expect(stats.avgGopS).toBeCloseTo(2);
      expect(stats.maxGopS).toBeCloseTo(2);
      expect(stats.minGopS).toBeCloseTo(2);
      expect(stats.stddevS).toBeCloseTo(0);
      expect(stats.densityPerS).toBeCloseTo(0.5);
    });

    it("gopStats density spreads discovered keyframes over the track duration", async () => {
      // Five keyframes discovered in a clustered [0, 8] span, but the clip
      // runs 40s. Density against the span reads 0.5/s, against the duration
      // it reads the honest track-wide 4 gaps / 40s = 0.1/s.
      const index = new KeyframeIndex(new FakeKeyframeProbe([0, 2, 4, 6, 8]));
      await index.keyframesCovering(0, 8);
      expect(index.gopStats().densityPerS).toBeCloseTo(0.5);
      expect(index.gopStats(40).densityPerS).toBeCloseTo(0.1);
    });

    it("gopStats captures an irregular max gap", async () => {
      const index = new KeyframeIndex(new FakeKeyframeProbe([0, 1, 2, 10]));
      await index.keyframesCovering(0, 10);
      const stats = index.gopStats();
      expect(stats.maxGopS).toBeCloseTo(8);
      expect(stats.minGopS).toBeCloseTo(1);
      expect(stats.stddevS).toBeGreaterThan(0);
    });

    it("gopStats does not divide by zero on empty or single-keyframe sets", async () => {
      const empty = new KeyframeIndex(new FakeKeyframeProbe([]));
      expect(empty.gopStats()).toEqual({
        count: 0,
        avgGopS: 0,
        maxGopS: 0,
        minGopS: 0,
        stddevS: 0,
        densityPerS: 0,
      });
      const single = new KeyframeIndex(new FakeKeyframeProbe([3]));
      await single.keyframeAtOrBefore(3);
      const stats = single.gopStats();
      expect(stats.count).toBe(1);
      expect(stats.avgGopS).toBe(0);
      expect(stats.densityPerS).toBe(0);
    });
  });
});
