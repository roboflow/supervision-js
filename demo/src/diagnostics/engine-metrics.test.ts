import { describe, expect, it } from "vitest";

import type { DiagnosticsSnapshot } from "supervision-js-video-engine";

import { engineMetricGroups, type MetricDescriptor } from "./engine-metrics";

interface SeekLedger {
  readonly exactSeeks: number;
  readonly keySeeks: number;
  readonly playSeeks: number;
}

function snapshotWithSeeks(ledger: SeekLedger): DiagnosticsSnapshot {
  return {
    presentation: "canvas",
    renderer: "webgpu",
    track: {
      decodeWidth: 640,
      decodeHeight: 360,
      nativeFps: 30,
      durationS: 70,
    },
    scheduler: null,
    realtime: {
      effectivePaintFps: 30,
      catchUpMs: 0,
      lateFrames: 0,
      stalls: 0,
      ticks: 100,
      paints: 100,
      playQueueDepth: 3,
      droppedFrames: 0,
    },
    pipeline: { decodedFrames: 100, paintedFrames: 100, droppedFrames: 0 },
    cacheBytes: {
      exactBytes: 0,
      previewBytes: 0,
      exactBudgetBytes: 0,
      exactBytesPct: 0,
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
      count: 10,
      avgGopS: 2,
      maxGopS: 3,
      minGopS: 1,
      stddevS: 0.5,
      densityPerS: 0.5,
      distanceToNearestKeyframeS: 0.5,
      estimatedGopWalkDepthFrames: 60,
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
    playSeek: { seeks: ledger.playSeeks, samples: 0, avgMs: 0, maxMs: 0 },
    counters: {
      foregroundDecodes: 0,
      prefetchExact: 0,
      prefetchPreview: 0,
      keyframeAnchored: 0,
      exactSeeks: ledger.exactSeeks,
      keySeeks: ledger.keySeeks,
      seekCoalesceDepth: 0,
      probeRoundTrips: 0,
      prefetchInFlight: false,
      prefetchGeneration: 0,
      nextPending: 0,
      seekDrainingForMs: 0,
    },
    memory: { jsHeapUsedBytes: null },
    sourceResidency: null,
    nativeFps: 30,
    rate: 1,
    presentedRate: 1,
    playheadMs: 1000,
    screen: null,
    status: "PLAYING",
    webgpuAvailable: true,
    warnings: [],
  };
}

function metric(label: string): MetricDescriptor {
  const matches = engineMetricGroups
    .flatMap((group) => group.metrics)
    .filter((descriptor) => descriptor.label === label);
  if (matches.length !== 1) {
    throw new Error(`${matches.length} metrics are labelled "${label}"`);
  }
  return matches[0];
}

describe("engineMetricGroups", () => {
  it("reads the cursor seek counters off the snapshot", () => {
    const reading = metric("Cursor seeks").value(
      snapshotWithSeeks({ exactSeeks: 5, keySeeks: 2, playSeeks: 0 }),
    );
    expect(reading).toContain("5");
    expect(reading).toContain("2");
  });

  it("separates the two seek ledgers for a session that only seeks while playing", () => {
    const playing = snapshotWithSeeks({
      exactSeeks: 0,
      keySeeks: 0,
      playSeeks: 7,
    });
    expect(metric("Cursor seeks").value(playing)).toMatch(/\b0\b.*\b0\b/);
    expect(metric("Seeks").value(playing)).toBe("7");
  });

  it("names the mode when the engine paints no canvas of its own", () => {
    const frames: DiagnosticsSnapshot = {
      ...snapshotWithSeeks({ exactSeeks: 0, keySeeks: 0, playSeeks: 0 }),
      presentation: "frames",
      renderer: null,
    };
    const resolving: DiagnosticsSnapshot = {
      ...frames,
      presentation: "canvas",
    };

    // A renderer that is null forever by design reads differently from one that
    // is null for the moment it takes WebGPU to answer.
    expect(metric("Backend").value(frames)).toBe("host-painted");
    expect(metric("Backend").value(resolving)).toBe("resolving");
  });

  it("points at the panel that holds the backend painting the demo", () => {
    // The engine panel has a "Playback" group of its own with no Renderer in
    // it, so naming the group alone sends a reader nowhere.
    expect(metric("Backend").tooltip).toContain("Status panel");
    expect(
      engineMetricGroups
        .find((group) => group.title === "Playback")
        ?.metrics.map((descriptor) => descriptor.label),
    ).not.toContain("Renderer");
  });

  it("puts the cursor seek count in the group whose timings it explains", () => {
    const scrub = engineMetricGroups.find((group) => group.title === "Scrub");
    expect(scrub?.metrics.map((descriptor) => descriptor.label)).toContain(
      "Cursor seeks",
    );
  });
});
