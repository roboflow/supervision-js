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
import {
  createPlayheadMotion,
  createPresentedFrameStride,
  MAX_PRESENTED_FRAME_STRIDE,
  WINDOW_LEAD_FRACTION,
} from "../playhead-motion";

/**
 * Of the lead a stop asks for, the share the window has to be able to hold.
 * A gate asking for more lead than the window covers would hold until it
 * gave up, so its ask is lowered to what fits.
 */
const REACHABLE_LEAD_SHARE = 0.9;
/**
 * Runs started for one frame that keeps not arriving. A run passes a frame it
 * was not asked to keep, so one restart for it is normal; a frame the decoder
 * never produces would otherwise restart the run forever.
 */
const MAX_RESTARTS_FOR_ONE_FRAME = 3;
/**
 * Presents a stride has to repeat over before frames off it are skipped:
 * more than one lap of a cadence that is not a whole number of frames.
 */
const STEADY_STRIDE_SAMPLE_COUNT = 8;

/** One pass over a frame source, from where it was started forward. */
export interface DepthFrameRun<Frame> {
  /** The next frame, or null once the source has ended or the run was cancelled. */
  next(): Promise<Frame | null>;
  cancel(): void;
}

/**
 * What the window decodes from: a depth preview track, the exact PNGs, or a
 * test double. A video track decodes from a key frame forward; a source with
 * `randomAccess` starts a run at any frame and skips the frames `keep`
 * turns away at no cost, so one run serves every frame ahead of it.
 */
export interface DepthFrameSource<
  Frame extends { readonly index: number } = DepthPreviewLumaFrame,
> {
  readonly frameCount: number;
  readonly randomAccess?: boolean;
  keyIndexAtOrBefore(index: number): number;
  decode(
    fromIndex: number,
    options: DepthPreviewDecodeOptions,
  ): DepthFrameRun<Frame> | DepthPreviewDecodeRun;
}

export interface DepthWindowEntry {
  readonly index: number;
  readonly map: DepthMap;
  readonly bytes: number;
}

export interface DepthFrameWindowOptions<
  Frame extends { readonly index: number } = DepthPreviewLumaFrame,
> {
  readonly frames: DepthFrameSource<Frame>;
  /** Start of frame `index` on the media timeline, in seconds. */
  readonly timeAt: (index: number) => number;
  /** End of frame `index` on the media timeline, in seconds. */
  readonly endAt: (index: number) => number;
  /** Wraps one frame's luma as the map the layer draws. */
  readonly createMap: (frame: Frame) => DepthMap;
  /** Bytes one decoded frame holds. */
  readonly frameBytes: number;
  /** Bytes a decoded frame holds, when frames differ; else `frameBytes`. */
  readonly bytesOf?: (frame: Frame) => number;
  /** Names the frames in diagnostics and warnings. Defaults to "preview". */
  readonly precision?: "exact" | "preview";
  /** Decoded luma kept, in bytes. */
  readonly maxBytes: number;
  /**
   * How far ahead of the playhead to decode while playing, in seconds of
   * media; a drag spends the same span both ways.
   */
  readonly prefetchSeconds: number;
  /** How much behind the playhead to keep, in seconds of media. */
  readonly retainSeconds: number;
  /**
   * Frames a resting playhead keeps decoded ahead, its own included, so a
   * step forward lands on a decoded frame.
   */
  readonly pausedFrameCount: number;
  /** Whether playback wraps from the last frame to the first. */
  readonly loop?: boolean;
  /** A frame landed. */
  readonly onFrame?: (index: number) => void;
  /** What the window holds or waits for changed. */
  readonly onChange?: () => void;
}

export interface DepthFrameWindow {
  /** The decoded preview for frame `index`, or null while it is not. */
  getEntry(index: number): DepthWindowEntry | null;
  /**
   * The playhead moved to `index`: decoding follows it, and where it lands
   * says whether it plays, is dragged, and which way it goes.
   */
  setPlayhead(index: number): void;
  /**
   * Whether playback runs or a drag moves the playhead. A resting playhead
   * keeps only a small margin decoded ahead of it.
   */
  setPlaybackActive(active: boolean): void;
  /**
   * Whether a drag holds the playhead. A slow drag forward moves it the way
   * playback does; this is what tells the two apart.
   */
  setScrubbing(scrubbing: boolean): void;
  /** Whether playback wraps at the last frame; look-ahead wraps with it. */
  setLoop(loop: boolean): void;
  /** A hidden page decodes nothing and starts no run until it is shown. */
  setHidden(hidden: boolean): void;
  /** Which way the playhead travels: 1, -1, or 0 without enough to say. */
  heading(): -1 | 0 | 1;
  /**
   * Seconds of decoded frames from the start of `index` onward that the
   * next presents land on, without a gap; Infinity once that run reaches
   * the last frame of a clip that does not loop.
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
  /**
   * Decoded entries for `count` frames in a row from `skip` frames after
   * `index`, nearest first, stopping at the first one not decoded.
   */
  upcoming(index: number, count: number, skip?: number): DepthWindowEntry[];
  getDiagnostics(): RenderPreparationArtifactDiagnostics;
  /**
   * The most lead the window decodes ahead of `index` while playing, in
   * seconds of media; Infinity where that reaches the end of a clip that
   * does not loop.
   */
  wantedLeadSeconds(index: number): number;
  /** The decoder failed; the window stops waiting and decoding. */
  readonly failure: unknown;
  destroy(): void;
}

interface ActiveRun<Frame> {
  readonly run: DepthFrameRun<Frame>;
  /** One past the highest frame this run has delivered. */
  next: number;
  ended: boolean;
}

interface Waiter {
  readonly index: number;
  readonly resumeAtSeconds: number;
  readonly check: () => void;
}

/** The frames the window wants decoded around the playhead. */
interface Span {
  /** Frames kept behind the playhead. */
  readonly behind: number;
  /** Offset of the farthest frame wanted ahead, the playhead's own being 0. */
  readonly aheadLast: number;
  /** Every how many frames ahead a present lands. */
  readonly stride: number;
  /** Whether frames behind the playhead are decoded, before those ahead. */
  readonly fillBehind: "no" | "first";
}

/**
 * Decoded 8-bit preview frames around the playhead, by frame index.
 *
 * One decode run is active at a time; it runs from the key frame before the
 * frame it was started for. What the window wants decoded follows how the
 * playhead moves, read with the mask window's cadence and heading readings:
 *
 * - Playing, it leads the playhead by `prefetchSeconds` times how many frames
 *   presents move, wrapping at the last frame when the clip loops. Once every
 *   recent present has moved the same number of frames, it copies out only
 *   the frames presents land on.
 * - Dragged, it spends `prefetchSeconds` both ways, most of it the way the
 *   playhead heads. Dragged backwards, a run from a key frame keeps every
 *   frame up to the playhead, so the frames the hand reaches next are there.
 * - Resting, it keeps a small margin ahead; stepping backwards fills behind.
 *
 * A frame the playback gate waits on is decoded before anything else. When
 * the budget is short, frames the window no longer wants go first, then the
 * ones farthest the other way from where the playhead heads.
 */
export function createDepthFrameWindow<
  Frame extends { readonly index: number } = DepthPreviewLumaFrame,
>(options: DepthFrameWindowOptions<Frame>): DepthFrameWindow {
  const { frames } = options;
  const what = options.precision === "exact" ? "exact depth" : "depth preview";
  const frameCount = frames.frameCount;
  const lastIndex = frameCount - 1;
  const entries = new Map<number, DepthWindowEntry>();
  const waiters = new Set<Waiter>();
  const motion = createPlayheadMotion();
  const stride = createPresentedFrameStride(STEADY_STRIDE_SAMPLE_COUNT);
  const capacityFrames = Math.max(
    1,
    Math.floor(options.maxBytes / Math.max(1, options.frameBytes)),
  );
  const pausedFrameCount = Math.max(1, Math.floor(options.pausedFrameCount));
  let heldBytes = 0;
  let playhead = 0;
  /** Nothing decodes before something says where the playhead is. */
  let placed = false;
  let playbackActive = false;
  let scrubbing = false;
  let looping = options.loop === true;
  let hidden = false;
  let active: ActiveRun<Frame> | null = null;
  let pumping = false;
  let wakePump: (() => void) | null = null;
  let progress = 0;
  let gateHoldCount = 0;
  let failure: unknown = null;
  let destroyed = false;
  /** The frame the last restart was for, and how often it was restarted for. */
  let restartedFor = -1;
  let restartsForSameFrame = 0;

  const wraps = () => looping && frameCount > 1;

  const clampIndex = (index: number) =>
    Math.min(lastIndex, Math.max(0, Math.round(index)));

  /** The frame `offset` after `from`, or null past the end of a clip that does not loop. */
  const after = (from: number, offset: number): number | null => {
    const index = from + offset;

    if (index <= lastIndex) return index;

    return wraps() ? index % frameCount : null;
  };

  /** Frames from `from` forward to `index`, wrapping when the clip loops; -1 behind. */
  const forwardOffset = (from: number, index: number) =>
    index >= from ? index - from : wraps() ? index - from + frameCount : -1;

  /** Seconds from the start of `from` to the start of the frame `offset` after it. */
  const secondsAhead = (from: number, offset: number) => {
    const index = from + offset;

    if (index <= lastIndex) {
      return options.timeAt(index) - options.timeAt(from);
    }

    const lap = options.endAt(lastIndex) - options.timeAt(0);

    return (
      Math.floor(index / frameCount) * lap +
      options.timeAt(index % frameCount) -
      options.timeAt(from)
    );
  };

  /** The offset of the last frame ahead of `from` starting under `seconds` away. */
  const offsetForSeconds = (from: number, seconds: number) => {
    const limit = wraps() ? frameCount - 1 : lastIndex - from;
    let offset = 0;

    while (offset < limit && secondsAhead(from, offset + 1) < seconds) {
      offset += 1;
    }

    return offset;
  };

  const framesBehindFor = (seconds: number) => {
    const target = options.timeAt(playhead) - seconds;
    let cursor = playhead;

    while (cursor > 0 && options.endAt(cursor - 1) > target) cursor -= 1;

    return playhead - cursor;
  };

  // The renderer says when a hand holds the playhead. Jumps alone cannot:
  // the playhead reported at 8x can move two presents at once.
  const playing = () => playbackActive && !scrubbing;
  const dragging = () => scrubbing;

  /**
   * What the window wants decoded. The budget goes first to the side the
   * playhead heads, so a full one never trades the next frames for the last.
   */
  const span = (): Span => {
    const heading = motion.heading();

    if (playing()) {
      // The lead stretches with how far presents move, as the mask
      // window's cooks spread over the frames presents land on; frames are
      // skipped only when every present moves the same stride, since an
      // uneven cadence lands on any of them.
      const step = stride.uniform();
      const aheadFrames = Math.min(
        capacityFrames,
        Math.floor(
          offsetForSeconds(
            playhead,
            options.prefetchSeconds * stride.average(),
          ) / step,
        ) + 1,
      );

      return {
        aheadLast: (aheadFrames - 1) * step,
        behind: Math.min(
          framesBehindFor(options.retainSeconds),
          capacityFrames - aheadFrames,
        ),
        fillBehind: "no",
        stride: step,
      };
    }

    if (dragging()) {
      const towards =
        options.prefetchSeconds * (heading === 0 ? 0.5 : WINDOW_LEAD_FRACTION);
      const away = options.prefetchSeconds - towards;
      const wantedBehind = framesBehindFor(
        Math.max(options.retainSeconds, heading < 0 ? towards : away),
      );
      const wantedAhead =
        offsetForSeconds(playhead, heading < 0 ? away : towards) + 1;

      if (heading < 0) {
        // A run reaching back starts at a key frame and decodes every frame
        // from there; keeping them all is what spares the next steps back a
        // run of their own.
        const fromKey =
          playhead - frames.keyIndexAtOrBefore(playhead - wantedBehind);
        const behind = Math.min(
          fromKey + wantedAhead <= capacityFrames ? fromKey : wantedBehind,
          capacityFrames - 1,
        );

        return {
          aheadLast: Math.min(wantedAhead, capacityFrames - behind) - 1,
          behind,
          fillBehind: "first",
          stride: 1,
        };
      }

      const aheadFrames = Math.min(wantedAhead, capacityFrames);

      return {
        aheadLast: aheadFrames - 1,
        behind: Math.min(wantedBehind, capacityFrames - aheadFrames),
        // Without a heading, frames behind would cost a run from an earlier
        // key frame for a hand that may never go there.
        fillBehind: "no",
        stride: 1,
      };
    }

    const aheadFrames = Math.min(
      capacityFrames,
      pausedFrameCount,
      offsetForSeconds(playhead, Number.POSITIVE_INFINITY) + 1,
    );

    return {
      aheadLast: aheadFrames - 1,
      behind: Math.min(
        framesBehindFor(options.retainSeconds),
        capacityFrames - aheadFrames,
      ),
      fillBehind: heading < 0 ? "first" : "no",
      stride: 1,
    };
  };

  /**
   * The frame the gate last let through. It is presented a moment after the
   * wait ends, by when the playhead may have moved on, as it does when seeks
   * follow each other quickly; dropping it then would present it bare.
   */
  let released: number | null = null;

  const waitedFor = (index: number) => {
    if (index === released) return true;
    for (const waiter of waiters) if (waiter.index === index) return true;

    return false;
  };

  const inSpan = (index: number, wanted: Span = span()) => {
    const offset = forwardOffset(playhead, index);

    if (offset >= 0 && offset <= wanted.aheadLast) {
      return offset % wanted.stride === 0;
    }

    return index < playhead && playhead - index <= wanted.behind;
  };

  /**
   * Whether a decoded frame is worth its bytes: one the window wants, or one
   * a present may land on ahead, up to what the budget holds. A run decodes
   * whatever comes next whether or not it is kept, so turning frames ahead
   * away would only send it on to the end of the clip looking for one.
   */
  const keepable = (index: number, wanted: Span = span()) => {
    if (inSpan(index, wanted)) return true;

    const offset = forwardOffset(playhead, index);

    return (
      offset > 0 &&
      offset < capacityFrames * wanted.stride &&
      offset % wanted.stride === 0
    );
  };

  const keep = (index: number) =>
    !destroyed && !entries.has(index) && (keepable(index) || waitedFor(index));

  /** The frame the next run is for, or null when nothing wanted is missing. */
  const nextTarget = (): number | null => {
    for (const waiter of [...waiters].reverse()) {
      if (!entries.has(waiter.index)) return waiter.index;
    }
    if (!entries.has(playhead)) return playhead;

    const wanted = span();
    const ahead = () => {
      for (
        let offset = wanted.stride;
        offset <= wanted.aheadLast;
        offset += wanted.stride
      ) {
        const index = after(playhead, offset);

        if (index === null) break;
        if (!entries.has(index)) return index;
      }

      return null;
    };
    const behind = () => {
      if (wanted.fillBehind === "no") return null;
      for (let offset = 1; offset <= wanted.behind; offset += 1) {
        if (!entries.has(playhead - offset)) return playhead - offset;
      }

      return null;
    };

    return behind() ?? ahead();
  };

  /** Restarts at `missing`, unless the runs keep passing it without producing it. */
  const restartFor = (missing: number) => {
    if (missing === restartedFor) {
      restartsForSameFrame += 1;
      if (restartsForSameFrame >= MAX_RESTARTS_FOR_ONE_FRAME) {
        fail(new Error(`The ${what} has no decodable frame ${missing}.`));
        return;
      }
    } else {
      restartedFor = missing;
      restartsForSameFrame = 0;
    }
    startRun(missing);
  };

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

  const makeRoom = (bytes: number) => {
    const wanted = span();

    for (const index of [...entries.keys()]) {
      if (!keepable(index, wanted) && !waitedFor(index)) drop(index);
    }

    if (heldBytes + bytes <= options.maxBytes) return true;

    const backwards = wanted.fillBehind === "first";
    const order = [...entries.keys()]
      .filter((index) => index !== playhead && !waitedFor(index))
      .map((index) => {
        // On a looping clip a frame behind is also a lap ahead; it is
        // whichever way is nearer.
        const offset = forwardOffset(playhead, index);
        const isBehind =
          index < playhead && (offset < 0 || playhead - index < offset);

        return {
          distance: isBehind ? playhead - index : offset,
          index,
          keptLonger: isBehind === backwards,
        };
      })
      .sort(
        (a, b) =>
          Number(a.keptLonger) - Number(b.keptLonger) ||
          b.distance - a.distance,
      );

    for (const { index } of order) {
      if (heldBytes + bytes <= options.maxBytes) break;
      drop(index);
    }

    return heldBytes + bytes <= options.maxBytes;
  };

  const startRun = (target: number) => {
    active?.run.cancel();
    active = null;
    if (failure !== null || destroyed) return;

    try {
      active = {
        ended: false,
        next: frames.randomAccess ? target : frames.keyIndexAtOrBefore(target),
        run: frames.decode(target, { keep }) as DepthFrameRun<Frame>,
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
      options.precision === "exact"
        ? `Exact depth stopped loading ahead, so playback draws the preview: ${String(error)}`
        : `The depth preview stopped decoding, so playback shows no depth: ${String(error)}`,
    );
    changed();
  };

  /**
   * Whether the active run is the quickest way to `target`. A run already
   * past it never comes back for it; one that has not reached that frame's
   * key frame yet would decode frames nobody needs to get there.
   */
  const runServes = (target: number) =>
    active !== null &&
    !active.ended &&
    active.next <= target &&
    (frames.randomAccess === true ||
      frames.keyIndexAtOrBefore(target) <= active.next);

  const wake = () => {
    const resolve = wakePump;

    wakePump = null;
    resolve?.();
  };

  /**
   * Moves decoding to what the window wants now: a run that will not reach
   * the next missing frame soon is replaced at once, not once its pending
   * read returns.
   */
  const follow = () => {
    if (destroyed || failure !== null || hidden || !placed) return;

    const target = nextTarget();

    if (target !== null && !runServes(target)) restartFor(target);
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
        const target = hidden || !placed ? null : nextTarget();

        if (target === null) {
          await idle();
          continue;
        }
        if (!runServes(target)) restartFor(target);

        const current = active;

        if (!current || !makeRoom(options.frameBytes)) {
          await idle();
          continue;
        }

        let frame: Frame | null;

        try {
          frame = await current.run.next();
        } catch (error) {
          if (current === active) fail(error);
          continue;
        }

        if (current !== active || destroyed) continue;
        if (!frame) {
          // The next pass starts over for whatever is still missing; one the
          // decoder never produces fails through the restart count.
          current.ended = true;
          active = null;
          continue;
        }

        current.next = Math.max(current.next, frame.index + 1);
        if (!keep(frame.index)) continue;
        makeRoom(options.frameBytes);

        const map = options.createMap(frame);
        const bytes =
          options.bytesOf?.(frame) ??
          (frame as { readonly luma?: Uint8Array }).luma?.byteLength ??
          options.frameBytes;

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

  const leadSeconds = (index: number) => {
    if (!entries.has(index)) return 0;

    const step = playing() ? stride.uniform() : 1;
    const limit = wraps() ? frameCount : lastIndex - index + 1;

    for (let offset = step; offset < limit; offset += step) {
      const next = after(index, offset);

      if (next === null) break;
      if (!entries.has(next)) return secondsAhead(index, offset);
    }

    return Number.POSITIVE_INFINITY;
  };

  /** The most lead the window wants ahead of `index`. */
  const reachableSeconds = (index: number) => {
    const wanted = span();
    const offset = wanted.aheadLast + wanted.stride;

    if (!wraps() && index + offset > lastIndex) {
      return Number.POSITIVE_INFINITY;
    }

    return secondsAhead(index, offset);
  };

  const requiredLead = (index: number, seconds: number) =>
    Math.min(
      Math.max(0, seconds),
      reachableSeconds(index) * REACHABLE_LEAD_SHARE,
    );

  const isReady = (index: number, seconds: number) =>
    failure !== null ||
    destroyed ||
    (entries.has(index) &&
      (seconds <= 0 || leadSeconds(index) >= requiredLead(index, seconds)));

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
      const moved = next - playhead;

      motion.observe(next, MAX_PRESENTED_FRAME_STRIDE);
      if (playing() && moved > 0) stride.observe(moved);
      if (next === playhead && active !== null) return;
      if (next !== playhead) {
        // A new place starts the count of restarts for one frame over.
        restartedFor = -1;
      }
      playhead = next;
      placed = true;
      follow();
    },

    setPlaybackActive(next) {
      if (destroyed || next === playbackActive) return;
      playbackActive = next;
      // Whichever way this goes, the gesture that moved the playhead is over,
      // and so is the cadence playback presented at.
      motion.endGesture();
      stride.reset();
      follow();
    },

    setScrubbing(next) {
      if (destroyed || next === scrubbing) return;
      scrubbing = next;
      motion.endGesture();
      stride.reset();
      follow();
    },

    setLoop(next) {
      if (next === looping) return;
      looping = next;
      follow();
    },

    setHidden(next) {
      if (destroyed || next === hidden) return;
      hidden = next;
      if (!hidden) {
        follow();
        return;
      }
      // A decoder working for a page nobody sees can be reclaimed by the
      // browser, and its deadlines would run out on a clock nobody watches.
      active?.run.cancel();
      active = null;
      wake();
    },

    heading: () => motion.heading(),

    leadSeconds,

    needsPlaybackGateWait(index, thresholds) {
      if (thresholds.enabled === false || failure !== null || destroyed) {
        return false;
      }

      const frame = clampIndex(index);

      if (!entries.has(frame)) return true;
      // Nothing plays while the playhead rests or is dragged, so the frame
      // itself is all a present needs.
      if (!playing()) return false;

      return (
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
      const resumeAtSeconds = playing()
        ? Math.max(0, thresholds.resumeAtSeconds)
        : 0;

      if (playing() || !placed || !inSpan(frame)) {
        // Playback is held at the frame it is about to present, which is
        // where decoding leads from.
        playhead = frame;
        placed = true;
      }
      if (isReady(frame, resumeAtSeconds)) {
        released = frame;
        return Promise.resolve();
      }

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
          if (entries.has(frame)) released = frame;
          signal?.removeEventListener("abort", finish);
          options.onChange?.();
          resolve();
        };

        waiters.add(waiter);
        signal?.addEventListener("abort", finish, { once: true });
        follow();
        options.onChange?.();
      });
    },

    getPreparationProgress: () => progress,

    wantedLeadSeconds: (index) => reachableSeconds(clampIndex(index)),

    upcoming(index, count, skip = 1) {
      const found: DepthWindowEntry[] = [];
      const limit = wraps() ? frameCount : lastIndex - index + 1;

      for (
        let offset = Math.max(1, Math.round(skip));
        offset < limit && found.length < count;
        offset += 1
      ) {
        const next = after(index, offset);
        const entry = next === null ? undefined : entries.get(next);

        if (!entry) break;
        found.push(entry);
      }

      return found;
    },

    getDiagnostics() {
      const lead = leadSeconds(playhead);
      const wanted = span();
      const aheadTarget = Math.floor(wanted.aheadLast / wanted.stride) + 1;
      let aheadFrames = 0;

      for (
        let offset = 0;
        offset <= wanted.aheadLast;
        offset += wanted.stride
      ) {
        const index = after(playhead, offset);

        if (index === null || !entries.has(index)) break;
        aheadFrames += 1;
      }

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
        inFlightCount: active && !active.ended ? 1 : 0,
        kind: RenderPreparationArtifactKind.DepthFrame,
        maxInFlightCount: 1,
        maxPreparedCount: capacityFrames,
        pendingCount: active && !active.ended && nextTarget() !== null ? 1 : 0,
        prefetchCount: aheadTarget,
        preparedAheadFrameCount: aheadFrames,
        preparedAheadSeconds: Number.isFinite(lead)
          ? lead
          : options.endAt(lastIndex) - options.timeAt(playhead),
        preparedCount: entries.size,
        window: {
          availableFrameCount: entries.size,
          refillThresholdFrameCount: 0,
          targetFrameCount: aheadTarget + wanted.behind,
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
