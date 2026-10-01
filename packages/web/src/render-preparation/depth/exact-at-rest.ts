import type { DepthMap } from "supervision-js-core";
import {
  RenderPreparationArtifactFrameStatus,
  RenderPreparationArtifactKind,
  type RenderPreparationArtifactDiagnostics,
} from "#types/render-preparation";
import { WINDOW_LEAD_FRACTION } from "../playhead-motion";
import { exactMapBytes } from "./files";
import type { DepthClipOptions } from "./options";

/** A clip's exact frames around the frame at rest. */
export interface ExactFramesAtRest {
  get(index: number): DepthMap | undefined;
  /**
   * The playhead rests on `center`: once it has for `settleSeconds`, that
   * frame loads, then its neighbours nearest first, most of them the way the
   * playhead last moved, so a step lands on a frame already loaded. A later
   * call or `cancel` starts none of the frames not yet asked for; a frame
   * already loading finishes and is kept.
   */
  settleOn(center: number): void;
  cancel(): void;
  /** Resolves once frame `index` is in, or `signal` aborts. */
  landing(index: number, signal?: AbortSignal): Promise<void>;
  diagnostics(): RenderPreparationArtifactDiagnostics;
  destroy(): void;
}

/**
 * Loads each frame once; a second ask shares the first. Frames are kept up
 * to `maxCacheBytes`, dropping the ones farthest from the frame on screen
 * first.
 */
export function createExactFramesAtRest(options: {
  readonly frameCount: number;
  readonly exactFrameBytes: number;
  readonly options: DepthClipOptions["exact"];
  readonly load: (index: number, signal: AbortSignal) => Promise<DepthMap>;
  /** A frame exact playback already holds, kept here instead of loaded again. */
  readonly loadedAhead: (index: number) => DepthMap | null;
  /** Loads run at once: one per decode worker. */
  readonly concurrency: () => number;
  readonly onScreen: () => number | null;
  /** Which way the playhead last moved. */
  readonly heading: () => -1 | 0 | 1;
  readonly timeAt: (index: number) => number;
  readonly onLanded: (index: number) => void;
  readonly onChange: () => void;
  /** What a frame that does not load leaves on screen, for its warning. */
  readonly stillDrawn: string;
}): ExactFramesAtRest {
  const { frameCount, exactFrameBytes } = options;
  const { maxCacheBytes, neighborFrameCount, settleSeconds } = options.options;
  const cache = new Map<number, { map: DepthMap; bytes: number }>();
  const loading = new Map<number, Promise<void>>();
  const landingWaiters = new Set<() => void>();
  const teardown = new AbortController();
  const capacityFrames = Math.max(
    1,
    Math.floor(maxCacheBytes / Math.max(1, exactFrameBytes)),
  );
  let cachedBytes = 0;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let run: AbortController | undefined;
  let warned = false;
  let destroyed = false;

  const distance = (index: number) => {
    const onScreen = options.onScreen();

    return onScreen === null ? 0 : Math.abs(index - onScreen);
  };

  const store = (index: number, map: DepthMap) => {
    const bytes = exactMapBytes(map);

    cache.set(index, { bytes, map });
    cachedBytes += bytes;

    while (cachedBytes > maxCacheBytes) {
      const onScreen = options.onScreen();
      let farthest: number | null = null;

      for (const candidate of cache.keys()) {
        if (
          candidate !== onScreen &&
          (farthest === null || distance(candidate) > distance(farthest))
        ) {
          farthest = candidate;
        }
      }
      if (farthest === null) break;
      cachedBytes -= cache.get(farthest)!.bytes;
      cache.delete(farthest);
    }
  };

  const load = (index: number): Promise<void> => {
    if (cache.has(index)) return Promise.resolve();

    const loadedAhead = options.loadedAhead(index);

    if (loadedAhead) {
      store(index, loadedAhead);
      return Promise.resolve();
    }

    let pending = loading.get(index);

    if (!pending) {
      pending = options
        .load(index, teardown.signal)
        .then((map) => {
          if (destroyed) return;
          store(index, map);
          for (const landed of [...landingWaiters]) landed();
          options.onLanded(index);
        })
        .catch((error: unknown) => {
          if (destroyed || warned) return;
          warned = true;
          console.warn(
            `Depth frame ${index} did not load, so ${options.stillDrawn}: ${String(error)}`,
          );
        })
        .finally(() => {
          loading.delete(index);
          options.onChange();
        });
      loading.set(index, pending);
      options.onChange();
    }

    return pending;
  };

  const cancel = () => {
    clearTimeout(settleTimer);
    settleTimer = undefined;
    run?.abort();
    run = undefined;
  };

  return {
    get: (index) => cache.get(index)?.map,

    settleOn(center) {
      cancel();
      if (destroyed) return;

      const next = new AbortController();

      run = next;
      settleTimer = setTimeout(() => {
        settleTimer = undefined;
        void loadInOrder(
          [
            center,
            ...neighbourOrder(
              center,
              neighborFrameCount,
              options.heading(),
            ).filter((index) => index >= 0 && index < frameCount),
          ],
          load,
          options.concurrency(),
          next.signal,
        );
      }, settleSeconds * 1000);
    },

    cancel,

    landing: (index, signal) =>
      new Promise<void>((resolve) => {
        const landed = () => {
          if (!cache.has(index) && !destroyed && !signal?.aborted) return;
          landingWaiters.delete(landed);
          signal?.removeEventListener("abort", landed);
          resolve();
        };

        landingWaiters.add(landed);
        signal?.addEventListener("abort", landed, { once: true });
      }),

    diagnostics() {
      const onScreen = options.onScreen();

      return {
        activeFrame:
          onScreen === null
            ? null
            : {
                key: `depth:${onScreen}`,
                mediaTime: options.timeAt(onScreen),
                status: cache.has(onScreen)
                  ? RenderPreparationArtifactFrameStatus.Prepared
                  : RenderPreparationArtifactFrameStatus.Pending,
              },
        inFlightCount: loading.size,
        kind: RenderPreparationArtifactKind.ExactDepthFrame,
        maxInFlightCount: options.concurrency(),
        maxPreparedCount: capacityFrames,
        pendingCount: loading.size,
        prefetchCount: 2 * neighborFrameCount + 1,
        preparedCount: cache.size,
      };
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancel();
      teardown.abort();
      for (const landed of [...landingWaiters]) landed();
      cache.clear();
      cachedBytes = 0;
    },
  };
}

/**
 * Runs `load` over `indices` with up to `concurrency` at once, starting them
 * in order, so the first ones land first. An abort starts no more.
 */
async function loadInOrder(
  indices: readonly number[],
  load: (index: number) => Promise<void>,
  concurrency: number,
  signal: AbortSignal,
): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < indices.length && !signal.aborted) {
      await load(indices[next++]);
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.max(1, Math.min(concurrency, indices.length)) },
      lane,
    ),
  );
}

/**
 * The neighbours of `center`, nearest first. With a heading, three in four
 * go the way the playhead moves, as a scrub window spends its frames;
 * without one, both sides alternate.
 */
function neighbourOrder(
  center: number,
  perSide: number,
  heading: -1 | 0 | 1,
): number[] {
  const total = 2 * perSide;
  const order: number[] = [];

  if (heading === 0) {
    for (let step = 1; step <= perSide; step += 1) {
      order.push(center + step, center - step);
    }

    return order;
  }

  const towards = Math.min(total, Math.ceil(total * WINDOW_LEAD_FRACTION));

  for (let step = 1; step <= Math.max(towards, total - towards); step += 1) {
    if (step <= towards) order.push(center + heading * step);
    if (step <= total - towards) order.push(center - heading * step);
  }

  return order;
}
