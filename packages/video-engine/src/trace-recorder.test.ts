import { describe, expect, it } from "vitest";

import type { DiagnosticsSnapshot } from "./diagnostics";
import type { FrameCacheStats } from "./frame-cache";
import type { SchedulerStats } from "./scrub-cursor";
import {
  TRACE_SCHEMA,
  TraceRecorder,
  type TraceRecorderEnvironment,
} from "./trace-recorder";

/**
 * Ring + assemble contract for TraceRecorder: fixed capacity overwrites oldest,
 * appends are O(1) with no growth, and assemble() emits a versioned doc whose
 * events are ascending and whose summary carries the latest snapshot's warnings.
 * A monotonic fake clock drives elapsedMs/durationMs deterministically.
 */

const ENV: TraceRecorderEnvironment = {
  userAgent: "vitest",
  webgpuAvailable: false,
  devicePixelRatio: 2,
  hardwareConcurrency: 8,
};

function makeClock(start = 0): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** Every stat but the lookup counters and the eviction count is inert here;
 *  those are all the summary reads. */
function schedulerWithLookups(hits: number, misses: number): SchedulerStats {
  const cache: FrameCacheStats = {
    exactHits: hits,
    previewHits: 0,
    misses,
    exactSize: 0,
    previewSize: 0,
    exactCapacity: 30,
    previewCapacity: 0,
    exactTimestampsMs: [],
    previewTimestampsMs: [],
    bucketMs: 33,
    exactEvictions: 0,
    previewEvictions: 0,
    bucketCollapses: 0,
    exactFrameWidth: 640,
    exactFrameHeight: 360,
    previewFrameWidth: 320,
    previewFrameHeight: 180,
    exactBudgetBytes: 0,
  };
  return {
    mode: "idle",
    decodePath: "canvas",
    cache,
    scrub: {
      samples: 0,
      lastMs: 0,
      avgMs: 0,
      maxMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      targetVsLandedMs: 0,
      timeToCrispMs: 0,
    },
    decode: {
      foreground: 0,
      prefetchExact: 0,
      prefetchPreview: 0,
      keyframeAnchored: 0,
      framesOut: 0,
      nextPending: 0,
    },
    seek: { exact: 0, key: 0, coalesceDepth: 0 },
    gop: {
      count: 0,
      avgGopS: 0,
      maxGopS: 0,
      minGopS: 0,
      stddevS: 0,
      densityPerS: 0,
    },
    probeRoundTrips: 0,
    keyframesMs: [],
    prefetch: null,
    prefetchState: { inFlight: false, generation: 0 },
    exactToleranceMs: 50,
    previewToleranceMs: 250,
    decoderDead: false,
    decoderStalled: false,
    drain: { draining: false, pendingTargetMs: null, recovering: false },
  };
}

function playingSnapshot(paints: number): DiagnosticsSnapshot {
  return snapshotWith({
    status: "PLAYING",
    realtime: { ...snapshotWith().realtime, paints },
  });
}

function snapshotWith(
  overrides: Partial<DiagnosticsSnapshot> = {},
): DiagnosticsSnapshot {
  return {
    renderer: "webgpu",
    track: null,
    scheduler: null,
    realtime: {
      // Always null on the wire: the worker fills nothing into it.
      effectivePaintFps: null,
      catchUpMs: 0,
      lateFrames: 0,
      stalls: 0,
      ticks: 0,
      paints: 0,
      playQueueDepth: 0,
      droppedFrames: 0,
    },
    pipeline: { decodedFrames: null, paintedFrames: 0, droppedFrames: 0 },
    cacheBytes: {
      exactBytes: 0,
      previewBytes: 0,
      exactBudgetBytes: 0,
      exactBytesPct: 0,
    },
    geometry: {
      nativeWidth: null,
      nativeHeight: null,
      decodeWidth: 0,
      decodeHeight: 0,
      downscaleRatio: null,
      decodeVsDisplayAreaRatio: null,
      boundCanvasWidth: null,
      boundCanvasHeight: null,
    },
    gop: {
      count: 0,
      avgGopS: 0,
      maxGopS: 0,
      minGopS: 0,
      stddevS: 0,
      densityPerS: 0,
      distanceToNearestKeyframeS: null,
      estimatedGopWalkDepthFrames: 0,
    },
    scrub: {
      samples: 0,
      avgMs: 0,
      maxMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      targetVsLandedMs: 0,
      timeToCrispMs: 0,
      cacheHitRatePct: 0,
    },
    playSeek: { seeks: 0, samples: 0, avgMs: 0, maxMs: 0 },
    counters: {
      foregroundDecodes: 0,
      prefetchExact: 0,
      prefetchPreview: 0,
      keyframeAnchored: 0,
      exactSeeks: 0,
      keySeeks: 0,
      seekCoalesceDepth: 0,
      probeRoundTrips: 0,
      prefetchInFlight: false,
      prefetchGeneration: 0,
      nextPending: 0,
      seekDrainingForMs: 0,
    },
    memory: { jsHeapUsedBytes: null },
    nativeFps: 30,
    rate: 1,
    presentedRate: null,
    playheadMs: null,
    screen: null,
    status: "PAUSED",
    webgpuAvailable: false,
    warnings: [],
    ...overrides,
  };
}

describe("TraceRecorder", () => {
  it("the event ring overwrites oldest past capacity", () => {
    const clock = makeClock();
    const recorder = new TraceRecorder(ENV, clock.now, 3, 3);
    for (let i = 0; i < 5; i++) recorder.pushEvent({ type: "paint", tMs: i });

    const trace = recorder.assemble();
    // Capacity 3: only the last three pushes survive, oldest-first.
    expect(trace.events.map((e) => e.tMs)).toEqual([2, 3, 4]);
  });

  it("the snapshot ring overwrites oldest past capacity", () => {
    const clock = makeClock();
    const recorder = new TraceRecorder(ENV, clock.now, 10, 2);
    recorder.pushSnapshot(snapshotWith({ status: "A" }));
    recorder.pushSnapshot(snapshotWith({ status: "B" }));
    recorder.pushSnapshot(snapshotWith({ status: "C" }));

    const trace = recorder.assemble();
    expect(trace.snapshots.map((s) => s.status)).toEqual(["B", "C"]);
  });

  it("assemble emits a versioned doc with ascending event timestamps", () => {
    const clock = makeClock();
    const recorder = new TraceRecorder(ENV, clock.now, 100, 100);
    recorder.pushEvent({ type: "paint", tMs: recorder.elapsedMs() });
    clock.advance(16);
    recorder.pushEvent({ type: "paint", tMs: recorder.elapsedMs() });
    clock.advance(16);
    recorder.pushEvent({
      type: "seek",
      tMs: recorder.elapsedMs(),
      targetMs: 5000,
    });

    const trace = recorder.assemble();
    expect(trace.schema).toBe(TRACE_SCHEMA);
    expect(trace.environment).toEqual(ENV);
    const stamps = trace.events.map((e) => e.tMs);
    expect([...stamps]).toEqual([...stamps].sort((a, b) => a - b));
    expect(trace.durationMs).toBe(32);
  });

  it("summary carries the latest snapshot's warnings", () => {
    const clock = makeClock();
    const recorder = new TraceRecorder(ENV, clock.now, 10, 10);
    recorder.pushSnapshot(snapshotWith({ warnings: [] }));
    recorder.pushSnapshot(
      snapshotWith({
        warnings: [
          {
            id: "LONG_GOP",
            severity: "critical",
            title: "Long GOPs",
            scenario: "x",
            advice: "y",
            evidence: "z",
          },
        ],
        scheduler: schedulerWithLookups(55, 45),
        scrub: {
          samples: 1,
          avgMs: 0,
          maxMs: 120,
          p50Ms: 40,
          p95Ms: 110,
          targetVsLandedMs: 0,
          timeToCrispMs: 0,
          cacheHitRatePct: 55,
        },
      }),
    );

    const { summary } = recorder.assemble();
    expect(summary.warnings.map((w) => w.id)).toEqual(["LONG_GOP"]);
    expect(summary.scrubP95Ms).toBe(110);
    expect(summary.cacheHitRatePct).toBe(55);
    expect(summary.cacheLookups).toBe(100);
  });

  it("the hit rate reads unknown, not zero, when nothing looked the cache up", () => {
    const recorder = new TraceRecorder(ENV, makeClock().now, 10, 10);
    recorder.pushSnapshot(
      snapshotWith({ scheduler: schedulerWithLookups(0, 0) }),
    );

    const { summary } = recorder.assemble();
    expect(summary.cacheHitRatePct).toBeNull();
    expect(summary.cacheLookups).toBe(0);
  });

  it("paint rate is measured across the captured window", () => {
    const clock = makeClock();
    const recorder = new TraceRecorder(ENV, clock.now, 10, 10);
    recorder.pushSnapshot(playingSnapshot(0));
    clock.advance(1000);
    recorder.pushSnapshot(playingSnapshot(15));
    clock.advance(1000);
    recorder.pushSnapshot(playingSnapshot(45));

    // 45 frames over the two seconds those snapshots spanned.
    expect(recorder.assemble().summary.effectivePaintFps).toBeCloseTo(22.5);
  });

  it("paint rate counts only the stretches spent playing", () => {
    const clock = makeClock();
    const recorder = new TraceRecorder(ENV, clock.now, 10, 10);
    recorder.pushSnapshot(playingSnapshot(0));
    clock.advance(1000);
    recorder.pushSnapshot(playingSnapshot(30));
    // A long pause paints nothing; folding it in would halve a rate the user
    // saw as a steady 30fps.
    clock.advance(9000);
    recorder.pushSnapshot(
      snapshotWith({ realtime: { ...snapshotWith().realtime, paints: 30 } }),
    );

    expect(recorder.assemble().summary.effectivePaintFps).toBeCloseTo(30);
  });

  it("paint rate survives the counter reset a new play session brings", () => {
    const clock = makeClock();
    const recorder = new TraceRecorder(ENV, clock.now, 10, 10);
    recorder.pushSnapshot(playingSnapshot(0));
    clock.advance(1000);
    recorder.pushSnapshot(playingSnapshot(30));
    clock.advance(1000);
    // Replay restarts the counter, so the delta goes negative.
    recorder.pushSnapshot(playingSnapshot(0));
    clock.advance(1000);
    recorder.pushSnapshot(playingSnapshot(30));

    expect(recorder.assemble().summary.effectivePaintFps).toBeCloseTo(30);
  });

  it("a dead pump reads as zero paint rate rather than unknown", () => {
    const clock = makeClock();
    const recorder = new TraceRecorder(ENV, clock.now, 10, 10);
    recorder.pushSnapshot(playingSnapshot(0));
    clock.advance(2000);
    recorder.pushSnapshot(playingSnapshot(0));

    expect(recorder.assemble().summary.effectivePaintFps).toBe(0);
  });

  it("max catch-up is the peak across captured snapshots", () => {
    const clock = makeClock();
    const recorder = new TraceRecorder(ENV, clock.now, 10, 10);
    recorder.pushSnapshot(
      snapshotWith({ realtime: { ...snapshotWith().realtime, catchUpMs: 30 } }),
    );
    recorder.pushSnapshot(
      snapshotWith({ realtime: { ...snapshotWith().realtime, catchUpMs: 90 } }),
    );
    recorder.pushSnapshot(
      snapshotWith({ realtime: { ...snapshotWith().realtime, catchUpMs: 45 } }),
    );

    expect(recorder.assemble().summary.maxCatchUpMs).toBe(90);
  });

  it("every captured snapshot carries the environment's WebGPU answer", () => {
    const recorder = new TraceRecorder(
      { ...ENV, webgpuAvailable: true },
      makeClock().now,
      10,
      10,
    );
    // What the worker broadcasts: the field is left empty there for the main
    // thread to fill on its own copy, which the ring never sees.
    recorder.pushSnapshot(snapshotWith({ webgpuAvailable: false }));

    const trace = recorder.assemble();
    expect(trace.snapshots.map((s) => s.webgpuAvailable)).toEqual([true]);
    expect(trace.environment.webgpuAvailable).toBe(true);
  });

  it("effective fps is recomputable from the captured series alone", () => {
    const clock = makeClock();
    const recorder = new TraceRecorder(ENV, clock.now, 10, 10);
    recorder.pushSnapshot(playingSnapshot(0));
    clock.advance(1000);
    recorder.pushSnapshot(playingSnapshot(24));

    const { snapshots } = recorder.assemble();
    const first = snapshots[0];
    const last = snapshots[snapshots.length - 1];
    const offline =
      ((last.realtime.paints - first.realtime.paints) /
        (last.tMs - first.tMs)) *
      1000;
    expect(offline).toBeCloseTo(24);
  });

  it("coverage states the window each ring still holds", () => {
    const clock = makeClock();
    const recorder = new TraceRecorder(ENV, clock.now, 10, 2);
    recorder.pushEvent({ type: "paint", tMs: recorder.elapsedMs() });
    recorder.pushSnapshot(snapshotWith());
    clock.advance(1000);
    recorder.pushSnapshot(snapshotWith());
    clock.advance(1000);
    recorder.pushSnapshot(snapshotWith());
    clock.advance(500);

    const { coverage, durationMs } = recorder.assemble();
    expect(durationMs).toBe(2500);
    // The event ring kept everything, so it still reaches back to arm.
    expect(coverage.events.dropped).toBe(0);
    expect(coverage.events.coveredMs).toBe(2500);
    // The snapshot ring dropped the arm-time snapshot, so it answers for the
    // 1.5s since the oldest one it kept, not for the whole capture.
    expect(coverage.snapshots.capacity).toBe(2);
    expect(coverage.snapshots.retained).toBe(2);
    expect(coverage.snapshots.dropped).toBe(1);
    expect(coverage.snapshots.oldestTMs).toBe(1000);
    expect(coverage.snapshots.coveredMs).toBe(1500);
  });

  it("a capture cut short says why, and the first reason is the one that ended it", () => {
    const recorder = new TraceRecorder(ENV, makeClock().now, 10, 10);
    expect(recorder.assemble().truncatedReason).toBeNull();

    recorder.truncate("engine disposed");
    recorder.truncate("something later");
    expect(recorder.assemble().truncatedReason).toBe("engine disposed");
  });

  it("an empty recorder assembles a valid, empty doc", () => {
    const recorder = new TraceRecorder(ENV, makeClock().now, 10, 10);
    const trace = recorder.assemble();
    expect(trace.events).toEqual([]);
    expect(trace.snapshots).toEqual([]);
    expect(trace.summary.warnings).toEqual([]);
    expect(trace.summary.effectivePaintFps).toBeNull();
    expect(trace.summary.cacheHitRatePct).toBeNull();
  });
});

describe("TraceRecorder summary peaks", () => {
  const realtime = (
    stalls: number,
    lateFrames: number,
  ): DiagnosticsSnapshot["realtime"] => ({
    effectivePaintFps: null,
    catchUpMs: 0,
    lateFrames,
    stalls,
    ticks: 0,
    paints: 0,
    playQueueDepth: 0,
    droppedFrames: 0,
  });

  it("stalls and late frames report the worst the capture saw, not the last reading", () => {
    let t = 0;
    const recorder = new TraceRecorder(ENV, () => (t += 100));
    const bad = snapshotWith({ realtime: realtime(7, 4) });
    const reset = snapshotWith({ realtime: realtime(0, 0) });

    recorder.pushSnapshot(bad);
    // A play restart zeroes the per-session counters, so the last reading
    // says nothing happened.
    recorder.pushSnapshot(reset);

    const summary = recorder.assemble().summary;
    expect(summary.stalls).toBe(7);
    expect(summary.lateFrames).toBe(4);
  });

  it("each snapshot carries when it was taken, so the series lines up with the events", () => {
    let t = 0;
    const recorder = new TraceRecorder(ENV, () => (t += 100));
    recorder.pushSnapshot(snapshotWith({ realtime: realtime(0, 0) }));
    recorder.pushSnapshot(snapshotWith({ realtime: realtime(0, 0) }));

    const stamps = recorder.assemble().snapshots.map((s) => s.tMs);
    expect(stamps).toHaveLength(2);
    expect(stamps[1]).toBeGreaterThan(stamps[0]);
  });
});
