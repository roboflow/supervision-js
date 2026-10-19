import {
  parseDepthManifest,
  resolveDepthFrameFile,
  validateDepthMap,
  type DepthClipFrames,
  type DepthManifest,
  type DepthMap,
} from "supervision-js-core";
import { resolveDisplayPixelRatio } from "#media/display-pixel-ratio";
import { rememberPreparedDepthUpload } from "#renderers/depth-textures";
import type { MediaRendererDepthInput } from "#types/media-depth";
import type { DepthSourceContext } from "./source";

/** How far a map's aspect ratio may stray from the media's. */
const DEPTH_ASPECT_TOLERANCE = 0.01;

/** The files of one depth map: the 16-bit depth PNG and its confidence. */
export interface DepthMapFiles {
  readonly file: string;
  readonly confidenceFile?: string;
}

type ManifestInput = Extract<MediaRendererDepthInput, { manifest: unknown }>;

/**
 * Fetches and parses a manifest URL, or checks one passed parsed. Relative
 * files resolve against the manifest's URL, or against `baseUrl` for a
 * manifest passed already parsed.
 */
export async function loadDepthManifest(
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

export function clipFrameFiles(
  frames: DepthClipFrames,
  index: number,
): DepthMapFiles {
  return {
    confidenceFile:
      frames.confidence === undefined
        ? undefined
        : resolveDepthFrameFile(frames.confidence, index),
    file: resolveDepthFrameFile(frames.exact, index),
  };
}

/** Bytes a decoded exact map holds, its confidence plane included. */
export function exactMapBytes(map: DepthMap): number {
  return map.samples.values.byteLength + (map.confidence?.byteLength ?? 0);
}

/**
 * Fetches and decodes one depth PNG, and its confidence plane, into a map.
 * The decode runs in the render-preparation worker when there is one.
 */
export async function loadDepthMap(
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
export function assertMediaAspect(
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
