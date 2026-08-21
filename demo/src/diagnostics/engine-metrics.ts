import type { DiagnosticsSnapshot } from "@roboflow/video-engine";

/**
 * The engine diagnostics panel's metric registry, mirrored for the demo.
 *
 * Labels, units, thresholds and wording are copied from the engine's own
 * diagnosticsModel so a reading in this demo and the same reading in the
 * FrameSampler storybook are the same string, and a human can hold the two
 * windows side by side and compare them by eye. Diverging any of them here
 * makes that comparison lie, so this file follows the engine rather than the
 * demo's own formatting conventions.
 */

export type MetricStatus = "bad" | "good" | "neutral" | "warn";

export interface MetricDescriptor {
  readonly label: string;
  readonly status?: (snapshot: DiagnosticsSnapshot) => MetricStatus;
  readonly tooltip: string;
  readonly value: (snapshot: DiagnosticsSnapshot) => string;
  /** Takes the whole row instead of half of it. A reading too wide for a half
   *  row squeezes its own label away, and a metric nobody can name is worse
   *  than a row that costs more height. */
  readonly wide?: boolean;
}

export interface MetricGroup {
  readonly metrics: readonly MetricDescriptor[];
  readonly title: string;
}

const NO_DATA = "n/a";
const BYTES_PER_MB = 1024 * 1024;

/** Minimum discovered keyframes before a GOP band is trustworthy. The index
 *  grows lazily, so a few non-adjacent anchors are not a representative sample. */
const GOP_MIN_SAMPLE = 8;

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return NO_DATA;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.round(ms)} ms`;
}

export function formatPct(pct: number | null | undefined): string {
  if (pct === null || pct === undefined || Number.isNaN(pct)) return NO_DATA;
  return `${Math.round(pct)}%`;
}

export function formatMb(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes))
    return NO_DATA;
  return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`;
}

export function formatRatio(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio))
    return NO_DATA;
  return `${ratio.toFixed(2)}x`;
}

export function formatInt(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value))
    return NO_DATA;
  return Math.round(value).toLocaleString();
}

export function formatFps(fps: number | null | undefined): string {
  if (fps === null || fps === undefined || Number.isNaN(fps)) return NO_DATA;
  return `${fps.toFixed(1)} fps`;
}

export function formatDims(
  width: number | null | undefined,
  height: number | null | undefined,
): string {
  if (
    width === null ||
    width === undefined ||
    height === null ||
    height === undefined
  )
    return NO_DATA;
  return `${width}x${height}`;
}

function formatSeconds(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds))
    return NO_DATA;
  return `${seconds.toFixed(2)} s`;
}

function formatBool(value: boolean): string {
  return value ? "yes" : "no";
}

/**
 * Cache lookups across every tier. Only an exact seek looks the cache up, so
 * playback and key seeks never move this and a play-only session sits at zero.
 * A readout that reads the hit rate without this denominator reports a cold
 * cache as a failing one.
 */
export function cacheLookups(snapshot: DiagnosticsSnapshot): number {
  const cache = snapshot.scheduler?.cache;
  if (!cache) return 0;
  return cache.exactHits + cache.previewHits + cache.misses;
}

const band = (good: boolean, warn: boolean): MetricStatus =>
  good ? "good" : warn ? "warn" : "bad";

export const engineMetricGroups: readonly MetricGroup[] = [
  {
    title: "Playback",
    metrics: [
      {
        label: "Effective FPS",
        tooltip:
          "Frames actually painted per second over the last ~half second, measured in the worker. Below the source rate means the pipeline can't keep up and playback drops frames.",
        value: (snapshot) => formatFps(snapshot.realtime.effectivePaintFps),
        status: (snapshot) => {
          const fps = snapshot.realtime.effectivePaintFps;
          const native = snapshot.nativeFps;
          if (fps === null || native === null) return "neutral";
          const ratio = fps / native;
          return band(ratio >= 0.9, ratio >= 0.6);
        },
      },
      {
        label: "Catch-up",
        tooltip:
          "How far the media clock has run past the last painted frame. Large values mean paints are lagging the clock and motion stutters.",
        value: (snapshot) => formatMs(snapshot.realtime.catchUpMs),
        status: (snapshot) =>
          band(
            snapshot.realtime.catchUpMs < 100,
            snapshot.realtime.catchUpMs < 300,
          ),
      },
      {
        label: "Late frames",
        tooltip:
          "Frames that painted after their scheduled display time. A growing count is the dropped-frame tell during playback.",
        value: (snapshot) => formatInt(snapshot.realtime.lateFrames),
        status: (snapshot) =>
          band(
            snapshot.realtime.lateFrames === 0,
            snapshot.realtime.lateFrames < 10,
          ),
      },
      {
        label: "Stalls",
        tooltip:
          "Times the canvas froze mid-play with no decoded output ready. Any stall means the decoder ran dry.",
        value: (snapshot) => formatInt(snapshot.realtime.stalls),
        status: (snapshot) =>
          snapshot.realtime.stalls === 0 ? "good" : "warn",
      },
      {
        label: "Play buffer",
        tooltip:
          "Frames decoded ahead of the clock, waiting in the play queue. Zero while playing means the decoder has run dry and a stall is imminent.",
        value: (snapshot) => formatInt(snapshot.realtime.playQueueDepth),
        status: (snapshot) =>
          snapshot.status === "PLAYING"
            ? snapshot.realtime.playQueueDepth > 0
              ? "good"
              : "warn"
            : "neutral",
      },
    ],
  },
  {
    title: "Scrub",
    metrics: [
      {
        label: "Avg scrub",
        tooltip:
          "Mean time from a cursor seek to its crisp frame painting. The wait between moving the playhead and seeing where it landed.",
        value: (snapshot) => formatMs(snapshot.scrub.avgMs),
        status: (snapshot) =>
          band(snapshot.scrub.avgMs < 120, snapshot.scrub.avgMs < 250),
      },
      {
        label: "P95 scrub",
        tooltip:
          "The slowest 5% of scrubs. High here while the average is fine points to irregular long-GOP regions.",
        value: (snapshot) => formatMs(snapshot.scrub.p95Ms),
        status: (snapshot) =>
          band(snapshot.scrub.p95Ms < 250, snapshot.scrub.p95Ms < 400),
      },
      {
        label: "Time to crisp",
        tooltip:
          "Last seek's gap between the blurry preview paint and the crisp decode that replaced it. Long means previews linger.",
        value: (snapshot) => formatMs(snapshot.scrub.timeToCrispMs),
        status: (snapshot) =>
          band(
            snapshot.scrub.timeToCrispMs < 200,
            snapshot.scrub.timeToCrispMs < 350,
          ),
      },
      {
        label: "Aim vs land",
        tooltip:
          "Last seek's gap between where you aimed and where the playhead settled. A long GOP forces a distant keyframe anchor, so it lands short.",
        value: (snapshot) => formatMs(snapshot.scrub.targetVsLandedMs),
        status: (snapshot) =>
          band(
            snapshot.scrub.targetVsLandedMs < 120,
            snapshot.scrub.targetVsLandedMs < 250,
          ),
      },
      {
        label: "Timed seeks",
        tooltip:
          "Cursor seeks that got timed, which is what Avg scrub averages. A scrub the next one overtook before it started, and a key-only seek, are never among them; a seek issued while playing is timed in its own group.",
        value: (snapshot) => formatInt(snapshot.scrub.samples),
      },
    ],
  },
  {
    title: "Seek while playing",
    metrics: [
      {
        label: "Seeks",
        tooltip:
          "Seeks issued while playing. The engine serves them by re-anchoring the playback walk, so they never touch the cursor and no Scrub reading counts them.",
        value: (snapshot) => formatInt(snapshot.playSeek.seeks),
      },
      {
        label: "Avg wait",
        tooltip:
          "Mean time from a seek issued while playing to its crisp frame painting, the same wait Avg scrub reports for the other kind of seek. Only seeks that reached that frame while still playing are timed: a superseded one, or one you paused under, is counted above but never averaged here. Reads n/a until something has been timed.",
        value: (snapshot) =>
          snapshot.playSeek.samples === 0
            ? NO_DATA
            : formatMs(snapshot.playSeek.avgMs),
        status: (snapshot) =>
          snapshot.playSeek.samples === 0
            ? "neutral"
            : band(
                snapshot.playSeek.avgMs < 120,
                snapshot.playSeek.avgMs < 250,
              ),
      },
      {
        label: "Slowest wait",
        tooltip:
          "The longest of those waits. A seek into a region the decoder has never visited is where it shows up.",
        value: (snapshot) =>
          snapshot.playSeek.samples === 0
            ? NO_DATA
            : formatMs(snapshot.playSeek.maxMs),
        status: (snapshot) =>
          snapshot.playSeek.samples === 0
            ? "neutral"
            : band(
                snapshot.playSeek.maxMs < 250,
                snapshot.playSeek.maxMs < 400,
              ),
      },
    ],
  },
  {
    title: "Cache",
    metrics: [
      {
        label: "Hit rate",
        tooltip:
          "Share of cache lookups answered without a fresh decode (one lookup per seek). Higher means more drags feel instant. Reads n/a until something looks the cache up, since a cold cache and a failing one both compute to 0%.",
        value: (snapshot) =>
          cacheLookups(snapshot) === 0
            ? NO_DATA
            : formatPct(snapshot.scrub.cacheHitRatePct),
        status: (snapshot) =>
          cacheLookups(snapshot) === 0
            ? "neutral"
            : band(
                snapshot.scrub.cacheHitRatePct >= 70,
                snapshot.scrub.cacheHitRatePct >= 40,
              ),
      },
      {
        label: "Lookups",
        tooltip:
          "Times a seek asked the cache for a frame, across both tiers. The hit rate's denominator: zero here means the cache has not been asked yet, not that it is missing everything.",
        value: (snapshot) => formatInt(cacheLookups(snapshot)),
      },
      {
        label: "Exact tier",
        tooltip:
          "Full-resolution frames resident over the tier's slot count. The slot count is RAM-budgeted, so large frames mean few slots.",
        value: (snapshot) =>
          snapshot.scheduler
            ? `${formatInt(snapshot.scheduler.cache.exactSize)} / ${formatInt(
                snapshot.scheduler.cache.exactCapacity,
              )}`
            : NO_DATA,
        status: (snapshot) =>
          snapshot.scheduler
            ? (snapshot.scheduler.cache.exactCapacity ?? 0) <= 3
              ? "bad"
              : "good"
            : "neutral",
      },
      {
        label: "Exact RAM",
        wide: true,
        tooltip:
          "Crisp-tier bytes resident against its RAM ceiling. Near full with a low hit rate is the starved-cache signature.",
        value: (snapshot) =>
          `${formatMb(snapshot.cacheBytes.exactBytes)} / ${formatMb(
            snapshot.cacheBytes.exactBudgetBytes,
          )} (${formatPct(snapshot.cacheBytes.exactBytesPct)})`,
        status: (snapshot) =>
          band(
            snapshot.cacheBytes.exactBytesPct <= 85,
            snapshot.cacheBytes.exactBytesPct <= 95,
          ),
      },
      {
        label: "Exact evictions",
        tooltip:
          "Crisp frames dropped under LRU pressure. Many evictions with a low hit rate means the budget is too small for the frame size.",
        value: (snapshot) =>
          formatInt(snapshot.scheduler?.cache.exactEvictions),
        status: (snapshot) => {
          const evictions = snapshot.scheduler?.cache.exactEvictions ?? 0;
          const capacity = snapshot.scheduler?.cache.exactCapacity ?? 0;
          if (evictions === 0) return "good";
          return capacity > 0 && evictions > capacity ? "warn" : "neutral";
        },
      },
    ],
  },
  {
    title: "Keyframe / GOP",
    metrics: [
      {
        label: "Keyframes found",
        tooltip:
          "Keyframes the runtime has discovered so far. The index grows lazily as the source is scrubbed and swept.",
        value: (snapshot) =>
          formatInt(
            snapshot.scheduler?.keyframesMs.length ?? snapshot.gop.count,
          ),
      },
      {
        label: "Avg GOP",
        tooltip:
          "Average seconds between keyframes, over the keyframes discovered so far. Longer GOPs make off-anchor scrubs decode more frames before they can paint.",
        value: (snapshot) => formatSeconds(snapshot.gop.avgGopS),
        status: (snapshot) =>
          snapshot.gop.count < GOP_MIN_SAMPLE
            ? "neutral"
            : band(snapshot.gop.avgGopS < 3, snapshot.gop.avgGopS < 6),
      },
      {
        label: "Max GOP",
        tooltip:
          "The longest gap between two discovered keyframes. The single region that makes worst-case scrubs janky.",
        value: (snapshot) => formatSeconds(snapshot.gop.maxGopS),
        status: (snapshot) =>
          snapshot.gop.count < GOP_MIN_SAMPLE
            ? "neutral"
            : band(snapshot.gop.maxGopS < 4, snapshot.gop.maxGopS < 6),
      },
      {
        label: "Est. walk depth",
        wide: true,
        tooltip:
          "Estimated frames a worst-case off-anchor scrub would decode, derived from avg GOP and frame rate; never measured in the decode loop.",
        value: (snapshot) =>
          `~${formatInt(snapshot.gop.estimatedGopWalkDepthFrames)} frames`,
        status: (snapshot) =>
          band(
            snapshot.gop.estimatedGopWalkDepthFrames < 30,
            snapshot.gop.estimatedGopWalkDepthFrames < 60,
          ),
      },
    ],
  },
  {
    title: "Decode",
    metrics: [
      {
        label: "Foreground decodes",
        tooltip:
          "Decodes driven by your gestures (seek, step, play) rather than background prefetch. Where interactive decode cost went.",
        value: (snapshot) => formatInt(snapshot.counters.foregroundDecodes),
      },
      {
        label: "Prefetched",
        wide: true,
        tooltip:
          "Frames the background sweep decoded ahead of you, exact tier plus preview tier. Higher means more drags land warm.",
        value: (snapshot) =>
          `${formatInt(snapshot.counters.prefetchExact)} exact · ${formatInt(
            snapshot.counters.prefetchPreview,
          )} preview`,
      },
      {
        label: "In flight",
        tooltip:
          "Whether a background prefetch sweep is decoding right now. A sweep that never settles is churning instead of warming the cache.",
        value: (snapshot) => formatBool(snapshot.counters.prefetchInFlight),
      },
      {
        label: "Next pending",
        tooltip:
          "Forward-playback pulls queued and not yet drained. A non-zero value while paused is unexpected.",
        value: (snapshot) => formatInt(snapshot.counters.nextPending),
      },
    ],
  },
  {
    title: "Geometry",
    metrics: [
      {
        label: "Native size",
        tooltip:
          "The source track's encoded resolution, before any decode-time downscaling.",
        value: (snapshot) =>
          formatDims(
            snapshot.geometry.nativeWidth,
            snapshot.geometry.nativeHeight,
          ),
      },
      {
        label: "Decode size",
        tooltip:
          "The resolution frames are actually decoded to. Smaller than native means a downscale strategy is in play.",
        value: (snapshot) =>
          formatDims(
            snapshot.geometry.decodeWidth,
            snapshot.geometry.decodeHeight,
          ),
      },
      {
        label: "Downscale",
        tooltip:
          "Decode width over native width. Below 1 means you decode smaller than the source to save bandwidth.",
        value: (snapshot) => formatRatio(snapshot.geometry.downscaleRatio),
      },
      {
        label: "Decode vs display",
        tooltip:
          "Decoded frame area over the painted canvas area. Above 1 means you decode more pixels than you show, which is wasted bandwidth. Reads n/a in frames presentation, where the engine holds no canvas of its own.",
        value: (snapshot) =>
          formatRatio(snapshot.geometry.decodeVsDisplayAreaRatio),
        status: (snapshot) => {
          const ratio = snapshot.geometry.decodeVsDisplayAreaRatio;
          if (ratio === null) return "neutral";
          return band(ratio <= 2, ratio <= 4);
        },
      },
    ],
  },
  {
    title: "Renderer",
    metrics: [
      {
        label: "Backend",
        tooltip:
          "Which renderer paints the engine's own canvas. Reads n/a in frames presentation, where the engine hands frames out and supervision paints them; the backend that paints this demo is the Playback group's Renderer readout.",
        value: (snapshot) => snapshot.renderer ?? NO_DATA,
        status: (snapshot) => {
          if (snapshot.renderer === "webgpu") return "good";
          if (snapshot.renderer === "2d")
            return snapshot.webgpuAvailable ? "warn" : "neutral";
          return "neutral";
        },
      },
      {
        label: "WebGPU available",
        tooltip:
          "Whether this browser exposes WebGPU at all, regardless of which backend is active.",
        value: (snapshot) => formatBool(snapshot.webgpuAvailable),
      },
    ],
  },
  {
    title: "Memory",
    metrics: [
      {
        label: "JS heap",
        tooltip:
          "Worker JS heap in use, read from performance.memory. Chromium-only; shown as n/a elsewhere.",
        value: (snapshot) =>
          snapshot.memory.jsHeapUsedBytes === null
            ? NO_DATA
            : formatMb(snapshot.memory.jsHeapUsedBytes),
      },
    ],
  },
];
