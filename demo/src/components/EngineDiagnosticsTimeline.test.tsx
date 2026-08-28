import { renderToStaticMarkup } from "react-dom/server";
import type {
  DiagnosticsSnapshot,
  PresentationMode,
} from "supervision-js-video-engine";
import { describe, expect, it } from "vitest";

import {
  chartUnchanged,
  EngineDiagnosticsTimeline,
} from "./EngineDiagnosticsTimeline";

function timelineMarkup(presentation: PresentationMode): string {
  return renderToStaticMarkup(
    <EngineDiagnosticsTimeline snapshot={snapshot(presentation)} />,
  );
}

function snapshot(presentation: PresentationMode): DiagnosticsSnapshot {
  return {
    presentation,
    renderer: presentation === "frames" ? null : "webgpu",
    track: {
      decodeWidth: 640,
      decodeHeight: 360,
      nativeFps: 30,
      durationS: 70,
    },
    scheduler: null,
    realtime: {
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
      nativeWidth: 1280,
      nativeHeight: 720,
      decodeWidth: 640,
      decodeHeight: 360,
      downscaleRatio: 0.5,
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
    sourceResidency: null,
    nativeFps: 30,
    rate: 1,
    presentedRate: null,
    playheadMs: 0,
    screen: null,
    status: "PAUSED",
    webgpuAvailable: true,
    warnings: [],
  };
}

describe("EngineDiagnosticsTimeline", () => {
  it("calls the engine's own marker what it is in each presentation", () => {
    // In frames presentation the engine paints nothing, so the marker is the
    // last frame it handed out; whether the host composited it is a question
    // this timeline cannot answer.
    expect(timelineMarkup("frames")).toContain("handed out (crisp)");
    expect(timelineMarkup("canvas")).toContain("on screen (crisp)");
  });
});

/** The scheduler stats the coverage lanes are drawn from, rebuilt with fresh
 *  array identities the way each broadcast delivers them. */
function scheduler(
  lanes: {
    exactTimestampsMs?: number[];
    keyframesMs?: number[];
    previewTimestampsMs?: number[];
    targetsMs?: number[];
  } = {},
): NonNullable<DiagnosticsSnapshot["scheduler"]> {
  return {
    mode: "playing",
    decodePath: "canvas",
    cache: {
      exactHits: 0,
      previewHits: 0,
      misses: 0,
      exactSize: 0,
      previewSize: 0,
      exactCapacity: 30,
      previewCapacity: 60,
      exactTimestampsMs: [...(lanes.exactTimestampsMs ?? [0, 1000, 2000])],
      previewTimestampsMs: [...(lanes.previewTimestampsMs ?? [500, 1500])],
      bucketMs: 33,
      exactEvictions: 0,
      previewEvictions: 0,
      bucketCollapses: 0,
      exactFrameWidth: 640,
      exactFrameHeight: 360,
      previewFrameWidth: 320,
      previewFrameHeight: 180,
      exactBudgetBytes: 0,
    },
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
    keyframesMs: [...(lanes.keyframesMs ?? [0, 2000, 4000, 6000])],
    prefetch: { targetsMs: [...(lanes.targetsMs ?? [8000, 10000])] },
    prefetchState: { inFlight: false, generation: 0 },
    exactToleranceMs: 50,
    previewToleranceMs: 250,
    decoderDead: false,
    decoderStalled: false,
    drain: { draining: false, pendingTargetMs: null, recovering: false },
  };
}

describe("chartUnchanged", () => {
  it("drops a broadcast that only moved the clock", () => {
    expect(
      chartUnchanged(
        { durationMs: 70_000, scheduler: scheduler() },
        { durationMs: 70_000, scheduler: scheduler() },
      ),
    ).toBe(true);
  });

  it("redraws when any lane it paints moves", () => {
    const before = { durationMs: 70_000, scheduler: scheduler() };

    expect(
      chartUnchanged(before, {
        durationMs: 70_000,
        scheduler: scheduler({ keyframesMs: [0, 2000, 4000, 6000, 8000] }),
      }),
    ).toBe(false);
    expect(
      chartUnchanged(before, {
        durationMs: 70_000,
        scheduler: scheduler({ exactTimestampsMs: [0, 1000, 2500] }),
      }),
    ).toBe(false);
    expect(
      chartUnchanged(before, {
        durationMs: 70_000,
        scheduler: scheduler({ previewTimestampsMs: [500, 1500, 2500] }),
      }),
    ).toBe(false);
    expect(
      chartUnchanged(before, {
        durationMs: 70_000,
        scheduler: scheduler({ targetsMs: [8000, 10_000, 12_000] }),
      }),
    ).toBe(false);
    expect(
      chartUnchanged(before, { durationMs: 60_000, scheduler: scheduler() }),
    ).toBe(false);
    expect(
      chartUnchanged(before, { durationMs: 70_000, scheduler: null }),
    ).toBe(false);
  });
});

describe("timeline markers", () => {
  it("keeps both moving markers out of the SVG", () => {
    const markup = renderToStaticMarkup(
      <EngineDiagnosticsTimeline
        snapshot={{
          ...snapshot("canvas"),
          scheduler: scheduler(),
          screen: {
            frameId: { index: 126, ticks: 4200 },
            mediaTimeMs: 4200,
            quality: "exact",
          },
        }}
      />,
    );
    const svg = markup.slice(markup.indexOf("<svg"), markup.indexOf("</svg>"));

    expect(svg).not.toContain("engine-timeline__screen");
    expect(svg).not.toContain("engine-timeline__playhead");
    expect(markup).toContain("engine-timeline__screen--exact");
  });
});
