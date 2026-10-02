import type {
  DepthClipFrames,
  DepthManifest,
  DepthMap,
} from "supervision-js-core";
import {
  RenderPreparationExecutionMode,
  RenderPreparationWorkerStatus,
} from "#types/render-preparation";
import { openClipPreview } from "./clip-preview";
import { createDepthClipTiming } from "./clip-timing";
import { createExactFramesAtRest } from "./exact-at-rest";
import { createExactPlayback } from "./exact-playback";
import { clipFrameFiles, loadDepthMap } from "./files";
import { createDepthFrameWindow } from "./frame-window";
import { resolveDepthClipOptions } from "./options";
import type {
  DepthFrameEntry,
  DepthFrameProvider,
  DepthSourceContext,
} from "./source";

const DIAGNOSTICS_INTERVAL_MS = 100;

/**
 * A clip's depth: exact 16-bit PNGs, one per frame, and an optional 8-bit
 * preview video.
 *
 * While playback runs, the preview or the exact frame for the video frame on
 * screen is drawn, loaded ahead of the playhead; a frame not loaded yet draws
 * no depth, never another frame's. Once playback has rested, the exact frame
 * on screen replaces it. A frame that lands for the frame on screen asks for
 * one redraw.
 */
export async function openDepthClip(
  manifest: DepthManifest,
  frames: DepthClipFrames,
  base: string | URL | undefined,
  context: DepthSourceContext,
): Promise<DepthFrameProvider> {
  const clock =
    context.frameClock ?? (await context.readFrameClock?.()) ?? null;

  if (!clock) {
    throw new RangeError(
      `depth.json describes a clip (frames), and the media has no frame index to pair them with: ${
        context.frameClockUnavailableReason ??
        "open the video by URL or Blob, or pass createWebVideoEngineMediaRendererSource() as the media."
      }`,
    );
  }

  const timing = createDepthClipTiming(clock, frames);
  const { indexAt, timeAt } = timing;
  const { preview, unavailable } = await openClipPreview(
    manifest,
    base,
    context,
    frames.count,
    timeAt,
  );
  const exactFrameBytes =
    manifest.width *
    manifest.height *
    (frames.confidence === undefined ? 2 : 3);
  const budgets = resolveDepthClipOptions(
    {
      exactFrameBytes,
      frameRate: timing.frameRate,
      previewFrameBytes: preview
        ? preview.reader.width * preview.reader.height
        : 0,
    },
    context.depth,
    { scheduleBatchSize: context.scheduleBatchSize },
  );
  const playbackSource = budgets.playback.source;
  const teardown = new AbortController();
  const listeners = new Set<() => void>();
  const entries = new WeakMap<DepthMap, DepthFrameEntry>();
  let onScreen: number | null = null;
  let active = false;
  let scrubbing = false;
  let hidden = false;
  let looping = false;
  let destroyed = false;
  let queuedPlayhead: number | null = null;
  let diagnosticsTimer: ReturnType<typeof setTimeout> | undefined;
  let previewStopped: string | null = null;
  /** Which way the frame on screen last moved, for a clip without a preview. */
  let lastStep: -1 | 0 | 1 = 0;
  /**
   * Set once the producer reports its playhead. From then on decoding
   * follows that playhead, which leads the frames a drag puts on screen;
   * the drawn frame trails them.
   */
  let prefetchDriven = false;

  const loadExact = (index: number, signal: AbortSignal) =>
    loadDepthMap(
      manifest,
      clipFrameFiles(frames, index),
      base,
      context,
      signal,
    );
  const concurrency = () => Math.max(1, context.preparer?.().concurrency ?? 1);
  const playing = () => active && !scrubbing;

  const entryOf = (
    index: number,
    map: DepthMap,
    precision: DepthFrameEntry["precision"],
  ) => {
    let entry = entries.get(map);

    if (!entry) {
      entry = { frameIndex: index, map, precision };
      entries.set(map, entry);
    }

    return entry;
  };

  function notify() {
    for (const listener of listeners) listener();
  }

  function reportDiagnostics() {
    diagnosticsTimer = undefined;
    if (destroyed) return;

    const offMainThread = preview?.copier?.offMainThread === true;

    context.onDiagnostics?.({
      artifacts: [
        ...(previewWindow
          ? [
              {
                ...previewWindow.getDiagnostics(),
                precision: "preview" as const,
              },
            ]
          : []),
        ...(exactWindow
          ? [{ ...exactWindow.getDiagnostics(), precision: "exact" as const }]
          : []),
        atRest.diagnostics(),
      ],
      // The decoder runs where the browser puts it; copying its codes out
      // runs in the worker or here.
      executionMode: offMainThread
        ? RenderPreparationExecutionMode.Worker
        : RenderPreparationExecutionMode.MainThread,
      message: previewStopped ?? unavailable ?? preview?.message ?? null,
      workerStatus: offMainThread
        ? RenderPreparationWorkerStatus.Ready
        : RenderPreparationWorkerStatus.Disabled,
    });
  }

  /** A busy window changes every frame; hosts hear about it a few times a second. */
  function scheduleDiagnostics() {
    if (diagnosticsTimer !== undefined || !context.onDiagnostics) return;
    diagnosticsTimer = setTimeout(reportDiagnostics, DIAGNOSTICS_INTERVAL_MS);
  }

  const previewWindow = preview
    ? createDepthFrameWindow({
        createMap: (frame) => ({
          camera: manifest.camera,
          displayRange: manifest.displayRange,
          height: frame.height,
          kind: manifest.kind,
          samples: {
            encoding: "preview8",
            levels: preview.track.levels,
            range: preview.track.range,
            reservedMax: preview.track.reservedMax,
            values: frame.luma,
          },
          view: manifest.view,
          width: frame.width,
        }),
        endAt: timing.endAt,
        frameBytes: preview.reader.width * preview.reader.height,
        frames: preview.reader,
        maxBytes: budgets.preview.maxCacheBytes,
        onChange: () => {
          if (
            previewWindow &&
            previewWindow.failure !== null &&
            previewStopped === null
          ) {
            previewStopped = `The depth preview stopped decoding, so playback draws exact depth where it keeps up (playback auto or exact) and depth at rest otherwise: ${String(previewWindow.failure)}`;
            preview.reader.dispose();
          }
          scheduleDiagnostics();
        },
        onFrame: (index) => {
          if (index === onScreen) notify();
        },
        pausedFrameCount: budgets.preview.pausedFrameCount,
        prefetchSeconds: budgets.preview.prefetchSeconds,
        retainSeconds: budgets.preview.retainSeconds,
        timeAt,
      })
    : null;

  const exactPlayback =
    playbackSource === "preview"
      ? null
      : createExactPlayback({
          budgets,
          concurrency,
          exactFrameBytes,
          hasPreview: previewWindow !== null,
          load: (index, signal) => {
            const kept = atRest.get(index);

            return kept
              ? Promise.resolve(kept)
              : loadExact(index, AbortSignal.any([teardown.signal, signal]));
          },
          looping: () => looping,
          onChange: scheduleDiagnostics,
          onFrame: (index) => {
            if (index === onScreen) notify();
          },
          source: playbackSource,
          timing,
        });
  const exactWindow = exactPlayback?.window ?? null;

  const atRest = createExactFramesAtRest({
    concurrency,
    exactFrameBytes,
    frameCount: frames.count,
    heading: () => previewWindow?.heading() ?? lastStep,
    load: loadExact,
    loadedAhead: (index) => exactWindow?.getEntry(index)?.map ?? null,
    onChange: scheduleDiagnostics,
    onLanded: (index) => {
      if (index === onScreen && !active) notify();
    },
    onScreen: () => onScreen,
    options: budgets.exact,
    stillDrawn: previewWindow
      ? "its preview stands in for it at rest"
      : "no depth is drawn over it",
    timeAt,
  });

  const playsExactAt = (index: number) =>
    exactPlayback?.playsAt(index) ?? false;

  const exactEntry = (index: number) => {
    const entry = exactWindow?.getEntry(index);

    return entry ? entryOf(index, entry.map, "exact") : null;
  };

  const previewEntry = (index: number) => {
    const entry = previewWindow?.getEntry(index);

    return entry ? entryOf(index, entry.map, "preview") : null;
  };

  const restEntry = (index: number) => {
    const map = atRest.get(index);

    return map ? entryOf(index, map, "exact") : null;
  };

  const moveWindows = (index: number) => {
    const exactMayPlay = exactWindow !== null && exactWindow.failure === null;

    if (exactMayPlay && playing()) exactWindow.setPlayhead(index);
    if (
      previewWindow &&
      !(playing() && exactMayPlay && playbackSource === "exact")
    ) {
      previewWindow.setPlayhead(index);
    }
  };

  const startPlaying = () => {
    exactPlayback?.restart();
    if (onScreen !== null) moveWindows(onScreen);
  };

  /** Called from inside a present; decoding moves after it, never inside it. */
  const followPlayhead = (index: number) => {
    if ((!previewWindow && !exactWindow) || prefetchDriven) return;
    if (queuedPlayhead === null) {
      queueMicrotask(() => {
        const next = queuedPlayhead;

        queuedPlayhead = null;
        if (next !== null && !destroyed && !prefetchDriven) moveWindows(next);
      });
    }
    queuedPlayhead = index;
  };

  const settle = () => {
    if (active || hidden || onScreen === null || destroyed) atRest.cancel();
    else atRest.settleOn(onScreen);
  };

  const onVisibility = () => {
    const next = document.visibilityState === "hidden";

    if (next === hidden || destroyed) return;
    hidden = next;
    previewWindow?.setHidden(hidden);
    exactWindow?.setHidden(hidden);
    settle();
  };

  scheduleDiagnostics();
  if (typeof document !== "undefined") {
    hidden = document.visibilityState === "hidden";
    previewWindow?.setHidden(hidden);
    exactWindow?.setHidden(hidden);
    document.addEventListener("visibilitychange", onVisibility);
  }

  return {
    getEntry(mediaTime) {
      if (destroyed) return null;

      const index = indexAt(mediaTime);

      if (index !== onScreen) {
        if (index !== null && onScreen !== null) {
          lastStep = index > onScreen ? 1 : -1;
        }
        onScreen = index;
        settle();
        if (index !== null) followPlayhead(index);
      }
      if (index === null) return null;
      if (playing()) {
        // One depth plays at a time: switching for single frames would
        // flicker, a preview step being coarser than a colour step.
        return playsExactAt(index)
          ? (exactEntry(index) ?? previewEntry(index))
          : previewEntry(index);
      }
      // A drag draws the preview; at rest the exact frame replaces it.
      const exact = active ? null : (restEntry(index) ?? exactEntry(index));

      return exact ?? previewEntry(index);
    },

    getFrameStatus(mediaTime) {
      const index = indexAt(mediaTime);

      if (index === null || destroyed) return null;

      return {
        frameIndex: index,
        prepared:
          (!active && atRest.get(index) !== undefined) ||
          (playing() &&
            exactPlayback?.drawn === true &&
            exactWindow?.getEntry(index) != null) ||
          previewWindow?.getEntry(index) != null,
      };
    },

    prefetch(mediaTime) {
      const index = indexAt(mediaTime);

      if (index === null || destroyed || (!previewWindow && !exactWindow)) {
        return;
      }
      prefetchDriven = true;
      moveWindows(index);
    },

    getUpcomingEntries(mediaTime, count, skip) {
      const index = indexAt(mediaTime);

      if (!active || index === null) return [];

      const exact = playing() && exactPlayback?.drawn === true;
      const from = exact ? exactWindow : previewWindow;

      return (from?.upcoming(index, count, skip) ?? []).map((entry) =>
        entryOf(entry.index, entry.map, exact ? "exact" : "preview"),
      );
    },

    needsPlaybackGateWait(mediaTime, thresholds) {
      const index = indexAt(mediaTime);

      if (index === null) return false;
      if (playing() && playsExactAt(index)) {
        return exactWindow!.needsPlaybackGateWait(index, thresholds);
      }
      if (previewWindow === null) return false;
      if (!active && atRest.get(index)) return false;

      return previewWindow.needsPlaybackGateWait(index, thresholds);
    },

    waitForReady(mediaTime, thresholds, signal) {
      const index = indexAt(mediaTime);

      if (index === null) return Promise.resolve();
      if (playing() && playsExactAt(index)) {
        return exactWindow!.waitForReady(index, thresholds, signal);
      }
      if (!previewWindow) return Promise.resolve();
      if (!active && atRest.get(index)) return Promise.resolve();

      const settled = new AbortController();
      const stop = () => settled.abort();

      signal?.addEventListener("abort", stop, { once: true });

      const waits = [
        previewWindow.waitForReady(index, thresholds, settled.signal),
      ];

      if (!active) waits.push(atRest.landing(index, settled.signal));

      return Promise.race(waits).finally(() => {
        signal?.removeEventListener("abort", stop);
        settled.abort();
      });
    },

    getPreparationProgress: () =>
      (previewWindow?.getPreparationProgress() ?? 0) +
      (exactWindow?.getPreparationProgress() ?? 0),

    setPlaybackActive(next) {
      if (next === active || destroyed) return;
      active = next;
      previewWindow?.setPlaybackActive(next);
      exactWindow?.setPlaybackActive(playing());
      if (playing()) startPlaying();
      settle();
      // The frame on screen swaps between its exact and its preview depth.
      notify();
    },

    setLoop(loop) {
      looping = loop;
      previewWindow?.setLoop(loop);
      exactWindow?.setLoop(loop);
    },

    setScrubbing(next) {
      const wasPlaying = playing();

      scrubbing = next;
      previewWindow?.setScrubbing(next);
      exactWindow?.setPlaybackActive(playing());
      if (playing() && !wasPlaying) startPlaying();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
      clearTimeout(diagnosticsTimer);
      atRest.destroy();
      teardown.abort();
      previewWindow?.destroy();
      exactWindow?.destroy();
      preview?.reader.dispose();
      listeners.clear();
    },
  };
}
