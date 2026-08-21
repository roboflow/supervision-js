import type { FrameQuality } from "./scrub-cursor";
import { DIAGNOSTICS } from "./constants";
import {
  cacheLookups,
  type DiagnosticsSnapshot,
  type Warning,
} from "./diagnostics";

/**
 * Worker-realm trace recorder. Two fixed-capacity ring buffers capture a rolling
 * window of what the runtime did: an EVENT ring (paints, scrubs, seeks, and
 * status transitions, the moments EngineCore drives directly) and a SNAPSHOT
 * ring (the same DiagnosticsSnapshot references already assembled for the
 * broadcast). Both overwrite oldest in place, so a long session has a constant,
 * predictable footprint and the appends are O(1) with no growth or GC churn.
 *
 * Stall and decode-spike depth are not separate events: stalls ride the snapshot
 * ring (realtime.stalls), and per-decode latency rides the scrub stats, so the
 * event ring stays to the moments the engine itself initiates.
 *
 * Allocated on arm, freed on disarm or export, so a disarmed recorder costs
 * zero memory. assemble() walks both rings ascending into one self-describing
 * versioned JSON document an agent or a human can read cold: the summary carries
 * the exact Warning diagnoses the UI shows, so the trace explains itself.
 *
 * Pure data. It never touches decode, the sink, or the cursor.
 */

export const TRACE_SCHEMA = "roboflow.videoEngine.trace/2";

/**
 * What an armed capture actually keeps. The snapshot ring is fed at the fixed
 * broadcast rate, so its capacity converts to a wall-clock window; the event
 * ring is fed by paints and gestures at no fixed rate, so its bound is a count
 * and nothing more. A readout that states one number for "the capture" is
 * describing neither ring.
 */
export const TRACE_RING_BOUNDS = {
  snapshotWindowMs:
    (DIAGNOSTICS.TRACE_SNAPSHOT_CAP / DIAGNOSTICS.BROADCAST_HZ) * 1000,
  snapshotCap: DIAGNOSTICS.TRACE_SNAPSHOT_CAP,
  eventCap: DIAGNOSTICS.TRACE_EVENT_CAP,
} as const;

/** One captured runtime event. type is the moment ("paint", "scrub", "seek",
 *  "status"); tMs is worker-clock relative to arm; the rest are optional payload
 *  fields the relevant moment fills. All plain data. */
export interface TraceEvent {
  readonly type: "paint" | "scrub" | "seek" | "status" | "rate";
  readonly tMs: number;
  readonly mediaTimeMs?: number;
  readonly paintSeq?: number;
  readonly catchUpMs?: number;
  /** paint: whether a full decode or the coarse stand-in reached the canvas.
   *  Paints come from sources with materially different pixel quality, so a
   *  trace without this cannot tell a crisp frame from a blurry one. */
  readonly quality?: FrameQuality;
  /** seek/scrub: the target the gesture aimed at, and where it landed.
   *  paint: the position the paint was serving (the engine clock at paint). */
  readonly targetMs?: number;
  readonly landedMs?: number;
  /** seek: whether it was a key-only navigation seek. */
  readonly keyOnly?: boolean;
  /** status: the new playback status string. */
  readonly status?: string;
  /** rate: the new playback rate. Every paint after it is served by a clock
   *  running at a different slope, which the timestamps alone do not show. */
  readonly rate?: number;
}

/** A broadcast snapshot with the moment it was taken, in the same worker-clock
 *  milliseconds since arm that every event carries, so the two series line up. */
export type TracedSnapshot = DiagnosticsSnapshot & { readonly tMs: number };

/** Environment facts captured once at export, so a trace read elsewhere carries
 *  the device context that shaped the numbers. */
export interface TraceEnvironment {
  readonly userAgent: string;
  readonly webgpuAvailable: boolean;
  readonly devicePixelRatio: number;
  readonly hardwareConcurrency: number;
}

/** Rolled-up totals for a glanceable read, with the same Warning diagnoses the
 *  UI shows so the trace is self-explaining. effectivePaintFps is measured across
 *  every snapshot pushed since arm, so it covers more than the snapshots the ring
 *  still holds; no snapshot carries such a reading. cacheHitRatePct is null until
 *  something looks the cache up, and cacheLookups is its denominator, so a reader
 *  can tell a cold cache from a failing one. */
export interface TraceSummary {
  readonly scrubP50Ms: number;
  readonly scrubP95Ms: number;
  readonly scrubMaxMs: number;
  readonly effectivePaintFps: number | null;
  readonly lateFrames: number;
  readonly stalls: number;
  readonly maxCatchUpMs: number;
  readonly cacheHitRatePct: number | null;
  readonly cacheLookups: number;
  readonly exactEvictions: number;
  readonly warnings: Warning[];
}

/**
 * How much of the capture one ring can still answer for. A capture older than a
 * ring's capacity keeps only its tail, so durationMs describes the session and
 * this describes the evidence: coveredMs runs from the oldest entry still held,
 * and dropped counts what was overwritten to make room.
 */
export interface TraceRingCoverage {
  readonly capacity: number;
  readonly retained: number;
  readonly dropped: number;
  readonly oldestTMs: number | null;
  readonly newestTMs: number | null;
  readonly coveredMs: number;
}

/** Per-ring coverage. The two rings fill at different rates, so they reach back
 *  different distances and neither one is "the captured window". */
export interface TraceCoverage {
  readonly events: TraceRingCoverage;
  readonly snapshots: TraceRingCoverage;
}

/** The assembled trace document. Versioned by schema so a reader knows the shape. */
export interface EngineTrace {
  readonly schema: typeof TRACE_SCHEMA;
  readonly capturedAt: number;
  readonly armOriginMs: number;
  readonly durationMs: number;
  readonly coverage: TraceCoverage;
  /** Why the capture stopped early, or null when a reader closed it. */
  readonly truncatedReason: string | null;
  readonly environment: TraceEnvironment;
  readonly events: TraceEvent[];
  readonly snapshots: TracedSnapshot[];
  readonly summary: TraceSummary;
}

/** A fixed-capacity ring that overwrites oldest. Pre-allocated on construction;
 *  writes are one assignment plus a wrapping index bump, never a grow. */
class Ring<T> {
  private readonly slots: Array<T | undefined>;
  private head = 0;
  private count = 0;
  private overwritten = 0;

  constructor(readonly capacity: number) {
    this.slots = new Array<T | undefined>(capacity);
  }

  /** Entries pushed out to make room. Non-zero means the ring no longer
   *  reaches back to arm. */
  get dropped(): number {
    return this.overwritten;
  }

  push(value: T): void {
    if (this.count === this.capacity) this.overwritten += 1;
    this.slots[this.head] = value;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count += 1;
  }

  /** Stored values oldest-first. */
  toArray(): T[] {
    const out: T[] = [];
    const start = this.count < this.capacity ? 0 : this.head;
    for (let i = 0; i < this.count; i++) {
      const value = this.slots[(start + i) % this.capacity];
      if (value !== undefined) out.push(value);
    }
    return out;
  }
}

export interface TraceRecorderEnvironment {
  readonly userAgent: string;
  readonly webgpuAvailable: boolean;
  readonly devicePixelRatio: number;
  readonly hardwareConcurrency: number;
}

/** Coverage for one ring from the entries it kept. A ring that never overwrote
 *  anything still reaches back to arm, whatever its oldest entry is stamped. */
function ringCoverage(
  ring: Ring<unknown>,
  entries: readonly { readonly tMs: number }[],
  durationMs: number,
): TraceRingCoverage {
  const oldestTMs = entries.length ? entries[0].tMs : null;
  const newestTMs = entries.length ? entries[entries.length - 1].tMs : null;
  const fromMs = ring.dropped > 0 && oldestTMs !== null ? oldestTMs : 0;
  return {
    capacity: ring.capacity,
    retained: entries.length,
    dropped: ring.dropped,
    oldestTMs,
    newestTMs,
    coveredMs: Math.max(0, durationMs - fromMs),
  };
}

export class TraceRecorder {
  private readonly events: Ring<TraceEvent>;
  private readonly snapshots: Ring<TracedSnapshot>;
  private readonly armOriginMs: number;
  private paintedFrames = 0;
  private playingMs = 0;
  private lastSnapshotAtMs: number | null = null;
  private lastPaints = 0;
  private lastSnapshotPlaying = false;
  private truncatedReason: string | null = null;

  constructor(
    private readonly env: TraceRecorderEnvironment,
    private readonly now: () => number = () => performance.now(),
    eventCap: number = DIAGNOSTICS.TRACE_EVENT_CAP,
    snapshotCap: number = DIAGNOSTICS.TRACE_SNAPSHOT_CAP,
  ) {
    this.events = new Ring<TraceEvent>(eventCap);
    this.snapshots = new Ring<TracedSnapshot>(snapshotCap);
    this.armOriginMs = this.now();
  }

  pushEvent(event: TraceEvent): void {
    this.events.push(event);
  }

  /**
   * Stamps the broadcast snapshot with when it was taken and rings it. The
   * stamp is the whole point of keeping a series: without it the snapshots are
   * an unordered pile with no way to line them up against the events, which
   * carry one, or to tell a freeze from a slow stretch.
   */
  pushSnapshot(snapshot: DiagnosticsSnapshot): void {
    this.accumulatePaintRate(snapshot);
    // The worker leaves webgpuAvailable empty for the main thread to fill on
    // the broadcast copy, and the ring holds the worker's own snapshot, so
    // an unstamped series reads false on every machine.
    this.snapshots.push({
      ...snapshot,
      webgpuAvailable: this.env.webgpuAvailable,
      tMs: this.elapsedMs(),
    });
  }

  /** Records that the capture was cut short by something other than a reader
   *  closing it, so an assembled trace says why it ends where it does. The
   *  first reason sticks: it is the one that ended the capture. */
  truncate(reason: string): void {
    this.truncatedReason ??= reason;
  }

  /**
   * Paints between two consecutive snapshots over the wall time between them.
   * An interval counts only when playback was up at both ends, since one
   * folded-in pause paints nothing and sinks the rate far below what the user
   * watched. The paint counter restarts with each play session, so a negative
   * delta means a new session began and that interval is dropped.
   */
  private accumulatePaintRate(snapshot: DiagnosticsSnapshot): void {
    const atMs = this.now();
    const delta = snapshot.realtime.paints - this.lastPaints;
    const spanWasPlaying =
      this.lastSnapshotPlaying && snapshot.status === "PLAYING";
    if (spanWasPlaying && this.lastSnapshotAtMs !== null && delta >= 0) {
      this.playingMs += atMs - this.lastSnapshotAtMs;
      this.paintedFrames += delta;
    }
    this.lastSnapshotAtMs = atMs;
    this.lastPaints = snapshot.realtime.paints;
    this.lastSnapshotPlaying = snapshot.status === "PLAYING";
  }

  /** Worker-clock milliseconds since arm; the stamp every pushed event uses. */
  elapsedMs(): number {
    return this.now() - this.armOriginMs;
  }

  assemble(): EngineTrace {
    const events = this.events.toArray();
    const snapshots = this.snapshots.toArray();
    const durationMs = this.now() - this.armOriginMs;
    return {
      schema: TRACE_SCHEMA,
      capturedAt: Date.now(),
      armOriginMs: this.armOriginMs,
      durationMs,
      coverage: {
        events: ringCoverage(this.events, events, durationMs),
        snapshots: ringCoverage(this.snapshots, snapshots, durationMs),
      },
      truncatedReason: this.truncatedReason,
      environment: {
        userAgent: this.env.userAgent,
        webgpuAvailable: this.env.webgpuAvailable,
        devicePixelRatio: this.env.devicePixelRatio,
        hardwareConcurrency: this.env.hardwareConcurrency,
      },
      events,
      snapshots,
      summary: this.summarize(snapshots),
    };
  }

  private summarize(snapshots: TracedSnapshot[]): TraceSummary {
    const last = snapshots.at(-1) ?? null;
    let maxCatchUpMs = 0;
    let lateFrames = 0;
    let stalls = 0;
    for (const snap of snapshots) {
      // Peaks, not the last reading. These are per-play-session counters
      // that reset on every play, so taking the last one reports whatever
      // the most recent session happened to be at and hides every stall
      // the capture was opened to catch.
      if (snap.realtime.catchUpMs > maxCatchUpMs)
        maxCatchUpMs = snap.realtime.catchUpMs;
      if (snap.realtime.lateFrames > lateFrames)
        lateFrames = snap.realtime.lateFrames;
      if (snap.realtime.stalls > stalls) stalls = snap.realtime.stalls;
    }
    const lookups = cacheLookups(last?.scheduler?.cache);
    return {
      scrubP50Ms: last?.scrub.p50Ms ?? 0,
      scrubP95Ms: last?.scrub.p95Ms ?? 0,
      scrubMaxMs: last?.scrub.maxMs ?? 0,
      effectivePaintFps:
        this.playingMs > 0
          ? (this.paintedFrames / this.playingMs) * 1000
          : null,
      lateFrames,
      stalls,
      maxCatchUpMs,
      cacheHitRatePct:
        lookups > 0 ? (last?.scrub.cacheHitRatePct ?? null) : null,
      cacheLookups: lookups,
      exactEvictions: last?.scheduler?.cache.exactEvictions ?? 0,
      warnings: last?.warnings ?? [],
    };
  }
}
