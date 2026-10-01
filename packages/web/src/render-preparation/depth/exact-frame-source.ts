import type { DepthMap } from "supervision-js-core";
import type { DepthFrameRun, DepthFrameSource } from "./frame-window";

export interface ExactDepthFrame {
  readonly index: number;
  readonly map: DepthMap;
}

/**
 * Frames a run walks past without one to load before it stops and lets the
 * window start over at the next frame it wants. Above 1x a run skips the
 * frames presents do not land on; past the window's reach it would
 * otherwise walk to the end of the clip.
 */
const MAX_SKIPPED_FRAMES = 64;
/** Completions the load rate is measured over. */
const RATE_SAMPLE_COUNT = 24;

export interface ExactDepthFrameSource extends DepthFrameSource<ExactDepthFrame> {
  /**
   * Frames loaded per second while at least one was loading, over the last
   * few loads; null before there are enough. Fetch and decode both count.
   */
  loadRate(): number | null;
  /** Wall milliseconds the last few loads took each, on average; null before any. */
  meanLoadMs(): number | null;
}

/**
 * The exact PNGs as a frame source the depth window can play from. Any frame
 * can start a run; a run loads up to `concurrency()` frames at once, in
 * frame order, and hands them over in that order, so the window sees one
 * frame after another while the worker pool decodes several.
 */
export function createExactDepthFrameSource(options: {
  readonly frameCount: number;
  readonly load: (index: number, signal: AbortSignal) => Promise<DepthMap>;
  readonly concurrency: () => number;
  readonly now?: () => number;
}): ExactDepthFrameSource {
  const now = options.now ?? (() => performance.now());
  /** Busy milliseconds, summed over the times at least one load ran. */
  let busyMs = 0;
  let busySince = 0;
  let inFlight = 0;
  const completions: number[] = [];
  const durations: number[] = [];

  const busyNow = () => busyMs + (inFlight > 0 ? now() - busySince : 0);

  const timed = (index: number, signal: AbortSignal) => {
    const started = now();

    if (inFlight === 0) busySince = started;
    inFlight += 1;

    const settle = (loaded: boolean) => {
      const finished = now();

      if (loaded) {
        completions.push(busyNow());
        durations.push(finished - started);
        if (completions.length > RATE_SAMPLE_COUNT) completions.shift();
        if (durations.length > RATE_SAMPLE_COUNT) durations.shift();
      }
      inFlight -= 1;
      if (inFlight === 0) busyMs += finished - busySince;
    };

    return options.load(index, signal).then(
      (map) => {
        settle(!signal.aborted);
        return map;
      },
      (error: unknown) => {
        settle(false);
        throw error;
      },
    );
  };

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

          const map = timed(index, abort.signal);

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

    loadRate() {
      if (completions.length < 2) return null;

      const span = completions[completions.length - 1] - completions[0];

      return span > 0 ? ((completions.length - 1) * 1000) / span : null;
    },

    meanLoadMs() {
      if (durations.length === 0) return null;

      return durations.reduce((sum, ms) => sum + ms, 0) / durations.length;
    },
  };
}
