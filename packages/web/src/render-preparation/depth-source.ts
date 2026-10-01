import {
  parseDepthManifest,
  PLAYHEAD_QUANTIZATION_TOLERANCE_SECONDS,
  resolveDepthFrameFile,
  validateDepthMap,
  type DepthClipFrames,
  type DepthManifest,
  type DepthMap,
} from "supervision-js-core";
import type { DepthPreviewDecoding } from "#media/depth-preview-probe";
import type {
  DepthPreviewTrackOptions,
  DepthPreviewTrackReader,
} from "#media/depth-preview-track";
import { rememberPreparedDepthUpload } from "#renderers/depth-textures";
import type { MediaFrameClock } from "#types/media-frame-clock";
import type { MediaRendererDepthInput } from "#types/media-depth";
import {
  RenderPreparationExecutionMode,
  RenderPreparationWorkerStatus,
  type RenderPreparationDepthOptions,
  type RenderPreparationDiagnostics,
  type ResolvedRenderPreparationGateThresholds,
} from "#types/render-preparation";
import type { DepthFramePreparer } from "./depth-frame-preparer";
import type { DepthPreviewLumaCopier } from "./depth-preview-luma";
import { createDepthPreviewWindow } from "./depth-preview-window";

/** How far a map's aspect ratio may stray from the media's. */
const DEPTH_ASPECT_TOLERANCE = 0.01;
const MEBIBYTE = 1024 * 1024;
const DEFAULT_PREVIEW_PREFETCH_SECONDS = 1;
const DEFAULT_PREVIEW_RETAIN_SECONDS = 0.25;
/** The preview budget's floor: what a 1080p clip needs for a 1.35 s lead. */
const MIN_DEFAULT_PREVIEW_CACHE_BYTES = 96 * MEBIBYTE;
/** And its ceiling: 64 frames of 4K, about two seconds at 30 fps. */
const MAX_DEFAULT_PREVIEW_CACHE_BYTES = 512 * MEBIBYTE;

/** One depth map ready to draw, and which frame of depth it is. */
export interface DepthFrameEntry {
  readonly map: DepthMap;
  readonly frameIndex: number | null;
  readonly precision: "exact" | "preview";
}

/**
 * What the depth layer reads to find the map for a media time. It stays
 * internal until a second producer needs to supply depth itself.
 */
export interface DepthFrameProvider {
  /**
   * The depth to draw over the frame at `mediaTime`, or null to draw none.
   * The layer asks only for the frame it is drawing, so a clip takes each
   * call as naming the frame on screen.
   */
  getEntry(mediaTime: number): DepthFrameEntry | null;
  /**
   * Whether playback runs or a drag is still moving. A clip fetches exact
   * frames only once this has been false for a moment, and draws its preview
   * until then.
   */
  setPlaybackActive?(active: boolean): void;
  /** Calls `listener` whenever an answer of `getEntry` may have changed. */
  subscribe?(listener: () => void): () => void;
  /** The playhead moved: decoding ahead follows it. Never called in a present. */
  prefetch?(mediaTime: number): void;
  /**
   * The entries the next presents may draw, nearest first, so their
   * textures can go up before those presents: `count` frames in a row from
   * `skip` frames after the one at `mediaTime`. Above 1x a present skips
   * frames, and `skip` is how many it last moved.
   */
  getUpcomingEntries?(
    mediaTime: number,
    count: number,
    skip?: number,
  ): readonly DepthFrameEntry[];
  /** Whether the frame at `mediaTime` has to wait for depth before it shows. */
  needsPlaybackGateWait?(
    mediaTime: number,
    thresholds: ResolvedRenderPreparationGateThresholds,
  ): boolean;
  /** Resolves once depth leads `mediaTime` as far as the thresholds ask. */
  waitForReady?(
    mediaTime: number,
    thresholds: ResolvedRenderPreparationGateThresholds,
    signal?: AbortSignal,
  ): Promise<void>;
  /** Depth frames prepared ahead, counted up across the source's life. */
  getPreparationProgress?(): number;
  destroy(): void;
}

/** When and how much of a clip's exact depth is fetched and kept. */
export interface ExactDepthFrameOptions {
  /** Rest before the frame on screen is fetched, in seconds. */
  readonly settleSeconds: number;
  /** Frames fetched on each side of the frame on screen, for stepping. */
  readonly neighborFrameCount: number;
  /** Decoded frames kept, in bytes; the frame on screen is always kept. */
  readonly maxCacheBytes: number;
}

export const defaultExactDepthFrameOptions: ExactDepthFrameOptions = {
  maxCacheBytes: 128 * 1024 * 1024,
  neighborFrameCount: 2,
  settleSeconds: 0.15,
};

export interface DepthSourceContext {
  /** The media the map is stretched over. */
  readonly media: { readonly width: number; readonly height: number };
  /**
   * The media's frame index. A clip needs it to pair each depth frame with
   * the video frame it measures.
   */
  readonly frameClock?: MediaFrameClock | null;
  /** The decoder, created only when a manifest needs one. */
  readonly preparer?: () => DepthFramePreparer;
  readonly fetch?: typeof globalThis.fetch;
  /** Pad odd-width rows for WebGL while decoding, off the main thread. */
  readonly padRowsForWebGl?: boolean;
  readonly signal?: AbortSignal;
  /** The host's budgets and timing for clips. */
  readonly depth?: RenderPreparationDepthOptions;
  /** Overrides for the exact frames, over `depth`. */
  readonly exactFrames?: Partial<ExactDepthFrameOptions>;
  /**
   * Opens a clip's preview video; null leaves the preview out. Defaults to
   * the WebCodecs decoder, loaded on first use.
   */
  readonly openPreviewTrack?:
    | ((
        url: string,
        options?: DepthPreviewTrackOptions,
      ) => Promise<DepthPreviewTrackReader>)
    | null;
  /**
   * Copies decoded preview frames' luma out, made when a preview first opens:
   * the session's render-preparation worker keeps those copies off the page.
   * Without one, they run on the page.
   */
  readonly previewLumaCopier?: () => DepthPreviewLumaCopier;
  /**
   * Picks, once per page, the decoder that returns preview codes as written;
   * null skips the probe and leaves the choice to the browser.
   */
  readonly choosePreviewDecoding?: (() => Promise<DepthPreviewDecoding>) | null;
  /** Hears the preview window's state: its lead, frames held and gate holds. */
  readonly onDiagnostics?: (diagnostics: RenderPreparationDiagnostics) => void;
}

type ManifestInput = Extract<MediaRendererDepthInput, { manifest: unknown }>;

/** The files of one depth map: the 16-bit depth PNG and its confidence. */
interface DepthMapFiles {
  readonly file: string;
  readonly confidenceFile?: string;
}

/**
 * Checks a depth input against the media it will be drawn over and opens it.
 * A still map, given or loaded from an image manifest, answers every media
 * time with itself. A clip manifest answers with the exact frame for the
 * video frame on screen once playback rests.
 */
export async function openDepthSource(
  input: MediaRendererDepthInput,
  context: DepthSourceContext,
): Promise<DepthFrameProvider> {
  validateDepthInput(input);

  if (isMapInput(input)) {
    assertMediaAspect(input.map, context.media);
    return createStillDepthSource(input.map);
  }

  const { base, manifest } = await loadDepthManifest(input, context);

  assertMediaAspect(manifest, context.media);

  if (manifest.frames) {
    return await openDepthClip(manifest, manifest.frames, base, context);
  }
  if (!manifest.image) {
    throw new RangeError("depth.json needs an image or frames.");
  }

  return createStillDepthSource(
    await loadDepthMap(manifest, manifest.image, base, context, context.signal),
  );
}

/** Rejects an input whose shape no renderer could draw, before any media opens. */
export function validateDepthInput(input: MediaRendererDepthInput): void {
  if (typeof input !== "object" || input === null) {
    throw new RangeError("Depth input needs a map or a manifest.");
  }

  const hasMap = "map" in input && input.map !== undefined;
  const hasManifest = "manifest" in input && input.manifest !== undefined;

  if (hasMap === hasManifest) {
    throw new RangeError("Depth input needs either a map or a manifest.");
  }
  if (isMapInput(input)) {
    validateDepthMap(input.map);
    return;
  }

  const { manifest } = input;

  if (
    typeof manifest !== "string" &&
    !(manifest instanceof URL) &&
    (typeof manifest !== "object" || manifest === null)
  ) {
    throw new RangeError(
      "Depth manifest must be a URL or a parsed depth manifest.",
    );
  }
}

function isMapInput(
  input: MediaRendererDepthInput,
): input is Extract<MediaRendererDepthInput, { map: DepthMap }> {
  return "map" in input && input.map !== undefined;
}

function createStillDepthSource(map: DepthMap): DepthFrameProvider {
  const entry: DepthFrameEntry = { frameIndex: null, map, precision: "exact" };

  return {
    destroy: () => undefined,
    getEntry: () => entry,
  };
}

/**
 * Fetches and parses a manifest URL, or checks one passed parsed. Relative
 * files resolve against the manifest's URL, or against `baseUrl` for a
 * manifest passed already parsed.
 */
async function loadDepthManifest(
  input: ManifestInput,
  context: DepthSourceContext,
): Promise<{ manifest: DepthManifest; base: string | URL | undefined }> {
  if (typeof input.manifest !== "string" && !(input.manifest instanceof URL)) {
    return {
      base: input.baseUrl,
      manifest: checkParsedManifest(input.manifest),
    };
  }

  const fetchFile = context.fetch ?? globalThis.fetch.bind(globalThis);
  const url = resolveUrl(String(input.manifest), input.baseUrl);
  const response = await fetchFile(url, { signal: context.signal });

  if (!response.ok) {
    throw new Error(
      `Unable to load depth manifest ${url}: ${response.status} ${response.statusText}`.trim(),
    );
  }

  return { base: url, manifest: parseDepthManifest(await response.json()) };
}

/**
 * Fetches and decodes one depth PNG, and its confidence plane, into a map.
 * The decode runs in the render-preparation worker when there is one.
 */
async function loadDepthMap(
  manifest: DepthManifest,
  files: DepthMapFiles,
  base: string | URL | undefined,
  context: DepthSourceContext,
  signal: AbortSignal | undefined,
): Promise<DepthMap> {
  const fetchFile = context.fetch ?? globalThis.fetch.bind(globalThis);
  const preparer = context.preparer?.();

  if (!preparer) throw new Error("Depth decoding is unavailable.");

  const [depth, confidence] = await Promise.all([
    fetchBytes(fetchFile, resolveUrl(files.file, base), signal).then((bytes) =>
      preparer.decodeDepth(bytes, {
        padRowsForWebGl: context.padRowsForWebGl,
        signal,
      }),
    ),
    files.confidenceFile === undefined
      ? undefined
      : fetchBytes(
          fetchFile,
          resolveUrl(files.confidenceFile, base),
          signal,
        ).then((bytes) => preparer.decodeConfidence(bytes, { signal })),
  ]);

  assertImageSize(files.file, depth, manifest);
  if (confidence && files.confidenceFile !== undefined) {
    assertImageSize(files.confidenceFile, confidence, manifest);
  }

  const map: DepthMap = {
    camera: manifest.camera,
    confidence: confidence?.values,
    displayRange: manifest.displayRange,
    height: manifest.height,
    kind: manifest.kind,
    samples: {
      encoding: "scaled16",
      scale: manifest.storage.scale,
      values: depth.values,
    },
    view: manifest.view,
    width: manifest.width,
  };

  validateDepthMap(map);
  if (depth.paddedUpload) {
    rememberPreparedDepthUpload(map, {
      bytes: depth.paddedUpload.bytes,
      format: "rg8unorm",
      textureWidth: depth.paddedUpload.textureWidth,
    });
  }

  return map;
}

interface CachedDepthFrame {
  readonly entry: DepthFrameEntry;
  readonly bytes: number;
}

/** How often a clip reports its preview window, at most. */
const PREVIEW_DIAGNOSTICS_INTERVAL_MS = 100;

/**
 * A clip's depth: exact 16-bit PNGs, one per frame, and an optional 8-bit
 * preview video.
 *
 * While playback runs, the preview frame for the video frame on screen is
 * drawn, decoded ahead of the playhead; a frame not decoded yet draws no
 * depth, never another frame's. Once playback has rested for
 * `settleSeconds`, the exact frame on screen is fetched, then its neighbours
 * nearest first, so a step shows the next frame's depth at once; until it
 * lands the preview stands in for it. A frame that lands for the frame on
 * screen asks for one redraw. Decoded exact frames are kept up to
 * `maxCacheBytes`, dropping the ones farthest from the frame on screen first.
 */
async function openDepthClip(
  manifest: DepthManifest,
  frames: DepthClipFrames,
  base: string | URL | undefined,
  context: DepthSourceContext,
): Promise<DepthFrameProvider> {
  const clock = context.frameClock;

  if (!clock) {
    throw new RangeError(
      "depth.json describes a clip (frames), which needs a media source with a frame index: pass createWebVideoEngineMediaRendererSource() as the media.",
    );
  }
  if (!frames.timesS && frames.count !== clock.frameCount) {
    throw new RangeError(
      `depth.json has ${frames.count} frames and the media has ${clock.frameCount}; give frames.times_s when depth covers only some of the video's frames.`,
    );
  }

  const timesS = frames.timesS;
  const timeAt = (index: number) =>
    timesS ? clock.firstTimestamp + timesS[index] : clock.timeAt(index);
  const endAt = (index: number) =>
    timesS
      ? index + 1 < timesS.length
        ? timeAt(index + 1)
        : clock.endTimestamp
      : clock.timeAt(index) + clock.durationAt(index);
  const preview = await openClipPreview(manifest, frames, base, context, {
    endAt,
    timeAt,
  });
  const budgets = resolveDepthClipOptions(
    {
      exactFrameBytes:
        manifest.width *
        manifest.height *
        (frames.confidence === undefined ? 2 : 3),
      frameRate:
        frames.count / Math.max(1e-6, endAt(frames.count - 1) - timeAt(0)),
      previewFrameBytes: preview
        ? preview.reader.width * preview.reader.height
        : 0,
    },
    context.depth,
  );
  const options = { ...budgets.exact, ...context.exactFrames };
  const listeners = new Set<() => void>();
  const cache = new Map<number, CachedDepthFrame>();
  const loading = new Map<number, Promise<void>>();
  const previewEntries = new WeakMap<DepthMap, DepthFrameEntry>();
  const teardown = new AbortController();
  let cachedBytes = 0;
  let onScreen: number | null = null;
  let active = false;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let run: AbortController | undefined;
  let warned = false;
  let destroyed = false;
  let queuedPlayhead: number | null = null;
  let diagnosticsTimer: ReturnType<typeof setTimeout> | undefined;

  const indexAt = (mediaTime: number): number | null => {
    if (!Number.isFinite(mediaTime)) return null;
    if (!timesS) {
      return clock.indexAtOrBefore(
        mediaTime + PLAYHEAD_QUANTIZATION_TOLERANCE_SECONDS,
      );
    }

    return lastTimeAtOrBefore(
      timesS,
      mediaTime -
        clock.firstTimestamp +
        PLAYHEAD_QUANTIZATION_TOLERANCE_SECONDS,
    );
  };

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const reportDiagnostics = () => {
    diagnosticsTimer = undefined;
    if (destroyed || !previewWindow) return;
    context.onDiagnostics?.({
      artifacts: [previewWindow.getDiagnostics()],
      // The decoder runs where the browser puts it; the work this page
      // does per frame, copying its codes out, runs in the worker or here.
      executionMode: preview?.copier?.offMainThread
        ? RenderPreparationExecutionMode.Worker
        : RenderPreparationExecutionMode.MainThread,
      message: preview?.message() ?? null,
      workerStatus: preview?.copier?.offMainThread
        ? RenderPreparationWorkerStatus.Ready
        : RenderPreparationWorkerStatus.Disabled,
    });
  };

  /** A busy preview window changes every frame; hosts hear about it a few times a second. */
  const scheduleDiagnostics = () => {
    if (diagnosticsTimer !== undefined || !context.onDiagnostics) return;
    diagnosticsTimer = setTimeout(
      reportDiagnostics,
      PREVIEW_DIAGNOSTICS_INTERVAL_MS,
    );
  };

  const previewWindow = preview
    ? createDepthPreviewWindow({
        createMap: (frame) => ({
          camera: manifest.camera,
          displayRange: manifest.displayRange,
          height: frame.height,
          kind: manifest.kind,
          samples: {
            encoding: "preview8",
            range: preview.track.range,
            reservedMax: preview.track.reservedMax,
            values: frame.luma,
          },
          view: manifest.view,
          width: frame.width,
        }),
        endAt,
        frameBytes: preview.reader.width * preview.reader.height,
        frames: preview.reader,
        maxBytes: budgets.preview.maxCacheBytes,
        onChange: scheduleDiagnostics,
        onFrame: (index) => {
          // Only a landing for the frame on screen changes the picture.
          if (index === onScreen) notify();
        },
        prefetchSeconds: budgets.preview.prefetchSeconds,
        retainSeconds: budgets.preview.retainSeconds,
        timeAt,
      })
    : null;

  /**
   * The present asks for the frame on screen; decoding moves there right
   * after it, never inside it.
   */
  const followPlayhead = (index: number) => {
    if (!previewWindow) return;
    if (queuedPlayhead === null) {
      queueMicrotask(() => {
        const next = queuedPlayhead;

        queuedPlayhead = null;
        if (next !== null && !destroyed) previewWindow.setPlayhead(next);
      });
    }
    queuedPlayhead = index;
  };

  const previewEntry = (index: number): DepthFrameEntry | null => {
    const entry = previewWindow?.getEntry(index);

    if (!entry) return null;

    let wrapped = previewEntries.get(entry.map);

    if (!wrapped) {
      wrapped = { frameIndex: index, map: entry.map, precision: "preview" };
      previewEntries.set(entry.map, wrapped);
    }

    return wrapped;
  };

  const distance = (index: number) =>
    onScreen === null ? 0 : Math.abs(index - onScreen);

  const store = (index: number, map: DepthMap) => {
    const bytes =
      map.samples.values.byteLength + (map.confidence?.byteLength ?? 0);

    cache.set(index, {
      bytes,
      entry: { frameIndex: index, map, precision: "exact" },
    });
    cachedBytes += bytes;

    while (cachedBytes > options.maxCacheBytes) {
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

  /** Fetches and decodes one frame once; a second ask shares the first. */
  const load = (index: number): Promise<void> => {
    if (cache.has(index)) return Promise.resolve();

    let pending = loading.get(index);

    if (!pending) {
      pending = loadDepthMap(
        manifest,
        {
          confidenceFile:
            frames.confidence === undefined
              ? undefined
              : resolveDepthFrameFile(frames.confidence, index),
          file: resolveDepthFrameFile(frames.exact, index),
        },
        base,
        context,
        teardown.signal,
      )
        .then((map) => {
          if (destroyed) return;
          store(index, map);
          if (index === onScreen && !active) notify();
        })
        .catch((error: unknown) => {
          if (destroyed || isAbortError(error) || warned) return;
          warned = true;
          console.warn(
            `Depth frame ${index} did not load, so ${previewWindow ? "its preview stands in for it at rest" : "no depth is drawn over it"}: ${String(error)}`,
          );
        })
        .finally(() => loading.delete(index));
      loading.set(index, pending);
    }

    return pending;
  };

  /**
   * The frame on screen first, then its neighbours nearest first. A move
   * stops the frames not yet asked for; one already loading finishes and is
   * kept.
   */
  const loadAround = async (center: number, signal: AbortSignal) => {
    await load(center);

    for (let step = 1; step <= options.neighborFrameCount; step += 1) {
      for (const index of [center + step, center - step]) {
        if (signal.aborted) return;
        if (index >= 0 && index < frames.count) await load(index);
      }
    }
  };

  const settle = () => {
    clearTimeout(settleTimer);
    settleTimer = undefined;
    run?.abort();
    run = undefined;
    if (active || onScreen === null || destroyed) return;

    const center = onScreen;
    const next = new AbortController();

    run = next;
    settleTimer = setTimeout(() => {
      settleTimer = undefined;
      void loadAround(center, next.signal);
    }, options.settleSeconds * 1000);
  };

  return {
    getEntry(mediaTime) {
      if (destroyed) return null;

      const index = indexAt(mediaTime);

      if (index !== onScreen) {
        onScreen = index;
        settle();
        if (index !== null) followPlayhead(index);
      }
      if (index === null) return null;

      // Exact depth is drawn only at rest. Mixing it into playback would
      // flicker: a preview step is coarser than a colour step.
      const exact = active ? null : (cache.get(index)?.entry ?? null);

      return exact ?? previewEntry(index);
    },

    prefetch(mediaTime) {
      const index = indexAt(mediaTime);

      if (index !== null && !destroyed) previewWindow?.setPlayhead(index);
    },

    getUpcomingEntries(mediaTime, count, skip) {
      const index = indexAt(mediaTime);

      if (!previewWindow || !active || index === null) return [];

      return previewWindow
        .upcoming(index, count, skip)
        .map((entry) => previewEntry(entry.index)!)
        .filter(Boolean);
    },

    needsPlaybackGateWait(mediaTime, thresholds) {
      const index = indexAt(mediaTime);

      return (
        previewWindow !== null &&
        index !== null &&
        previewWindow.needsPlaybackGateWait(index, thresholds)
      );
    },

    waitForReady(mediaTime, thresholds, signal) {
      const index = indexAt(mediaTime);

      return previewWindow && index !== null
        ? previewWindow.waitForReady(index, thresholds, signal)
        : Promise.resolve();
    },

    getPreparationProgress: () => previewWindow?.getPreparationProgress() ?? 0,

    setPlaybackActive(next) {
      if (next === active || destroyed) return;
      active = next;
      settle();
      // The frame on screen swaps between its exact and its preview depth.
      notify();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(settleTimer);
      clearTimeout(diagnosticsTimer);
      run?.abort();
      teardown.abort();
      previewWindow?.destroy();
      preview?.reader.dispose();
      listeners.clear();
      cache.clear();
      cachedBytes = 0;
    },
  };
}

interface OpenedClipPreview {
  readonly reader: DepthPreviewTrackReader;
  /** What copies decoded frames' codes out, when not the page itself. */
  readonly copier: DepthPreviewLumaCopier | undefined;
  readonly track: NonNullable<DepthManifest["preview"]>;
  /** What diagnostics say about the preview, such as altered codes. */
  message(): string | null;
}

/**
 * Opens the clip's preview video and checks it against the media it is
 * drawn over: one preview frame per depth frame, each at its video frame's
 * time. A preview that disagrees is refused with a `RangeError`; one this
 * browser cannot open leaves the clip with exact depth at rest only.
 */
async function openClipPreview(
  manifest: DepthManifest,
  frames: DepthClipFrames,
  base: string | URL | undefined,
  context: DepthSourceContext,
  timing: {
    readonly timeAt: (index: number) => number;
    readonly endAt: (index: number) => number;
  },
): Promise<OpenedClipPreview | null> {
  const track = manifest.preview;
  const open =
    context.openPreviewTrack === undefined
      ? openDefaultPreviewTrack
      : context.openPreviewTrack;

  if (!track || !open) return null;

  const url = resolveUrl(track.file, base);
  const choose =
    context.choosePreviewDecoding === undefined
      ? chooseDefaultPreviewDecoding
      : context.choosePreviewDecoding;
  // The probe decodes before the preview opens, so the page never holds two
  // of their decoders at once.
  const decoding = choose ? await choose().catch(() => null) : null;
  const copier = context.previewLumaCopier?.();
  let reader: DepthPreviewTrackReader;

  try {
    reader = await open(url, {
      copier,
      correction: decoding?.correction ?? null,
      hardwareAcceleration: decoding?.hardwareAcceleration,
    });
  } catch (error) {
    if (error instanceof RangeError || context.signal?.aborted) throw error;
    console.warn(
      `The depth preview ${url} did not open, so depth is drawn only while playback rests: ${String(error)}`,
    );
    return null;
  }

  try {
    if (context.signal?.aborted) throw context.signal.reason;
    assertMediaAspect(reader, context.media);
    assertDepthPreviewTimeline(
      reader,
      frames.count,
      (index) => timing.timeAt(index) - timing.timeAt(0),
    );
  } catch (error) {
    reader.dispose();
    throw error;
  }

  const message = describePreviewDecoding(decoding);

  if (message) console.warn(message);

  return { copier, message: () => message, reader, track };
}

/**
 * Says what diagnostics should about the page's preview decoder: nothing
 * when it returns codes as written.
 */
export function describePreviewDecoding(
  decoding: DepthPreviewDecoding | null,
): string | null {
  const probe = decoding?.probe;

  if (!decoding || !probe || probe.exact) return null;

  const corrected = decoding.correction
    ? `; corrected through the probe's table to within ${decoding.residualError}`
    : "";

  return `This browser's ${decoding.hardwareAcceleration} decoder changes depth preview codes: ${probe.mismatchedCodes} of 256 come back different, by up to ${probe.maxError} (${probe.lumaPath ?? "unknown"} path)${corrected}. Preview depth during playback is off by up to ${decoding.correction ? decoding.residualError : probe.maxError} preview steps; exact depth at rest is not affected.`;
}

async function openDefaultPreviewTrack(
  url: string,
  options?: DepthPreviewTrackOptions,
) {
  const { openDepthPreviewTrack } = await import("#media/depth-preview-track");

  return openDepthPreviewTrack(url, options);
}

async function chooseDefaultPreviewDecoding() {
  const { chooseDepthPreviewDecoding } =
    await import("#media/depth-preview-probe");

  return chooseDepthPreviewDecoding();
}

/**
 * Refuses a preview whose frames are not the depth frames, one for one, at
 * the same times. Both timelines are compared from their own first frame, so
 * a preview that starts its clock elsewhere still lines up; a different frame
 * count, rate, or a frame out of step does not.
 */
export function assertDepthPreviewTimeline(
  preview: { readonly frameCount: number; readonly times: Float64Array },
  count: number,
  expectedTime: (index: number) => number,
): void {
  if (preview.frameCount !== count) {
    throw new RangeError(
      `The depth preview has ${preview.frameCount} frames and depth.json has ${count}; a preview needs one frame per depth frame.`,
    );
  }

  for (let index = 0; index < count; index += 1) {
    const previewTime = preview.times[index];
    const videoTime = expectedTime(index);

    if (
      Math.abs(previewTime - videoTime) >
      PLAYHEAD_QUANTIZATION_TOLERANCE_SECONDS
    ) {
      throw new RangeError(
        `Depth preview frame ${index} is at ${formatSeconds(previewTime)} and its video frame at ${formatSeconds(videoTime)}, each from its own first frame; a preview must keep the video's frame times.`,
      );
    }
  }
}

function formatSeconds(seconds: number) {
  return `${Number(seconds.toFixed(6))} s`;
}

/**
 * The clip's budgets. Byte budgets that are not given scale with the clip's
 * resolution, so a 4K clip keeps about as many seconds as a 720p one.
 */
export function resolveDepthClipOptions(
  clip: {
    /** Bytes of one decoded exact frame, its confidence plane included. */
    readonly exactFrameBytes: number;
    /** Bytes of one decoded preview frame, 0 without a preview. */
    readonly previewFrameBytes: number;
    readonly frameRate: number;
  },
  options: RenderPreparationDepthOptions = {},
): {
  readonly exact: ExactDepthFrameOptions;
  readonly preview: {
    readonly maxCacheBytes: number;
    readonly prefetchSeconds: number;
    readonly retainSeconds: number;
  };
} {
  const neighborFrameCount = Math.max(
    0,
    Math.floor(
      options.exactNeighborFrameCount ??
        defaultExactDepthFrameOptions.neighborFrameCount,
    ),
  );
  const prefetchSeconds = Math.max(
    0,
    options.previewPrefetchSeconds ?? DEFAULT_PREVIEW_PREFETCH_SECONDS,
  );
  const retainSeconds = Math.max(
    0,
    options.previewRetainSeconds ?? DEFAULT_PREVIEW_RETAIN_SECONDS,
  );
  const frameRate =
    Number.isFinite(clip.frameRate) && clip.frameRate > 0 ? clip.frameRate : 30;
  const previewSpanFrames = Math.ceil(
    (2 * prefetchSeconds + retainSeconds) * frameRate,
  );

  return {
    exact: {
      maxCacheBytes:
        options.maxExactCacheBytes ??
        Math.max(
          defaultExactDepthFrameOptions.maxCacheBytes,
          clip.exactFrameBytes * (2 * neighborFrameCount + 1) * 2,
        ),
      neighborFrameCount,
      settleSeconds: Math.max(
        0,
        options.exactSettleSeconds ??
          defaultExactDepthFrameOptions.settleSeconds,
      ),
    },
    preview: {
      maxCacheBytes:
        options.maxPreviewCacheBytes ??
        Math.min(
          MAX_DEFAULT_PREVIEW_CACHE_BYTES,
          Math.max(
            MIN_DEFAULT_PREVIEW_CACHE_BYTES,
            clip.previewFrameBytes * previewSpanFrames,
          ),
        ),
      prefetchSeconds,
      retainSeconds,
    },
  };
}

/** The last index whose time is at or before `time`, or null before the first. */
function lastTimeAtOrBefore(
  times: readonly number[],
  time: number,
): number | null {
  let low = 0;
  let high = times.length - 1;
  let found: number | null = null;

  while (low <= high) {
    const middle = (low + high) >> 1;

    if (times[middle] <= time) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return found;
}

function isAbortError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

/**
 * A manifest passed as an object is trusted to be `parseDepthManifest`'s
 * output; only what loading its files depends on is checked again.
 */
function checkParsedManifest(manifest: DepthManifest): DepthManifest {
  if (
    manifest.schema !== "supervision.depth-manifest" ||
    !Number.isInteger(manifest.width) ||
    !Number.isInteger(manifest.height) ||
    !(manifest.storage?.scale > 0) ||
    // The wire format spells it no_depth; only the parsed form has noDepth.
    manifest.storage.noDepth !== 0
  ) {
    throw new RangeError(
      "A depth manifest object must come from parseDepthManifest; pass the depth.json URL to have it parsed.",
    );
  }

  return manifest;
}

async function fetchBytes(
  fetchFile: typeof globalThis.fetch,
  url: string,
  signal: AbortSignal | undefined,
): Promise<ArrayBuffer> {
  const response = await fetchFile(url, { signal });

  if (!response.ok) {
    throw new Error(
      `Unable to load depth image ${url}: ${response.status} ${response.statusText}`.trim(),
    );
  }

  return response.arrayBuffer();
}

function assertImageSize(
  file: string,
  image: { readonly width: number; readonly height: number },
  manifest: DepthManifest,
) {
  if (image.width !== manifest.width || image.height !== manifest.height) {
    throw new RangeError(
      `${file} is ${image.width}x${image.height}, but depth.json says ${manifest.width}x${manifest.height}.`,
    );
  }
}

/**
 * Resolves `file` against `base`, itself resolved against the page. Without
 * a page (a worker, a test), a relative base still joins by path.
 */
export function resolveUrl(
  file: string,
  base: string | URL | undefined,
): string {
  const page = (globalThis as { location?: { href?: string } }).location?.href;

  try {
    const absoluteBase =
      base === undefined ? page : new URL(String(base), page).href;

    return absoluteBase === undefined
      ? new URL(file).href
      : new URL(file, absoluteBase).href;
  } catch {
    if (base === undefined || /^[a-z][a-z0-9+.-]*:|^\//i.test(file)) {
      return file;
    }

    return `${String(base).replace(/[^/]*$/, "")}${file}`;
  }
}

/**
 * The map is stretched over the media rectangle, so a map of another shape
 * would put depth beside the pixels it measures.
 */
function assertMediaAspect(
  map: { readonly width: number; readonly height: number },
  media: { readonly width: number; readonly height: number },
): void {
  if (media.width <= 0 || media.height <= 0) {
    return;
  }

  const mediaAspect = media.width / media.height;
  const mapAspect = map.width / map.height;

  if (
    Math.abs(mapAspect - mediaAspect) >
    mediaAspect * DEPTH_ASPECT_TOLERANCE
  ) {
    throw new RangeError(
      `Depth map ${map.width}x${map.height} does not have the aspect ratio of the ${media.width}x${media.height} media.`,
    );
  }
}
