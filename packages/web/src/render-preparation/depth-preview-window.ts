import type { DepthMap } from "supervision-js-core";
import type {
  DepthPreviewDecodeOptions,
  DepthPreviewDecodeRun,
  DepthPreviewLumaFrame,
} from "#media/depth-preview-track";
import {
  RenderPreparationArtifactFrameStatus,
  RenderPreparationArtifactKind,
  RenderPreparationGateHoldReason,
  type RenderPreparationArtifactDiagnostics,
  type RenderPreparationGateHoldDiagnostics,
  type ResolvedRenderPreparationGateThresholds,
} from "#types/render-preparation";

/**
 * Of the lead a stop asks for, the share the window has to be able to hold.
 * A gate asking for more lead than the byte budget can keep would hold until
 * it gave up, so its ask is lowered to what fits.
 */
const REACHABLE_LEAD_SHARE = 0.9;
/**
 * Runs started for one frame that keeps not arriving. A run passes a frame it
 * was not asked to keep, so one restart for it is normal; a frame the decoder
 * never produces would otherwise restart the run forever.
 */
const MAX_RESTARTS_FOR_ONE_FRAME = 3;

/** What the window decodes from: a depth preview track, or a test double. */
export interface DepthPreviewFrameSource {
  readonly frameCount: number;
  keyIndexAtOrBefore(index: number): number;
  decode(
    fromIndex: number,
    options: DepthPreviewDecodeOptions,
  ): DepthPreviewDecodeRun;
}

export interface DepthPreviewEntry {
  readonly index: number;
  readonly map: DepthMap;
  readonly bytes: number;
}

export interface DepthPreviewWindowOptions {
  readonly frames: DepthPreviewFrameSource;
  /** Start of frame `index` on the media timeline, in seconds. */
  readonly timeAt: (index: number) => number;
  /** End of frame `index` on the media timeline, in seconds. */
  readonly endAt: (index: number) => number;
  /** Wraps one frame's luma as the map the layer draws. */
  readonly createMap: (frame: DepthPreviewLumaFrame) => DepthMap;
  /** Bytes one decoded frame holds. */
  readonly frameBytes: number;
  /** Decoded luma kept, in bytes. */
  readonly maxBytes: number;
  /** How far ahead of the playhead to decode, in seconds of media. */
  readonly prefetchSeconds: number;
  /** How much behind the playhead to keep, in seconds of media. */
  readonly retainSeconds: number;
  /** A frame landed. */
  readonly onFrame?: (index: number) => void;
  /** What the window holds or waits for changed. */
  readonly onChange?: () => void;
}

export interface DepthPreviewWindow {
  /** The decoded preview for frame `index`, or null while it is not. */
  getEntry(index: number): DepthPreviewEntry | null;
  /** Points decoding at the frame on screen. */
  setPlayhead(index: number): void;
  /**
   * Seconds of decoded frames from the start of `index` onward without a
   * gap; Infinity once that run reaches the last frame.
   */
  leadSeconds(index: number): number;
  needsPlaybackGateWait(
    index: number,
    thresholds: ResolvedRenderPreparationGateThresholds,
  ): boolean;
  waitForReady(
    index: number,
    thresholds: ResolvedRenderPreparationGateThresholds,
    signal?: AbortSignal,
  ): Promise<void>;
  /** Frames decoded and kept, counted up across the window's life. */
  getPreparationProgress(): number;
  /** Decoded entries for the frames after `index`, nearest first. */
  upcoming(index: number, count: number): DepthPreviewEntry[];
  getDiagnostics(): RenderPreparationArtifactDiagnostics;
  /** The decoder failed; the window stops waiting and decoding. */
  readonly failure: unknown;
  destroy(): void;
}

interface ActiveRun {
  readonly run: DepthPreviewDecodeRun;
  readonly from: number;
  /** One past the highest frame this run has delivered. */
  next: number;
  ended: boolean;
}

interface Waiter {
  readonly index: number;
  readonly resumeAtSeconds: number;
  readonly check: () => void;
}

/**
 * Decoded 8-bit preview frames around the playhead, by frame index.
 *
 * One decode run is active at a time. It runs from the key frame before the
 * first frame the playhead is missing and stops once the window leads the
 * playhead by its target, or its byte budget is full of frames it still
 * needs. A playhead that lands where the run would take longer to reach than
 * a fresh start from that frame's key frame restarts it.
 *
 * Frames are kept from `retainSeconds` behind the playhead; older ones go
 * first when the budget is short, then the ones farthest ahead.
 */
export function createDepthPreviewWindow(
  options: DepthPreviewWindowOptions,
): DepthPreviewWindow {
  const { frames } = options;
  const lastIndex = frames.frameCount - 1;
  const entries = new Map<number, DepthPreviewEntry>();
  const waiters = new Set<Waiter>();
  const capacityFrames = Math.max(
    1,
    Math.floor(options.maxBytes / Math.max(1, options.frameBytes)),
  );
  let heldBytes = 0;
  let playhead = 0;
  let active: ActiveRun | null = null;
  let pumping = false;
  let wakePump: (() => void) | null = null;
  let progress = 0;
  let gateHoldCount = 0;
  let resumeAtSeconds = 0;
  let failure: unknown = null;
  let destroyed = false;
  /** The frame the last restart was for, and how often it was restarted for. */
  let restartedFor = -1;
  let restartsForSameFrame = 0;

  /** Restarts at `missing`, unless the runs keep passing it without producing it. */
  const restartFor = (missing: number) => {
    if (missing === restartedFor) {
      restartsForSameFrame += 1;
      if (restartsForSameFrame >= MAX_RESTARTS_FOR_ONE_FRAME) {
        fail(new Error(`The depth preview has no decodable frame ${missing}.`));
        return;
      }
    } else {
      restartedFor = missing;
      restartsForSameFrame = 0;
    }
    startRun(missing);
  };

  const clampIndex = (index: number) =>
    Math.min(lastIndex, Math.max(0, Math.round(index)));

  /** The first frame at or after `index` missing from the window. */
  const firstMissingFrom = (index: number) => {
    let cursor = index;

    while (cursor <= lastIndex && entries.has(cursor)) cursor += 1;

    return cursor;
  };

  /** The frame `seconds` after the start of `index`, at most the last one. */
  const indexAfter = (index: number, seconds: number) => {
    const target = options.timeAt(index) + seconds;
    let cursor = index;

    while (cursor < lastIndex && options.endAt(cursor) < target) cursor += 1;

    return cursor;
  };

  const retainFrom = () => {
    const target = options.timeAt(playhead) - options.retainSeconds;
    let cursor = playhead;

    while (cursor > 0 && options.endAt(cursor - 1) > target) cursor -= 1;

    return cursor;
  };

  /** Seconds the budget can hold ahead of `index`, after what it keeps behind. */
  const reachableSeconds = (index: number) => {
    const ahead = Math.max(1, capacityFrames - (index - retainFrom()));
    const last = Math.min(lastIndex, index + ahead - 1);

    return last >= lastIndex
      ? Number.POSITIVE_INFINITY
      : options.endAt(last) - options.timeAt(index);
  };

  /** The lead decoding aims for: the prefetch, or twice what the gate last asked. */
  const targetLeadSeconds = () =>
    Math.min(
      Math.max(options.prefetchSeconds, resumeAtSeconds * 2),
      reachableSeconds(playhead),
    );

  const leadSeconds = (index: number) => {
    if (!entries.has(index)) return 0;

    const missing = firstMissingFrom(index);

    return missing > lastIndex
      ? Number.POSITIVE_INFINITY
      : options.endAt(missing - 1) - options.timeAt(index);
  };

  const requiredLead = (index: number, seconds: number) =>
    Math.min(
      Math.max(0, seconds),
      reachableSeconds(index) * REACHABLE_LEAD_SHARE,
    );

  const isReady = (index: number, seconds: number) =>
    failure !== null ||
    destroyed ||
    (entries.has(index) && leadSeconds(index) >= requiredLead(index, seconds));

  const notifyWaiters = () => {
    for (const waiter of [...waiters]) waiter.check();
  };

  const changed = () => {
    notifyWaiters();
    options.onChange?.();
  };

  const drop = (index: number) => {
    const entry = entries.get(index);

    if (!entry) return;
    entries.delete(index);
    heldBytes -= entry.bytes;
  };

  /** Drops what is behind the retained span, then what lies past the target. */
  const makeRoom = (bytes: number) => {
    const keepFrom = retainFrom();

    for (const index of [...entries.keys()]) {
      if (index < keepFrom) drop(index);
    }

    if (heldBytes + bytes <= options.maxBytes) return true;

    const keepThrough = indexAfter(playhead, targetLeadSeconds());
    const farthest = [...entries.keys()]
      .filter((index) => index > keepThrough)
      .sort((a, b) => b - a);

    for (const index of farthest) {
      if (heldBytes + bytes <= options.maxBytes) break;
      drop(index);
    }

    return heldBytes + bytes <= options.maxBytes;
  };

  const keep = (index: number) =>
    !entries.has(index) && index >= retainFrom() && !destroyed;

  const startRun = (from: number) => {
    active?.run.cancel();
    active = null;
    if (failure !== null || destroyed) return;

    try {
      active = {
        ended: false,
        from,
        next: frames.keyIndexAtOrBefore(from),
        run: frames.decode(from, { keep }),
      };
    } catch (error) {
      fail(error);
    }
  };

  const fail = (error: unknown) => {
    failure ??= error;
    active?.run.cancel();
    active = null;
    console.warn(
      `The depth preview stopped decoding, so playback shows no depth: ${String(error)}`,
    );
    changed();
  };

  /**
   * Whether the active run is the quickest way to the first missing frame.
   * A run already past it never comes back for it; one that has not reached
   * that frame's key frame yet would decode frames nobody needs to get there.
   */
  const runServes = (missing: number) =>
    active !== null &&
    !active.ended &&
    active.from <= missing &&
    active.next <= missing + 1 &&
    frames.keyIndexAtOrBefore(missing) <= active.next;

  const wake = () => {
    const resolve = wakePump;

    wakePump = null;
    resolve?.();
  };

  /**
   * Moves decoding to the playhead at once: a run that will not reach the
   * first missing frame soon is replaced now, not once its pending read
   * returns.
   */
  const follow = () => {
    if (destroyed || failure !== null) return;

    const missing = firstMissingFrom(playhead);

    if (
      missing <= lastIndex &&
      missing <= indexAfter(playhead, targetLeadSeconds()) &&
      !runServes(missing)
    ) {
      restartFor(missing);
    }
    wake();
    void pump();
  };

  const idle = () =>
    new Promise<void>((resolve) => {
      wakePump = resolve;
    });

  const pump = async () => {
    if (pumping) return;
    pumping = true;

    try {
      while (!destroyed && failure === null) {
        const missing = firstMissingFrom(playhead);
        const wanted = indexAfter(playhead, targetLeadSeconds());

        if (missing > lastIndex || missing > wanted) {
          await idle();
          continue;
        }
        if (!runServes(missing)) restartFor(missing);

        const current = active;

        if (!current || !makeRoom(options.frameBytes)) {
          await idle();
          continue;
        }

        let frame: DepthPreviewLumaFrame | null;

        try {
          frame = await current.run.next();
        } catch (error) {
          if (current === active) fail(error);
          continue;
        }

        if (current !== active || destroyed) continue;
        if (!frame) {
          current.ended = true;

          const stillMissing = firstMissingFrom(playhead);

          if (stillMissing === current.from) {
            // A run that cannot produce the frame it started for never will.
            fail(
              new Error(
                `The depth preview has no decodable frame ${current.from}.`,
              ),
            );
          } else if (stillMissing <= lastIndex) {
            // A run that ended short of a frame still missing starts over.
            active = null;
          } else {
            await idle();
          }
          continue;
        }

        current.next = Math.max(current.next, frame.index + 1);
        if (!keep(frame.index)) continue;
        makeRoom(options.frameBytes);

        const map = options.createMap(frame);
        const bytes = frame.luma.byteLength;

        entries.set(frame.index, { bytes, index: frame.index, map });
        heldBytes += bytes;
        progress += 1;
        options.onFrame?.(frame.index);
        changed();
      }
    } finally {
      pumping = false;
    }
  };

  const currentHold = (): RenderPreparationGateHoldDiagnostics | null => {
    for (const waiter of waiters) {
      if (isReady(waiter.index, waiter.resumeAtSeconds)) continue;

      return {
        reason: entries.has(waiter.index)
          ? RenderPreparationGateHoldReason.LeadBelowRequirement
          : RenderPreparationGateHoldReason.ActiveFrameUnprepared,
        requiredAheadSeconds: requiredLead(
          waiter.index,
          waiter.resumeAtSeconds,
        ),
      };
    }

    return null;
  };

  return {
    get failure() {
      return failure;
    },

    getEntry(index) {
      return entries.get(index) ?? null;
    },

    setPlayhead(index) {
      if (destroyed) return;

      const next = clampIndex(index);

      if (next === playhead && active !== null) return;
      if (next !== playhead) {
        // A new place starts the count of restarts for one frame over.
        restartedFor = -1;
      }
      playhead = next;
      follow();
    },

    leadSeconds,

    needsPlaybackGateWait(index, thresholds) {
      if (thresholds.enabled === false || failure !== null || destroyed) {
        return false;
      }

      const frame = clampIndex(index);

      if (thresholds.resumeAtSeconds > resumeAtSeconds) {
        // A faster rate asks for more lead; decoding aims past it at once.
        resumeAtSeconds = thresholds.resumeAtSeconds;
        wake();
      }

      return (
        !entries.has(frame) ||
        leadSeconds(frame) <
          requiredLead(
            frame,
            Math.min(thresholds.stopBelowSeconds, thresholds.resumeAtSeconds),
          )
      );
    },

    waitForReady(index, thresholds, signal) {
      if (thresholds.enabled === false || signal?.aborted) {
        return Promise.resolve();
      }

      const frame = clampIndex(index);

      resumeAtSeconds = Math.max(0, thresholds.resumeAtSeconds);
      playhead = frame;
      follow();

      if (isReady(frame, resumeAtSeconds)) return Promise.resolve();

      gateHoldCount += 1;

      return new Promise<void>((resolve) => {
        const waiter: Waiter = {
          check: () => {
            if (!isReady(frame, waiter.resumeAtSeconds)) return;
            finish();
          },
          index: frame,
          resumeAtSeconds,
        };
        const finish = () => {
          waiters.delete(waiter);
          signal?.removeEventListener("abort", finish);
          options.onChange?.();
          resolve();
        };

        waiters.add(waiter);
        signal?.addEventListener("abort", finish, { once: true });
        options.onChange?.();
      });
    },

    getPreparationProgress: () => progress,

    upcoming(index, count) {
      const found: DepthPreviewEntry[] = [];

      for (
        let cursor = index + 1;
        cursor <= lastIndex && found.length < count;
        cursor += 1
      ) {
        const entry = entries.get(cursor);

        if (!entry) break;
        found.push(entry);
      }

      return found;
    },

    getDiagnostics() {
      const lead = leadSeconds(playhead);
      const missing = firstMissingFrom(playhead);
      const wanted = indexAfter(playhead, targetLeadSeconds());

      return {
        activeFrame: {
          key: `depth:${playhead}`,
          mediaTime: options.timeAt(playhead),
          status: entries.has(playhead)
            ? RenderPreparationArtifactFrameStatus.Prepared
            : RenderPreparationArtifactFrameStatus.Pending,
        },
        gateHold: currentHold(),
        gateHoldCount,
        kind: RenderPreparationArtifactKind.DepthFrame,
        maxPreparedCount: capacityFrames,
        pendingCount:
          active && !active.ended && missing <= Math.min(wanted, lastIndex)
            ? 1
            : 0,
        preparedAheadFrameCount: Math.max(0, missing - playhead),
        preparedAheadSeconds: Number.isFinite(lead)
          ? lead
          : options.endAt(lastIndex) - options.timeAt(playhead),
        preparedCount: entries.size,
        window: {
          availableFrameCount: entries.size,
          refillThresholdFrameCount: 0,
          targetFrameCount: Math.max(0, wanted - playhead + 1),
        },
      };
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      active?.run.cancel();
      active = null;
      entries.clear();
      heldBytes = 0;
      notifyWaiters();
      wake();
    },
  };
}
