import {
  parseDepthManifest,
  validateDepthMap,
  type DepthManifest,
  type DepthMap,
} from "supervision-js-core";
import { rememberPreparedDepthUpload } from "#renderers/depth-textures";
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
  getEntry(mediaTime: number): DepthFrameEntry | null;
  destroy(): void;
}

export interface DepthSourceContext {
  /** The media the map is stretched over. */
  readonly media: { readonly width: number; readonly height: number };
  /** The decoder, created only when a manifest needs one. */
  readonly preparer?: () => DepthFramePreparer;
  readonly fetch?: typeof globalThis.fetch;
  /** Pad odd-width rows for WebGL while decoding, off the main thread. */
  readonly padRowsForWebGl?: boolean;
  readonly signal?: AbortSignal;
}

type ManifestInput = Extract<MediaRendererDepthInput, { manifest: unknown }>;

/**
 * Checks a depth input against the media it will be drawn over and opens it.
 * A still map, given or loaded from an image manifest, answers every media
 * time with itself.
 */
export async function openDepthSource(
  input: MediaRendererDepthInput,
  context: DepthSourceContext,
): Promise<DepthFrameProvider> {
  validateDepthInput(input);

  const map = isMapInput(input)
    ? input.map
    : await loadDepthImage(input, context);

  assertMediaAspect(map, context.media);

  const entry: DepthFrameEntry = { frameIndex: null, map, precision: "exact" };

  return {
    destroy: () => undefined,
    getEntry: () => entry,
  };
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

/**
 * Fetches and decodes the still image a manifest names, and its confidence
 * plane, into one map. Relative files resolve against the manifest's URL, or
 * against `baseUrl` for a manifest passed already parsed.
 */
async function loadDepthImage(
  input: ManifestInput,
  context: DepthSourceContext,
): Promise<DepthMap> {
  const fetchFile = context.fetch ?? globalThis.fetch.bind(globalThis);
  const { signal } = context;
  let manifest: DepthManifest;
  let base = input.baseUrl;

  if (typeof input.manifest === "string" || input.manifest instanceof URL) {
    const url = resolveUrl(String(input.manifest), base);
    const response = await fetchFile(url, { signal });

    if (!response.ok) {
      throw new Error(
        `Unable to load depth manifest ${url}: ${response.status} ${response.statusText}`.trim(),
      );
    }
    manifest = parseDepthManifest(await response.json());
    base = url;
  } else {
    manifest = checkParsedManifest(input.manifest);
  }

  if (manifest.frames || !manifest.image) {
    throw new RangeError(
      "depth.json describes a clip; the session draws still depth images only for now.",
    );
  }

  const preparer = context.preparer?.();

  if (!preparer) throw new Error("Depth decoding is unavailable.");

  const { image } = manifest;
  const [depth, confidence] = await Promise.all([
    fetchBytes(fetchFile, resolveUrl(image.file, base), signal).then((bytes) =>
      preparer.decodeDepth(bytes, {
        padRowsForWebGl: context.padRowsForWebGl,
        signal,
      }),
    ),
    image.confidenceFile === undefined
      ? undefined
      : fetchBytes(
          fetchFile,
          resolveUrl(image.confidenceFile, base),
          signal,
        ).then((bytes) => preparer.decodeConfidence(bytes, { signal })),
  ]);

  assertImageSize(image.file, depth, manifest);
  if (confidence && image.confidenceFile !== undefined) {
    assertImageSize(image.confidenceFile, confidence, manifest);
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

/**
 * A manifest passed as an object is trusted to be `parseDepthManifest`'s
 * output; only what loading an image depends on is checked again.
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
  map: DepthMap,
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
