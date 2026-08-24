import { renderToStaticMarkup } from "react-dom/server";
import type {
  DiagnosticsSnapshot,
  PresentationMode,
} from "supervision-js-video-engine";
import { describe, expect, it } from "vitest";

import { EngineDiagnosticsTimeline } from "./EngineDiagnosticsTimeline";

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
