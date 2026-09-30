import {
  parseDepthManifest,
  PLAYHEAD_QUANTIZATION_TOLERANCE_SECONDS,
  resolveDepthFrameFile,
  validateDepthMap,
  type DepthClipFrames,
  type DepthManifest,
  type DepthMap,
} from "supervision-js-core";
import { rememberPreparedDepthUpload } from "#renderers/depth-textures";
import type { MediaFrameClock } from "#types/media-frame-clock";
import type { MediaRendererDepthInput } from "#types/media-depth";
import type { DepthFramePreparer } from "./depth-frame-preparer";

/** How far a map's aspect ratio may stray from the media's. */
const DEPTH_ASPECT_TOLERANCE = 0.01;

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
   * frames only once this has been false for a moment.
   */
  setPlaybackActive?(active: boolean): void;
  /** Calls `listener` whenever an answer of `getEntry` may have changed. */
  subscribe?(listener: () => void): () => void;
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
  readonly exactFrames?: Partial<ExactDepthFrameOptions>;
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
    return openDepthClip(manifest, manifest.frames, base, context);
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

/**
 * A clip's exact depth, one 16-bit PNG per frame.
 *
 * While playback runs nothing is drawn: an exact frame takes a fetch and a
 * decode, and depth kept from another frame would sit over the wrong pixels.
 * Once playback has rested for `settleSeconds`, the frame on screen is
 * fetched, then its neighbours nearest first, so a step shows the next frame's
 * depth at once. A frame that lands for the frame on screen asks for one
 * redraw. Decoded frames are kept up to `maxCacheBytes`, dropping the ones
 * farthest from the frame on screen first.
 */
function openDepthClip(
  manifest: DepthManifest,
  frames: DepthClipFrames,
  base: string | URL | undefined,
  context: DepthSourceContext,
): DepthFrameProvider {
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

  const options = { ...defaultExactDepthFrameOptions, ...context.exactFrames };
  const listeners = new Set<() => void>();
  const cache = new Map<number, CachedDepthFrame>();
  const loading = new Map<number, Promise<void>>();
  const teardown = new AbortController();
  let cachedBytes = 0;
  let onScreen: number | null = null;
  let active = false;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let run: AbortController | undefined;
  let warned = false;
  let destroyed = false;

  const indexAt = (mediaTime: number): number | null => {
    if (!Number.isFinite(mediaTime)) return null;
    if (!frames.timesS) {
      return clock.indexAtOrBefore(
        mediaTime + PLAYHEAD_QUANTIZATION_TOLERANCE_SECONDS,
      );
    }

    return lastTimeAtOrBefore(
      frames.timesS,
      mediaTime -
        clock.firstTimestamp +
        PLAYHEAD_QUANTIZATION_TOLERANCE_SECONDS,
    );
  };

  const notify = () => {
    for (const listener of listeners) listener();
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
            `Depth frame ${index} did not load, so no depth is drawn over it: ${String(error)}`,
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
      }
      if (active || index === null) return null;

      return cache.get(index)?.entry ?? null;
    },

    setPlaybackActive(next) {
      if (next === active || destroyed) return;
      active = next;
      settle();
      // The frame on screen gains its cached depth, or loses it.
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
      run?.abort();
      teardown.abort();
      listeners.clear();
      cache.clear();
      cachedBytes = 0;
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
