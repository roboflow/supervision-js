import type { DepthMap } from "supervision-js-core";
import type {
  DepthPlaybackSource,
  RenderPreparationArtifactDiagnostics,
} from "#types/render-preparation";
import { MAX_PRESENTED_FRAME_STRIDE } from "../playhead-motion";
import type { DepthClipTiming } from "./clip-timing";
import {
  createExactDepthFrameSource,
  type ExactDepthFrame,
} from "./exact-frame-source";
import { exactMapBytes } from "./files";
import { createDepthFrameWindow, type DepthFrameWindow } from "./frame-window";
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
  diagnostics(): RenderPreparationArtifactDiagnostics;
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
  const frames = createExactDepthFrameSource({
    concurrency: options.concurrency,
    frameCount: timing.frameCount,
    load: options.load,
  });
  let drawn = source === "exact" || !hasPreview;
  let fallbackCount = 0;
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
        fallbackCount += 1;
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
      fallbackCount += 1;
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
    diagnostics: () => ({
      ...frameWindow.getDiagnostics(),
      exactPlayback: {
        drawn,
        fallbackCount,
        loadRate: frames.loadRate(),
        meanLoadMs: frames.meanLoadMs(),
      },
      precision: "exact",
    }),
  };
}
