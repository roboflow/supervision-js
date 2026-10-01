import {
  parseDepthManifest,
  PLAYHEAD_QUANTIZATION_TOLERANCE_SECONDS,
  resolveDepthFrameFile,
  validateDepthMap,
  type DepthClipFrames,
  type DepthManifest,
  type DepthMap,
  type DepthPreviewLevels,
} from "supervision-js-core";
import type {
  DepthPreviewDecoderVerdict,
  DepthPreviewDecoding,
} from "#media/depth-preview-probe";
import type {
  DepthPreviewTrackOptions,
  DepthPreviewTrackReader,
} from "#media/depth-preview-track";
import { rememberPreparedDepthUpload } from "#renderers/depth-textures";
import type { MediaFrameClock } from "#types/media-frame-clock";
import type { MediaRendererDepthInput } from "#types/media-depth";
import {
  RenderPreparationArtifactFrameStatus,
  RenderPreparationArtifactKind,
  RenderPreparationExecutionMode,
  RenderPreparationWorkerStatus,
  type RenderPreparationArtifactDiagnostics,
  type DepthPlaybackSource,
  type RenderPreparationDepthOptions,
  type RenderPreparationDiagnostics,
  type RenderPreparationMaskFrameOptions,
  type ResolvedRenderPreparationGateThresholds,
} from "#types/render-preparation";
import { resolveDisplayPixelRatio } from "#media/display-pixel-ratio";
import {
  createExactDepthFrameSource,
  type ExactDepthFrame,
  type ExactDepthFrameSource,
} from "./depth-exact-frames";
import { abortable, type DepthFramePreparer } from "./depth-frame-preparer";
import type { DepthPreviewLumaCopier } from "./depth-preview-luma";
import {
  createDepthPreviewWindow,
  type DepthPreviewWindow,
} from "./depth-preview-window";
import {
  getPausedPreparedWindowFrameCount,
  MAX_PRESENTED_FRAME_STRIDE,
  WINDOW_LEAD_FRACTION,
} from "./playhead-motion";
import { DEFAULT_MASK_SCHEDULE_BATCH_SIZE } from "./prepared-render-window";

/** How far a map's aspect ratio may stray from the media's. */
const DEPTH_ASPECT_TOLERANCE = 0.01;
const MEBIBYTE = 1024 * 1024;
const DEFAULT_PREVIEW_PREFETCH_SECONDS = 1;
const DEFAULT_PREVIEW_RETAIN_SECONDS = 0.25;
/**
 * Depth's timing defaults for a file session. The byte budgets are left out
 * because they scale with each clip's size.
 */
export const DEFAULT_DEPTH_TIMING_OPTIONS = {
  exactNeighborFrameCount: 2,
  exactSettleSeconds: 0.15,
  playback: "auto",
  previewPrefetchSeconds: DEFAULT_PREVIEW_PREFETCH_SECONDS,
  previewRetainSeconds: DEFAULT_PREVIEW_RETAIN_SECONDS,
} as const satisfies RenderPreparationDepthOptions;
/**
 * A stream session decodes depth half as far ahead, as its mask window cooks
 * 3 s ahead where a file's cooks 7 s: what is ahead of a live playhead is
 * still arriving, and depth shares the link with it.
 */
export const STREAM_DEPTH_TIMING_OPTIONS = {
  ...DEFAULT_DEPTH_TIMING_OPTIONS,
  previewPrefetchSeconds: DEFAULT_PREVIEW_PREFETCH_SECONDS / 2,
} as const satisfies RenderPreparationDepthOptions;
/** Of the lead exact playback loads ahead, the share it needs to take over. */
const EXACT_TAKEOVER_SHARE = 0.75;
/** And the share below which it hands back to the preview. */
const EXACT_HANDBACK_SHARE = 0.25;
/** The first wait before exact playback is tried again; each hand-back doubles it. */
const EXACT_RETRY_START_MS = 1000;
const EXACT_RETRY_MAX_MS = 16_000;
/** Exact playback this long without a hand-back earns the first wait back. */
const EXACT_STEADY_MS = 10_000;
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
  /** Whether a drag holds the playhead, as opposed to playback moving it. */
  setScrubbing?(scrubbing: boolean): void;
  /** Whether playback wraps at the media end: decoding ahead wraps with it. */
  setLoop?(loop: boolean): void;
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
  /**
   * The depth frame `getEntry` answers for `mediaTime`, without drawing it,
   * and whether it is decoded yet. Null where there is no depth frame.
   */
  getFrameStatus?(
    mediaTime: number,
  ): { readonly frameIndex: number | null; readonly prepared: boolean } | null;
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
  /**
   * Reads the frame index for media that does not keep one, the first time
   * a clip asks: a Mediabunny URL or Blob.
   */
  readonly readFrameClock?: (() => Promise<MediaFrameClock>) | null;
  /** Why the media has no frame index, told to a clip that needs one. */
  readonly frameClockUnavailableReason?: string;
  /** The decoder, created only when a manifest needs one. */
  readonly preparer?: () => DepthFramePreparer;
  readonly fetch?: typeof globalThis.fetch;
  /** Pad odd-width rows for WebGL while decoding, off the main thread. */
  readonly padRowsForWebGl?: boolean;
  /**
   * The box the picture is shown in. Exact depth larger than that box shows
   * at its pixel ratio, by a whole factor of 2 or more, goes up decimated by
   * that factor, prepared while decoding; readouts keep the full map.
   */
  readonly display?: RenderPreparationMaskFrameOptions["display"];
  readonly signal?: AbortSignal;
  /** The host's budgets and timing for clips. */
  readonly depth?: RenderPreparationDepthOptions;
  /** Overrides for the exact frames, over `depth`. */
  readonly exactFrames?: Partial<ExactDepthFrameOptions>;
  /**
   * The mask window's schedule batch, which also sizes what the preview keeps
   * at rest: masks and depth keep the same margin ahead of a paused frame.
   */
  readonly scheduleBatchSize?: number;
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
   * Picks, once per page and level, the decoder that returns preview codes
   * as written; null skips the probe and leaves the choice to the browser.
   */
  readonly choosePreviewDecoding?:
    ((levels: DepthPreviewLevels) => Promise<DepthPreviewDecoding>) | null;
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
        decimateBy: displayDecimation(manifest, context),
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
  if (depth.decimatedUpload) {
    rememberPreparedDepthUpload(map, {
      bytes: depth.decimatedUpload.bytes,
      displaySize: {
        height: depth.decimatedUpload.height,
        width: depth.decimatedUpload.width,
      },
      format: "rg8unorm",
      textureWidth: depth.decimatedUpload.textureWidth,
    });
  } else if (depth.paddedUpload) {
    rememberPreparedDepthUpload(map, {
      bytes: depth.paddedUpload.bytes,
      format: "rg8unorm",
      textureWidth: depth.paddedUpload.textureWidth,
    });
  }

  return map;
}

/**
 * The whole factor a map can shrink by for upload and still have a texel
 * for every pixel of the box it is shown in, at the box's pixel ratio; 1
 * without a box.
 */
export function displayDecimation(
  map: { readonly width: number; readonly height: number },
  context: Pick<DepthSourceContext, "display" | "media">,
): number {
  const { display, media } = context;

  if (!display || media.width <= 0 || media.height <= 0) return 1;

  const fit = Math.min(
    display.boxWidth / media.width,
    display.boxHeight / media.height,
  );
  const shownWidth = media.width * fit * resolveDisplayPixelRatio(display);
  const shownHeight = media.height * fit * resolveDisplayPixelRatio(display);

  if (!(shownWidth > 0) || !(shownHeight > 0)) return 1;

  return Math.max(
    1,
    Math.floor(Math.min(map.width / shownWidth, map.height / shownHeight)),
  );
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
  const { preview, unavailable } = await openClipPreview(
    manifest,
    frames,
    base,
    context,
    { endAt, timeAt },
  );
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
    { scheduleBatchSize: context.scheduleBatchSize },
  );
  const options = { ...budgets.exact, ...context.exactFrames };
  const exactFrameBytes =
    manifest.width *
    manifest.height *
    (frames.confidence === undefined ? 2 : 3);
  const exactFiles = (index: number): DepthMapFiles => ({
    confidenceFile:
      frames.confidence === undefined
        ? undefined
        : resolveDepthFrameFile(frames.confidence, index),
    file: resolveDepthFrameFile(frames.exact, index),
  });
  const listeners = new Set<() => void>();
  const cache = new Map<number, CachedDepthFrame>();
  const loading = new Map<number, Promise<void>>();
  const landingWaiters = new Set<() => void>();
  const previewEntries = new WeakMap<DepthMap, DepthFrameEntry>();
  const teardown = new AbortController();
  const exactCapacityFrames = Math.max(
    1,
    Math.floor(
      options.maxCacheBytes /
        Math.max(
          1,
          manifest.width *
            manifest.height *
            (frames.confidence === undefined ? 2 : 3),
        ),
    ),
  );
  let cachedBytes = 0;
  let onScreen: number | null = null;
  let active = false;
  let scrubbing = false;
  let hidden = false;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let run: AbortController | undefined;
  let warned = false;
  let destroyed = false;
  let queuedPlayhead: number | null = null;
  let diagnosticsTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Set once the producer reports its playhead. From then on decoding
   * follows that playhead, which leads the frames a drag puts on screen,
   * rather than the drawn frame, which trails them.
   */
  let prefetchDriven = false;

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

  let previewStopped: string | null = null;

  /** The exact frames: those kept, those loading, and whether the one on screen is in. */
  const exactDiagnostics = (): RenderPreparationArtifactDiagnostics => ({
    activeFrame:
      onScreen === null
        ? null
        : {
            key: `depth:${onScreen}`,
            mediaTime: timeAt(onScreen),
            status: cache.has(onScreen)
              ? RenderPreparationArtifactFrameStatus.Prepared
              : RenderPreparationArtifactFrameStatus.Pending,
          },
    inFlightCount: loading.size,
    kind: RenderPreparationArtifactKind.ExactDepthFrame,
    maxInFlightCount: exactConcurrency(),
    maxPreparedCount: exactCapacityFrames,
    pendingCount: loading.size,
    prefetchCount: 2 * options.neighborFrameCount + 1,
    preparedCount: cache.size,
  });

  const reportDiagnostics = () => {
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
          ? [
              {
                ...exactWindow.getDiagnostics(),
                exactPlayback: {
                  drawn: playsExact,
                  fallbackCount: exactFallbacks,
                  loadRate: exactFrames?.loadRate() ?? null,
                  meanLoadMs: exactFrames?.meanLoadMs() ?? null,
                },
                precision: "exact" as const,
              },
            ]
          : []),
        exactDiagnostics(),
      ],
      // The decoder runs where the browser puts it; the work this page
      // does per frame, copying its codes out, runs in the worker or here.
      executionMode: offMainThread
        ? RenderPreparationExecutionMode.Worker
        : RenderPreparationExecutionMode.MainThread,
      message: previewStopped ?? unavailable ?? preview?.message() ?? null,
      workerStatus: offMainThread
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

  /** A decoder that stopped is closed, not left holding its frames. */
  const closeStoppedPreview = () => {
    if (
      !preview ||
      !previewWindow ||
      previewWindow.failure === null ||
      previewStopped !== null
    ) {
      return;
    }
    previewStopped = `The depth preview stopped decoding, so depth is drawn only while playback rests: ${String(previewWindow.failure)}`;
    preview.reader.dispose();
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
            levels: preview.track.levels,
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
        onChange: () => {
          closeStoppedPreview();
          scheduleDiagnostics();
        },
        onFrame: (index) => {
          // Only a landing for the frame on screen changes the picture.
          if (index === onScreen) notify();
        },
        pausedFrameCount: budgets.preview.pausedFrameCount,
        prefetchSeconds: budgets.preview.prefetchSeconds,
        retainSeconds: budgets.preview.retainSeconds,
        timeAt,
      })
    : null;

  const playbackSource = budgets.playback.source;
  const exactFrames: ExactDepthFrameSource | null =
    playbackSource === "preview"
      ? null
      : createExactDepthFrameSource({
          concurrency: () => exactConcurrency(),
          frameCount: frames.count,
          load: (index, signal) => {
            const kept = cache.get(index);

            if (kept) return Promise.resolve(kept.entry.map);

            return loadDepthMap(
              manifest,
              exactFiles(index),
              base,
              context,
              AbortSignal.any([teardown.signal, signal]),
            );
          },
        });
  const exactEntries = new WeakMap<DepthMap, DepthFrameEntry>();
  const exactWindow: DepthPreviewWindow | null = exactFrames
    ? createDepthPreviewWindow<ExactDepthFrame>({
        bytesOf: ({ map }) =>
          map.samples.values.byteLength + (map.confidence?.byteLength ?? 0),
        createMap: ({ map }) => map,
        endAt,
        frameBytes: exactFrameBytes,
        frames: exactFrames,
        maxBytes: budgets.playback.maxExactCacheBytes,
        onChange: () => {
          if (
            exactWindow?.failure !== null &&
            exactWindow?.failure !== undefined
          ) {
            dropExactPlayback();
          }
          scheduleDiagnostics();
        },
        onFrame: (index) => {
          if (index === onScreen && playsExact) notify();
        },
        pausedFrameCount: budgets.preview.pausedFrameCount,
        precision: "exact",
        prefetchSeconds: budgets.preview.prefetchSeconds,
        retainSeconds: budgets.preview.retainSeconds,
        timeAt,
      })
    : null;
  /** Whether playback draws exact frames now; "auto" moves it with their lead. */
  let playsExact =
    exactWindow !== null && (playbackSource === "exact" || !previewWindow);
  let exactFallbacks = 0;
  /** Wall time before which "auto" does not try exact playback again. */
  let exactRetryAt = 0;
  let exactBackoffMs = EXACT_RETRY_START_MS;
  let exactSince = 0;
  /** The frame playback last drew, to tell a seek from exact depth falling behind. */
  let lastPlayed: number | null = null;
  let looping = false;

  /** Exact frames that stop loading leave playback to the preview, for good. */
  function dropExactPlayback() {
    if (!playsExact || !previewWindow) return;
    playsExact = false;
    exactFallbacks += 1;
    exactRetryAt = Number.POSITIVE_INFINITY;
  }

  /**
   * Which depth plays the frame at `index`. "auto" takes exact depth once its
   * lead reaches three quarters of what it loads ahead, and hands back to the
   * preview when that lead falls under a quarter or the frame is missing,
   * waiting longer each time before it tries again; a stretch of steady
   * exact playback earns the short wait back.
   */
  const playsExactAt = (index: number): boolean => {
    if (!exactWindow || exactWindow.failure !== null) return false;
    if (playbackSource !== "auto" || !previewWindow) return true;

    if (lastPlayed !== null && index !== lastPlayed) {
      const forward =
        index >= lastPlayed
          ? index - lastPlayed
          : looping
            ? index + frames.count - lastPlayed
            : Number.POSITIVE_INFINITY;

      // A seek lands where nothing was loaded ahead, which says nothing
      // about whether exact depth keeps up: it starts over on the preview.
      if (forward > 2 * MAX_PRESENTED_FRAME_STRIDE) playsExact = false;
    }
    lastPlayed = index;

    const lead = exactWindow.leadSeconds(index);
    // Near the end of a clip that does not loop, the end is all there is to lead.
    const wanted = Math.min(
      exactWindow.wantedLeadSeconds(index),
      endAt(frames.count - 1) - timeAt(index),
    );
    const clock = performance.now();

    if (playsExact) {
      if (
        exactWindow.getEntry(index) !== null &&
        lead >= wanted * EXACT_HANDBACK_SHARE
      ) {
        if (clock - exactSince > EXACT_STEADY_MS)
          exactBackoffMs = EXACT_RETRY_START_MS;
        return true;
      }
      playsExact = false;
      exactFallbacks += 1;
      exactRetryAt = clock + exactBackoffMs;
      exactBackoffMs = Math.min(EXACT_RETRY_MAX_MS, exactBackoffMs * 2);
      scheduleDiagnostics();
      return false;
    }
    if (
      clock >= exactRetryAt &&
      exactWindow.getEntry(index) !== null &&
      lead >= wanted * EXACT_TAKEOVER_SHARE
    ) {
      playsExact = true;
      exactSince = clock;
      scheduleDiagnostics();
    }

    return playsExact;
  };

  const playing = () => active && !scrubbing;

  /**
   * Playback starts, or resumes after a drag: in "auto" it opens on the
   * preview until exact depth has its lead, whatever played last time.
   */
  const startPlaying = () => {
    lastPlayed = null;
    if (playbackSource === "auto" && previewWindow) playsExact = false;
    if (onScreen !== null) moveWindows(onScreen);
  };

  scheduleDiagnostics();

  /**
   * The present asks for the frame on screen; decoding moves there right
   * after it, never inside it. Only until the producer reports a playhead
   * of its own.
   */
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

  /**
   * Decoding ahead follows the playhead. Exact frames load ahead only while
   * playback runs and they may play; the preview is left alone only while
   * exact depth plays in "exact".
   */
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

  const exactPlaybackEntry = (index: number): DepthFrameEntry | null => {
    const entry = exactWindow?.getEntry(index);

    if (!entry) return null;

    let wrapped = exactEntries.get(entry.map);

    if (!wrapped) {
      wrapped = { frameIndex: index, map: entry.map, precision: "exact" };
      exactEntries.set(entry.map, wrapped);
    }

    return wrapped;
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

  /**
   * Fetches and decodes one frame once; a second ask shares the first. A
   * frame playback already loaded ahead is kept, not fetched again.
   */
  const load = (index: number): Promise<void> => {
    if (cache.has(index)) return Promise.resolve();

    const played = exactWindow?.getEntry(index);

    if (played) {
      store(index, played.map);
      return Promise.resolve();
    }

    let pending = loading.get(index);

    if (!pending) {
      pending = loadDepthMap(
        manifest,
        exactFiles(index),
        base,
        context,
        teardown.signal,
      )
        .then((map) => {
          if (destroyed) return;
          store(index, map);
          for (const landed of [...landingWaiters]) landed();
          if (index === onScreen && !active) notify();
        })
        .catch((error: unknown) => {
          if (destroyed || isAbortError(error) || warned) return;
          warned = true;
          console.warn(
            `Depth frame ${index} did not load, so ${previewWindow ? "its preview stands in for it at rest" : "no depth is drawn over it"}: ${String(error)}`,
          );
        })
        .finally(() => {
          loading.delete(index);
          scheduleDiagnostics();
        });
      loading.set(index, pending);
      scheduleDiagnostics();
    }

    return pending;
  };

  /**
   * The frame on screen first, then its neighbours nearest first, most of
   * them the way the playhead last moved: a step lands on a frame already
   * loaded, as a step onto the mask window's paused margin does. A move stops
   * the frames not yet asked for; one already loading finishes and is kept.
   */
  const loadAround = (center: number, signal: AbortSignal) =>
    loadInOrder(
      [
        center,
        ...neighbourOrder(
          center,
          options.neighborFrameCount,
          previewWindow?.heading() ?? lastStep,
        ).filter((index) => index >= 0 && index < frames.count),
      ],
      load,
      exactConcurrency(),
      signal,
    );

  /** Loads run at once: one per decode worker, as the mask pool sizes them. */
  const exactConcurrency = () =>
    Math.max(1, context.preparer?.().concurrency ?? 1);

  /** Which way the frame on screen last moved, for a clip without a preview. */
  let lastStep: -1 | 0 | 1 = 0;

  const settle = () => {
    clearTimeout(settleTimer);
    settleTimer = undefined;
    run?.abort();
    run = undefined;
    if (active || hidden || onScreen === null || destroyed) return;

    const center = onScreen;
    const next = new AbortController();

    run = next;
    settleTimer = setTimeout(() => {
      settleTimer = undefined;
      void loadAround(center, next.signal);
    }, options.settleSeconds * 1000);
  };

  const onVisibility = () => {
    const next = document.visibilityState === "hidden";

    if (next === hidden || destroyed) return;
    hidden = next;
    previewWindow?.setHidden(hidden);
    exactWindow?.setHidden(hidden);
    settle();
  };

  if (typeof document !== "undefined") {
    hidden = document.visibilityState === "hidden";
    previewWindow?.setHidden(hidden);
    exactWindow?.setHidden(hidden);
    document.addEventListener("visibilitychange", onVisibility);
  }

  /** Resolves once an exact frame lands for `index`, or `signal` aborts. */
  const exactLanding = (index: number, signal?: AbortSignal) =>
    new Promise<void>((resolve) => {
      const landed = () => {
        if (!cache.has(index) && !destroyed && !signal?.aborted) return;
        landingWaiters.delete(landed);
        signal?.removeEventListener("abort", landed);
        resolve();
      };

      landingWaiters.add(landed);
      signal?.addEventListener("abort", landed, { once: true });
    });

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
        // flicker, a preview step being coarser than a colour step. A frame
        // the exact frames miss draws its preview, never another frame.
        return playsExactAt(index)
          ? (exactPlaybackEntry(index) ?? previewEntry(index))
          : previewEntry(index);
      }
      // A drag draws the preview; at rest the exact frame replaces it.
      const exact = active
        ? null
        : (cache.get(index)?.entry ?? exactPlaybackEntry(index));

      return exact ?? previewEntry(index);
    },

    getFrameStatus(mediaTime) {
      const index = indexAt(mediaTime);

      if (index === null || destroyed) return null;

      return {
        frameIndex: index,
        prepared:
          (!active && cache.has(index)) ||
          (playing() && playsExact && exactWindow?.getEntry(index) != null) ||
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
      if (playing() && playsExact && exactWindow) {
        return exactWindow
          .upcoming(index, count, skip)
          .map((entry) => exactPlaybackEntry(entry.index)!)
          .filter(Boolean);
      }
      if (!previewWindow) return [];

      return previewWindow
        .upcoming(index, count, skip)
        .map((entry) => previewEntry(entry.index)!)
        .filter(Boolean);
    },

    needsPlaybackGateWait(mediaTime, thresholds) {
      const index = indexAt(mediaTime);

      if (index === null) return false;
      if (playing() && playsExactAt(index)) {
        return exactWindow!.needsPlaybackGateWait(index, thresholds);
      }
      if (previewWindow === null) return false;
      // At rest an exact frame already in draws without its preview.
      if (!active && cache.has(index)) return false;

      return previewWindow.needsPlaybackGateWait(index, thresholds);
    },

    waitForReady(mediaTime, thresholds, signal) {
      const index = indexAt(mediaTime);

      if (index === null) return Promise.resolve();
      if (playing() && playsExactAt(index)) {
        // The window is held at the frame about to show and loads from there.
        return exactWindow!.waitForReady(index, thresholds, signal);
      }
      if (!previewWindow) return Promise.resolve();
      if (!active && cache.has(index)) return Promise.resolve();

      const settled = new AbortController();
      const stop = () => settled.abort();

      signal?.addEventListener("abort", stop, { once: true });

      const waits = [
        previewWindow.waitForReady(index, thresholds, settled.signal),
      ];

      // A step at rest is ready as soon as either of its depths is.
      if (!active) waits.push(exactLanding(index, settled.signal));

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
      // Exact frames load ahead for playback only; a drag draws the preview.
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
      clearTimeout(settleTimer);
      clearTimeout(diagnosticsTimer);
      run?.abort();
      teardown.abort();
      for (const landed of [...landingWaiters]) landed();
      previewWindow?.destroy();
      exactWindow?.destroy();
      preview?.reader.dispose();
      listeners.clear();
      cache.clear();
      cachedBytes = 0;
    },
  };
}

/**
 * Runs `load` over `indices` with up to `concurrency` at once, starting them
 * in order, so the first ones land first. An abort starts no more; loads
 * already running finish.
 */
export async function loadInOrder(
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
 * The neighbours of `center` an exact load visits, nearest first. With a
 * heading, three in four go the way the playhead moves, as a scrub window
 * spends its frames; without one, both sides alternate.
 */
export function neighbourOrder(
  center: number,
  perSide: number,
  heading: -1 | 0 | 1,
): number[] {
  const total = 2 * perSide;

  if (heading === 0) {
    const order: number[] = [];

    for (let step = 1; step <= perSide; step += 1) {
      order.push(center + step, center - step);
    }

    return order;
  }

  const towards = Math.min(total, Math.ceil(total * WINDOW_LEAD_FRACTION));
  const order: number[] = [];

  for (let step = 1; step <= Math.max(towards, total - towards); step += 1) {
    if (step <= towards) order.push(center + heading * step);
    if (step <= total - towards) order.push(center - heading * step);
  }

  return order;
}

interface OpenedClipPreview {
  readonly reader: DepthPreviewTrackReader;
  /** What copies decoded frames' codes out, when not the page itself. */
  readonly copier: DepthPreviewLumaCopier | undefined;
  readonly track: NonNullable<DepthManifest["preview"]>;
  /** What diagnostics say about the preview, such as altered codes. */
  message(): string | null;
}

interface ClipPreview {
  readonly preview: OpenedClipPreview | null;
  /** Why a clip with a preview draws none, for diagnostics; else null. */
  readonly unavailable: string | null;
}

/**
 * Opens the clip's preview video and checks it against the media it is
 * drawn over: one preview frame per depth frame, each at its video frame's
 * time. A preview that disagrees is refused with a `RangeError`. One this
 * browser cannot open or decode leaves the clip with exact depth at rest
 * only, and says why once in the console and in diagnostics.
 *
 * The probe's decoder steps carry their own deadlines; the preview's file is
 * never given one, since a slow link is no reason to drop it.
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
): Promise<ClipPreview> {
  const track = manifest.preview;
  const open =
    context.openPreviewTrack === undefined
      ? openDefaultPreviewTrack
      : context.openPreviewTrack;

  if (!track || !open) return { preview: null, unavailable: null };

  const url = resolveUrl(track.file, base);
  const choose =
    context.choosePreviewDecoding === undefined
      ? chooseDefaultPreviewDecoding
      : context.choosePreviewDecoding;
  const unavailable = (reason: string): ClipPreview => {
    const message = `The depth preview ${url} is off, so depth is drawn only while playback rests: ${reason}`;

    console.warn(message);
    return { preview: null, unavailable: message };
  };
  let decoding: DepthPreviewDecoding | null = null;

  // The probe decodes before the preview opens, so the page never holds two
  // of their decoders at once.
  if (choose) {
    try {
      decoding = await abortable(choose(track.levels), context.signal);
    } catch (error) {
      if (context.signal?.aborted) throw error;
      return unavailable(`its decoder probe failed: ${String(error)}`);
    }
    if (!decoding.probe) {
      return unavailable(
        `no decoder in this browser returned a frame of the probe clip (${describeVerdicts(decoding.verdicts)}).`,
      );
    }
  }

  const copier = context.previewLumaCopier?.();
  let reader: DepthPreviewTrackReader;

  try {
    reader = await open(url, {
      copier,
      correction: decoding?.correction ?? null,
      hardwareAcceleration: decoding?.hardwareAcceleration,
      signal: context.signal,
    });
  } catch (error) {
    if (error instanceof RangeError || context.signal?.aborted) throw error;
    return unavailable(`it did not open: ${String(error)}`);
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

  return {
    preview: { copier, message: () => message, reader, track },
    unavailable: null,
  };
}

function describeVerdicts(verdicts: readonly DepthPreviewDecoderVerdict[]) {
  return verdicts
    .map(({ error, hardwareAcceleration, supported }) =>
      supported
        ? `${hardwareAcceleration}: ${error ?? "no frame"}`
        : `${hardwareAcceleration}: not offered`,
    )
    .join("; ");
}

/**
 * Says what diagnostics should about the page's preview decoder: nothing
 * when its codes come back as written, directly or through the probe's table.
 */
export function describePreviewDecoding(
  decoding: DepthPreviewDecoding | null,
): string | null {
  const probe = decoding?.probe;

  if (!decoding || !probe || decoding.residualError === 0) return null;

  const corrected = decoding.correction
    ? `; corrected through the probe's table to within ${decoding.residualError}`
    : "";

  return `This browser's ${decoding.hardwareAcceleration} decoder changes depth preview codes: ${probe.mismatchedCodes} of ${probe.judgedCodes} come back different, by up to ${probe.maxError} (${probe.lumaPath ?? "unknown"} path)${corrected}. Preview depth during playback is off by up to ${decoding.correction ? decoding.residualError : probe.maxError} preview steps; exact depth at rest is not affected.`;
}

async function openDefaultPreviewTrack(
  url: string,
  options?: DepthPreviewTrackOptions,
) {
  const { openDepthPreviewTrack } = await import("#media/depth-preview-track");

  return openDepthPreviewTrack(url, options);
}

async function chooseDefaultPreviewDecoding(levels: DepthPreviewLevels) {
  const { chooseDepthPreviewDecoding } =
    await import("#media/depth-preview-probe");

  return chooseDepthPreviewDecoding(levels);
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
  shared: { readonly scheduleBatchSize?: number } = {},
): {
  readonly exact: ExactDepthFrameOptions;
  readonly playback: {
    readonly source: DepthPlaybackSource;
    /** Exact frames loaded ahead for playback, in bytes. */
    readonly maxExactCacheBytes: number;
  };
  readonly preview: {
    readonly maxCacheBytes: number;
    /** Frames a resting playhead keeps decoded ahead, its own included. */
    readonly pausedFrameCount: number;
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
  const scaledBudget = (frameBytes: number) =>
    Math.min(
      MAX_DEFAULT_PREVIEW_CACHE_BYTES,
      Math.max(MIN_DEFAULT_PREVIEW_CACHE_BYTES, frameBytes * previewSpanFrames),
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
    playback: {
      maxExactCacheBytes:
        options.maxExactPlaybackCacheBytes ??
        scaledBudget(clip.exactFrameBytes),
      source:
        options.playback === "exact" || options.playback === "preview"
          ? options.playback
          : "auto",
    },
    preview: {
      maxCacheBytes:
        options.maxPreviewCacheBytes ?? scaledBudget(clip.previewFrameBytes),
      // What the mask window keeps at rest, one schedule batch past the
      // frame on screen, and never fewer than the neighbours a step reaches.
      pausedFrameCount: Math.max(
        neighborFrameCount + 1,
        getPausedPreparedWindowFrameCount({
          prefetchFrameCount: Math.ceil(prefetchSeconds * frameRate),
          scheduleBatchSize: Math.max(
            1,
            shared.scheduleBatchSize ?? DEFAULT_MASK_SCHEDULE_BATCH_SIZE,
          ),
        }),
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
