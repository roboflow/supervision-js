import type { DepthMap } from "supervision-js-core";
import type { DepthPlaybackSource } from "#types/render-preparation";
import { MAX_PRESENTED_FRAME_STRIDE } from "../playhead-motion";
import type { DepthClipTiming } from "./clip-timing";
import { exactMapBytes } from "./files";
import {
  createDepthFrameWindow,
  type DepthFrameRun,
  type DepthFrameSource,
  type DepthFrameWindow,
} from "./frame-window";
import type { DepthClipOptions } from "./options";

/** Of the lead exact playback loads ahead, the share it needs to take over. */
const EXACT_TAKEOVER_SHARE = 0.75;
/** And the share below which it hands back to the preview. */
const EXACT_HANDBACK_SHARE = 0.25;
/** The first wait before exact playback is tried again; each hand-back doubles it. */
const EXACT_RETRY_START_MS = 1000;
const EXACT_RETRY_MAX_MS = 16_000;
/** Exact playback this long without a hand-back earns the first wait back. */
const EXACT_STEADY_MS = 10_000;

/** Exact frames loaded ahead of playback, and whether they are what plays. */
export interface ExactPlayback {
  readonly window: DepthFrameWindow;
  /** Whether exact depth plays now. */
  readonly drawn: boolean;
  /**
   * Whether exact depth plays the frame at `index`. In "auto" this is where
   * it takes over once its lead reaches three quarters of what it loads
   * ahead, and hands back to the preview when that lead falls under a
   * quarter or the frame is missing, waiting longer each time before it
   * tries again; a stretch of steady exact playback earns the short wait
   * back.
   */
  playsAt(index: number): boolean;
  /** Playback starts, or resumes after a drag: "auto" opens on the preview. */
  restart(): void;
}

export function createExactPlayback(options: {
  readonly source: Exclude<DepthPlaybackSource, "preview">;
  readonly hasPreview: boolean;
  readonly timing: DepthClipTiming;
  readonly exactFrameBytes: number;
  readonly budgets: DepthClipOptions;
  readonly load: (index: number, signal: AbortSignal) => Promise<DepthMap>;
  readonly concurrency: () => number;
  readonly looping: () => boolean;
  /** A frame landed for `index`, while exact depth plays. */
  readonly onFrame: (index: number) => void;
  readonly onChange: () => void;
}): ExactPlayback {
  const { hasPreview, timing, budgets } = options;
  const source = options.source;
  const frames = createExactFrameSource({
    concurrency: options.concurrency,
    frameCount: timing.frameCount,
    load: options.load,
  });
  let drawn = source === "exact" || !hasPreview;
  /** Wall time before which "auto" does not try exact playback again. */
  let retryAt = 0;
  let backoffMs = EXACT_RETRY_START_MS;
  let since = 0;
  /** The frame playback last drew, to tell a seek from exact depth falling behind. */
  let lastPlayed: number | null = null;

  const frameWindow = createDepthFrameWindow<ExactDepthFrame>({
    bytesOf: ({ map }) => exactMapBytes(map),
    createMap: ({ map }) => map,
    endAt: timing.endAt,
    frameBytes: options.exactFrameBytes,
    frames,
    maxBytes: budgets.playback.maxExactCacheBytes,
    onChange: () => {
      // Exact frames that stop loading leave playback to the preview, for good.
      if (frameWindow.failure !== null && drawn && hasPreview) {
        drawn = false;
        retryAt = Number.POSITIVE_INFINITY;
      }
      options.onChange();
    },
    onFrame: (index) => {
      if (drawn) options.onFrame(index);
    },
    pausedFrameCount: budgets.preview.pausedFrameCount,
    precision: "exact",
    prefetchSeconds: budgets.preview.prefetchSeconds,
    retainSeconds: budgets.preview.retainSeconds,
    stillDrawn: () =>
      hasPreview
        ? "playback draws the preview"
        : "playback shows depth only at rest",
    timeAt: timing.timeAt,
  });

  const playsAt = (index: number): boolean => {
    if (frameWindow.failure !== null) return false;
    if (source !== "auto" || !hasPreview) return true;

    if (lastPlayed !== null && index !== lastPlayed) {
      const forward =
        index >= lastPlayed
          ? index - lastPlayed
          : options.looping()
            ? index + timing.frameCount - lastPlayed
            : Number.POSITIVE_INFINITY;

      // A seek lands where nothing was loaded ahead, which says nothing
      // about whether exact depth keeps up: it starts over on the preview.
      if (forward > 2 * MAX_PRESENTED_FRAME_STRIDE) drawn = false;
    }
    lastPlayed = index;

    const lead = frameWindow.leadSeconds(index);
    // Near the end of a clip that does not loop, the end is all there is to lead.
    const wanted = Math.min(
      frameWindow.wantedLeadSeconds(index),
      timing.endAt(timing.frameCount - 1) - timing.timeAt(index),
    );
    const now = performance.now();

    if (drawn) {
      if (
        frameWindow.getEntry(index) !== null &&
        lead >= wanted * EXACT_HANDBACK_SHARE
      ) {
        if (now - since > EXACT_STEADY_MS) backoffMs = EXACT_RETRY_START_MS;
        return true;
      }
      drawn = false;
      retryAt = now + backoffMs;
      backoffMs = Math.min(EXACT_RETRY_MAX_MS, backoffMs * 2);
      options.onChange();
      return false;
    }
    if (
      now >= retryAt &&
      frameWindow.getEntry(index) !== null &&
      lead >= wanted * EXACT_TAKEOVER_SHARE
    ) {
      drawn = true;
      since = now;
      options.onChange();
    }

    return drawn;
  };

  return {
    get drawn() {
      return drawn;
    },
    playsAt,
    restart() {
      lastPlayed = null;
      if (source === "auto" && hasPreview) drawn = false;
    },
    window: frameWindow,
  };
}

/**
 * Frames a run walks past without one to load before it stops and lets the
 * window start over at the next frame it wants. Above 1x a run skips the
 * frames presents do not land on; past the window's reach it would
 * otherwise walk to the end of the clip.
 */
const MAX_SKIPPED_FRAMES = 64;

interface ExactDepthFrame {
  readonly index: number;
  readonly map: DepthMap;
}

/**
 * The exact PNGs as a frame source the window can play from. Any frame can
 * start a run; a run loads up to `concurrency()` frames at once, in frame
 * order, and hands them over in that order, so the window sees one frame
 * after another while the worker pool decodes several.
 */
function createExactFrameSource(options: {
  readonly frameCount: number;
  readonly load: (index: number, signal: AbortSignal) => Promise<DepthMap>;
  readonly concurrency: () => number;
}): DepthFrameSource<ExactDepthFrame> {
  return {
    frameCount: options.frameCount,
    randomAccess: true,
    keyIndexAtOrBefore: (index) => index,

    decode(fromIndex, { keep } = {}): DepthFrameRun<ExactDepthFrame> {
      const abort = new AbortController();
      const queue: { index: number; map: Promise<DepthMap> }[] = [];
      let cursor = Math.max(0, fromIndex);
      let cancelled = false;

      const fill = () => {
        let skipped = 0;

        while (
          !cancelled &&
          queue.length < Math.max(1, options.concurrency()) &&
          cursor < options.frameCount &&
          skipped < MAX_SKIPPED_FRAMES
        ) {
          const index = cursor;

          cursor += 1;
          if (keep && !keep(index)) {
            skipped += 1;
            continue;
          }

          const map = options.load(index, abort.signal);

          // A run cancelled with loads in flight drops their answers.
          map.catch(() => undefined);
          queue.push({ index, map });
        }
      };

      return {
        async next() {
          fill();

          const head = queue.shift();

          if (!head || cancelled) return null;

          const map = await head.map;

          if (cancelled) return null;
          fill();

          return { index: head.index, map };
        },

        cancel() {
          cancelled = true;
          queue.length = 0;
          abort.abort();
        },
      };
    },
  };
}
