import { describe, expect, it } from "vitest";

import {
  type DiagnosticsSnapshot,
  evaluateWarnings,
  type WarningSeverity,
} from "./diagnostics";
import type { SchedulerStats } from "./scrub-cursor";

/**
 * Pure threshold contract for evaluateWarnings: each rule fires on a snapshot
 * crafted to trip exactly it, the healthy baseline trips nothing, and the
 * returned list is ordered critical-first. The snapshot is built by deep-merging
 * a healthy base so each test perturbs only the fields its rule reads.
 */

function healthyScheduler(): SchedulerStats {
  return {
    mode: "idle",
    decodePath: "canvas",
    cache: {
      exactHits: 90,
      previewHits: 0,
      misses: 10,
      exactSize: 10,
      previewSize: 10,
      exactCapacity: 30,
      previewCapacity: 64,
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
      exactBudgetBytes: 64 * 1024 * 1024,
    },
    scrub: {
      samples: 10,
      lastMs: 40,
      avgMs: 40,
      maxMs: 80,
      p50Ms: 40,
      p95Ms: 90,
      targetVsLandedMs: 10,
      timeToCrispMs: 50,
    },
    decode: {
      foreground: 10,
      prefetchExact: 20,
      prefetchPreview: 5,
      keyframeAnchored: 2,
      framesOut: 35,
      nextPending: 0,
    },
    seek: { exact: 10, key: 2, coalesceDepth: 0 },
    gop: {
      count: 30,
      avgGopS: 2,
      maxGopS: 2.2,
      minGopS: 1.8,
      stddevS: 0.1,
      densityPerS: 0.5,
    },
    probeRoundTrips: 5,
    keyframesMs: [],
    prefetch: { targetsMs: [] },
    prefetchState: { inFlight: false, generation: 3 },
    exactToleranceMs: 50,
    previewToleranceMs: 250,
    decoderDead: false,
    decoderStalled: false,
    drain: { draining: false, pendingTargetMs: null, recovering: false },
  };
}

function healthySnapshot(): DiagnosticsSnapshot {
  const scheduler = healthyScheduler();
  return {
    presentation: "canvas",
    renderer: "webgpu",
    track: {
      decodeWidth: 640,
      decodeHeight: 360,
      nativeFps: 30,
      durationS: 60,
    },
    scheduler,
    realtime: {
      effectivePaintFps: null,
      catchUpMs: 10,
      lateFrames: 0,
      stalls: 0,
      ticks: 1000,
      paints: 900,
      playQueueDepth: 3,
      droppedFrames: 0,
    },
    pipeline: { decodedFrames: 950, paintedFrames: 900, droppedFrames: 0 },
    cacheBytes: {
      exactBytes: 10 * 1024 * 1024,
      previewBytes: 1024 * 1024,
      exactBudgetBytes: 64 * 1024 * 1024,
      exactBytesPct: 15,
    },
    geometry: {
      nativeWidth: 1280,
      nativeHeight: 720,
      decodeWidth: 640,
      decodeHeight: 360,
      downscaleRatio: 0.5,
      decodeVsDisplayAreaRatio: 1,
      boundCanvasWidth: 640,
      boundCanvasHeight: 360,
    },
    gop: {
      ...scheduler.gop,
      distanceToNearestKeyframeS: 0.5,
      estimatedGopWalkDepthFrames: 60,
    },
    scrub: {
      samples: 10,
      avgMs: 40,
      maxMs: 80,
      p50Ms: 40,
      p95Ms: 90,
      targetVsLandedMs: 10,
      timeToCrispMs: 50,
      cacheHitRatePct: 90,
    },
    playSeek: { seeks: 0, samples: 0, avgMs: 0, maxMs: 0 },
    counters: {
      foregroundDecodes: 10,
      prefetchExact: 20,
      prefetchPreview: 5,
      keyframeAnchored: 2,
      exactSeeks: 10,
      keySeeks: 2,
      seekCoalesceDepth: 0,
      probeRoundTrips: 5,
      prefetchInFlight: false,
      prefetchGeneration: 3,
      nextPending: 0,
      seekDrainingForMs: 0,
    },
    memory: { jsHeapUsedBytes: 50 * 1024 * 1024 },
    sourceResidency: null,
    nativeFps: 30,
    rate: 1,
    presentedRate: null,
    playheadMs: 1000,
    screen: {
      frameId: { index: 30, ticks: 30000 },
      mediaTimeMs: 1000,
      quality: "exact",
    },
    status: "PAUSED",
    webgpuAvailable: true,
    warnings: [],
  };
}

type DeepPartial<T> = { [K in keyof T]?: DeepPartial<T[K]> };

function merge<T>(base: T, patch: DeepPartial<T>): T {
  const out = { ...base } as Record<string, unknown>;
  for (const key of Object.keys(patch) as Array<keyof T>) {
    const value = patch[key];
    const current = (base as Record<string, unknown>)[key as string];
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      current &&
      typeof current === "object"
    ) {
      out[key as string] = merge(current, value as DeepPartial<typeof current>);
    } else {
      out[key as string] = value;
    }
  }
  return out as T;
}

function idsFor(patch: DeepPartial<DiagnosticsSnapshot>): string[] {
  return evaluateWarnings(merge(healthySnapshot(), patch)).map((w) => w.id);
}

describe("evaluateWarnings", () => {
  it("a healthy snapshot trips no warnings", () => {
    expect(evaluateWarnings(healthySnapshot())).toEqual([]);
  });

  it("LONG_GOP fires on a long max GOP once enough keyframes are known", () => {
    expect(idsFor({ gop: { maxGopS: 8, count: 30 } })).toContain("LONG_GOP");
  });

  it("LONG_GOP stays silent on too few discovered keyframes", () => {
    // A long gap over a 3-keyframe subset is not a representative sample, so
    // the rule waits rather than fabricating a critical from sparse anchors.
    expect(idsFor({ gop: { maxGopS: 8, count: 3 } })).not.toContain("LONG_GOP");
  });

  it("DECODE_LARGER_THAN_DISPLAY fires when decode area dwarfs the canvas", () => {
    expect(idsFor({ geometry: { decodeVsDisplayAreaRatio: 3 } })).toContain(
      "DECODE_LARGER_THAN_DISPLAY",
    );
  });

  it("DECODE_LARGER_THAN_DISPLAY stays silent on a 4K source decoded native onto a matched canvas", () => {
    expect(
      idsFor({
        geometry: {
          nativeWidth: 3840,
          nativeHeight: 2160,
          decodeWidth: 3840,
          decodeHeight: 2160,
          downscaleRatio: 1,
          decodeVsDisplayAreaRatio: 1,
          boundCanvasWidth: 3840,
          boundCanvasHeight: 2160,
        },
      }),
    ).not.toContain("DECODE_LARGER_THAN_DISPLAY");
  });

  it("CACHE_STARVED fires on a tiny exact tier", () => {
    expect(idsFor({ scheduler: { cache: { exactCapacity: 2 } } })).toContain(
      "CACHE_STARVED",
    );
  });

  it("CACHE_STARVED stays silent on the uncached cursor (null scheduler)", () => {
    expect(idsFor({ scheduler: null })).not.toContain("CACHE_STARVED");
  });

  it("PLAYBACK_BEHIND fires when the clock outruns the last painted frame", () => {
    expect(
      idsFor({ realtime: { catchUpMs: 400 }, status: "PLAYING" }),
    ).toContain("PLAYBACK_BEHIND");
  });

  it("PLAYBACK_BEHIND stays silent on a paused seek that landed short", () => {
    expect(
      idsFor({ realtime: { catchUpMs: 400 }, status: "PAUSED" }),
    ).not.toContain("PLAYBACK_BEHIND");
  });

  it("PLAYBACK_STARVING fires on repeated stalls while playing", () => {
    expect(idsFor({ realtime: { stalls: 5 }, status: "PLAYING" })).toContain(
      "PLAYBACK_STARVING",
    );
  });

  it("PLAYBACK_PUMP_DEAD fires when a playing session ticks on without ever painting", () => {
    // The failure the other playback rules are blind to: no paint means no
    // stall is ever booked, so stalls, late frames and catch-up all read zero.
    const ids = idsFor({
      status: "PLAYING",
      realtime: {
        ticks: 600,
        paints: 0,
        stalls: 0,
        lateFrames: 0,
        catchUpMs: 0,
      },
    });
    expect(ids).toContain("PLAYBACK_PUMP_DEAD");
    expect(ids).not.toContain("PLAYBACK_STARVING");
  });

  it("PLAYBACK_PUMP_DEAD stays silent over the opening ticks before the first frame lands", () => {
    expect(
      idsFor({ status: "PLAYING", realtime: { ticks: 30, paints: 0 } }),
    ).not.toContain("PLAYBACK_PUMP_DEAD");
  });

  it("PLAYBACK_PUMP_DEAD stays silent once the session has painted", () => {
    expect(
      idsFor({ status: "PLAYING", realtime: { ticks: 600, paints: 1 } }),
    ).not.toContain("PLAYBACK_PUMP_DEAD");
  });

  it("PLAYBACK_PUMP_DEAD stays silent while paused", () => {
    expect(
      idsFor({ status: "PAUSED", realtime: { ticks: 600, paints: 0 } }),
    ).not.toContain("PLAYBACK_PUMP_DEAD");
  });

  it("DECODER_DEAD fires when the scheduler could not rebuild its decoder", () => {
    expect(idsFor({ scheduler: { decoderDead: true } })).toContain(
      "DECODER_DEAD",
    );
  });

  it("PLAYBACK_FRAMES_DISCARDED fires when playback keeps throwing decoded frames away", () => {
    expect(
      idsFor({ status: "PLAYING", realtime: { droppedFrames: 60 } }),
    ).toContain("PLAYBACK_FRAMES_DISCARDED");
  });

  it("PLAYBACK_FRAMES_DISCARDED stays silent for the few drops a seek costs", () => {
    expect(
      idsFor({ status: "PLAYING", realtime: { droppedFrames: 3 } }),
    ).not.toContain("PLAYBACK_FRAMES_DISCARDED");
  });

  it("PLAYBACK_FRAMES_DISCARDED stays silent at a rate the present cadence skips frames for", () => {
    // 4x on a 30fps source asks for 120 frames a second through a 60Hz
    // cadence, so half of them are declined and land on this same ledger.
    expect(
      idsFor({ status: "PLAYING", rate: 4, realtime: { droppedFrames: 600 } }),
    ).not.toContain("PLAYBACK_FRAMES_DISCARDED");
  });

  it("PLAYBACK_FRAMES_DISCARDED still fires at a rate whose demand fits under the cadence", () => {
    expect(
      idsFor({ status: "PLAYING", rate: 2, realtime: { droppedFrames: 60 } }),
    ).toContain("PLAYBACK_FRAMES_DISCARDED");
  });

  it("SEEK_DRAIN_STUCK fires when a seek has been draining longer than any decode takes", () => {
    // The wedge itself: while a seek drains, every play pull is refused, so
    // the picture freezes with the transport still reading as playing.
    expect(
      idsFor({
        scheduler: { drain: { draining: true } },
        // Past half the ceiling the runtime gives one decode, so the
        // decode this drain is waiting on is one the runtime itself
        // would have given up on.
        counters: { seekDrainingForMs: 20_000 },
      }),
    ).toContain("SEEK_DRAIN_STUCK");
  });

  it("SEEK_DRAIN_STUCK stays silent for a seek that is merely slow", () => {
    // A long GOP of large frames legitimately runs seconds, which the hang
    // guard's own constant documents; crying wolf on those is how a panel
    // stops being read.
    expect(
      idsFor({
        scheduler: { drain: { draining: true } },
        counters: { seekDrainingForMs: 3000 },
      }),
    ).not.toContain("SEEK_DRAIN_STUCK");
  });

  it("SEEK_DRAIN_STUCK stays silent when no seek is draining", () => {
    expect(idsFor({ counters: { seekDrainingForMs: 20_000 } })).not.toContain(
      "SEEK_DRAIN_STUCK",
    );
  });

  it("PLAYBACK_PUMP_DEAD names the seek drain as the cause when one is in flight", () => {
    const warnings = evaluateWarnings(
      merge(healthySnapshot(), {
        status: "PLAYING",
        realtime: { ticks: 600, paints: 0 },
        scheduler: { drain: { draining: true } },
        counters: { seekDrainingForMs: 20_000 },
      }),
    );
    const pump = warnings.find((w) => w.id === "PLAYBACK_PUMP_DEAD");
    expect(pump?.advice).toContain("seek");
    expect(pump?.evidence).toContain("seekDraining=true");
  });

  it("SCRUB_DECODE_BOUND fires on a slow, cold cache", () => {
    expect(idsFor({ scrub: { cacheHitRatePct: 20, avgMs: 250 } })).toContain(
      "SCRUB_DECODE_BOUND",
    );
  });

  it("SCRUB_DECODE_BOUND stays silent when nothing has looked the cache up", () => {
    // A session that only played never looks the cache up, so the rate reads
    // 0%. Firing here would blame the cache for a metric with no denominator.
    expect(
      idsFor({
        scheduler: { cache: { exactHits: 0, previewHits: 0, misses: 0 } },
        scrub: { cacheHitRatePct: 0, avgMs: 250 },
      }),
    ).not.toContain("SCRUB_DECODE_BOUND");
  });

  it("a low hit rate reports its denominator alongside the rate", () => {
    const warning = evaluateWarnings(
      merge(healthySnapshot(), {
        scheduler: { cache: { exactHits: 5, previewHits: 0, misses: 15 } },
        scrub: { cacheHitRatePct: 25, avgMs: 250 },
      }),
    ).find((w) => w.id === "SCRUB_DECODE_BOUND");
    expect(warning?.evidence).toContain("hitRate=25% over 20 lookups");
  });

  it("SCRUB_P95_JANK fires when the tail is bad but the average is fine", () => {
    expect(idsFor({ scrub: { p95Ms: 400, avgMs: 100 } })).toContain(
      "SCRUB_P95_JANK",
    );
  });

  it("PLAYHEAD_STICKS fires on a large target-vs-landed gap", () => {
    expect(idsFor({ scrub: { targetVsLandedMs: 300 } })).toContain(
      "PLAYHEAD_STICKS",
    );
  });

  it("SCRUB_OUTRUNS_DECODER fires on deep seek coalescing", () => {
    expect(idsFor({ counters: { seekCoalesceDepth: 10 } })).toContain(
      "SCRUB_OUTRUNS_DECODER",
    );
  });

  it("SLOW_TIME_TO_CRISP fires when crisp decode lags the preview", () => {
    expect(idsFor({ scrub: { timeToCrispMs: 400 } })).toContain(
      "SLOW_TIME_TO_CRISP",
    );
  });

  it("CACHE_THRASH fires on evictions churning a cold cache", () => {
    expect(
      idsFor({
        scheduler: { cache: { exactEvictions: 100, exactCapacity: 5 } },
        scrub: { cacheHitRatePct: 40 },
      }),
    ).toContain("CACHE_THRASH");
  });

  it("ALL_INTRA fires on a tiny-GOP encode", () => {
    expect(
      idsFor({ gop: { minGopS: 0.03, avgGopS: 0.05, count: 100 } }),
    ).toContain("ALL_INTRA");
  });

  it("ALL_INTRA stays silent on two adjacent keyframes discovered so far", () => {
    expect(
      idsFor({ gop: { minGopS: 0.03, avgGopS: 0.05, count: 2 } }),
    ).not.toContain("ALL_INTRA");
  });

  it("NATIVE_FPS_UNKNOWN fires when the rate is unknown", () => {
    expect(idsFor({ nativeFps: null })).toContain("NATIVE_FPS_UNKNOWN");
  });

  it("no rule reads the field the worker never fills", () => {
    // webgpuAvailable is filled main-side, after the worker has already
    // evaluated. A rule keyed on it is a rule that never fires, so the
    // worker's empty value must change nothing.
    const asBroadcast = merge(healthySnapshot(), {
      renderer: "2d",
      webgpuAvailable: false,
    });
    const asFilledIn = merge(asBroadcast, { webgpuAvailable: true });
    expect(evaluateWarnings(asBroadcast)).toEqual(evaluateWarnings(asFilledIn));
  });

  it("warnings are ordered critical first", () => {
    const warnings = evaluateWarnings(
      merge(healthySnapshot(), {
        gop: { maxGopS: 8 },
        scrub: { targetVsLandedMs: 300 },
        nativeFps: null,
      }),
    );
    const ranks = warnings.map((w) => severityRank(w.severity));
    const sorted = [...ranks].sort((a, b) => b - a);
    expect(ranks).toEqual(sorted);
    expect(warnings[0].severity).toBe("critical");
  });
});

function severityRank(severity: WarningSeverity): number {
  return severity === "critical" ? 2 : severity === "warn" ? 1 : 0;
}

describe("PLAYBACK_RATE_NOT_SUSTAINED", () => {
  /** Behind by a second, which is far past any nativeFps-derived budget. */
  const BEHIND_MS = 1000;

  const playingAt = (
    rate: number,
    presentedRate: number | null,
    catchUpMs = BEHIND_MS,
  ): DeepPartial<DiagnosticsSnapshot> => ({
    status: "PLAYING",
    rate,
    presentedRate,
    realtime: { catchUpMs },
  });

  it("fires when the picture falls short of the commanded rate", () => {
    expect(idsFor(playingAt(4, 1.8))).toContain("PLAYBACK_RATE_NOT_SUSTAINED");
  });

  it("stays silent when the picture is keeping up", () => {
    expect(idsFor(playingAt(4, 3.9))).not.toContain(
      "PLAYBACK_RATE_NOT_SUSTAINED",
    );
  });

  it("stays silent at 1x, where the same shortfall is PLAYBACK_BEHIND", () => {
    expect(idsFor(playingAt(1, 0.3))).not.toContain(
      "PLAYBACK_RATE_NOT_SUSTAINED",
    );
  });

  it("fires on a slow rate the picture cannot hold either", () => {
    expect(idsFor(playingAt(0.5, 0.2))).toContain(
      "PLAYBACK_RATE_NOT_SUSTAINED",
    );
  });

  it("stays silent on a quantised low reading from a picture that is not behind", () => {
    // A slow rate paints sparsely enough that the meter's window holds one or
    // two whole frames, so the reading undershoots on a healthy pipeline.
    // Only the catch-up depth tells that case from a real shortfall.
    expect(idsFor(playingAt(0.25, 0.13, 2))).not.toContain(
      "PLAYBACK_RATE_NOT_SUSTAINED",
    );
  });

  it("stays silent while paused, where nothing is being presented", () => {
    expect(
      idsFor({ status: "PAUSED", rate: 4, presentedRate: 1 }),
    ).not.toContain("PLAYBACK_RATE_NOT_SUSTAINED");
  });

  it("stays silent before the meter has a reading, rather than guessing", () => {
    expect(idsFor(playingAt(4, null))).not.toContain(
      "PLAYBACK_RATE_NOT_SUSTAINED",
    );
  });

  it("names both rates in its evidence", () => {
    const warning = evaluateWarnings(
      merge(healthySnapshot(), playingAt(4, 1.8)),
    ).find((w) => w.id === "PLAYBACK_RATE_NOT_SUSTAINED");
    expect(warning?.evidence).toContain("rate=4x");
    expect(warning?.evidence).toContain("presented=1.80x");
  });
});
