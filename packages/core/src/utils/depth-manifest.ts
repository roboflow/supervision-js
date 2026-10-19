import {
  DepthMapKind,
  DepthPreviewLevels,
  type DepthCamera,
  type DepthClipFrames,
  type DepthImageEntry,
  type DepthManifest,
  type DepthMap,
  type DepthPreviewTrack,
  type DepthRange,
} from "#types/depth-map";

export const DEPTH_MANIFEST_SCHEMA = "supervision.depth-manifest";

const PREVIEW_TOP_CODES: Readonly<Record<DepthPreviewLevels, number>> = {
  full: 255,
  tv: 235,
};
/**
 * TV black, 16, is written for no depth, and a decoder that converts to RGB
 * returns every code below it as black too, so the reserved band must cover it.
 */
const PREVIEW_MIN_RESERVED_CODES: Readonly<Record<DepthPreviewLevels, number>> =
  { full: 0, tv: 16 };
const depthPreviewLevels: ReadonlySet<string> = new Set(
  Object.values(DepthPreviewLevels),
);

const depthMapKinds: ReadonlySet<string> = new Set(Object.values(DepthMapKind));
const FRAME_INDEX_TOKEN = /\{index(?::0(\d{1,2}))?\}/g;

type WireObject = Readonly<Record<string, unknown>>;

/**
 * Reads the snake_case `depth.json` a producer writes into a
 * {@link DepthManifest}, and rejects anything a renderer could not honour.
 *
 * Messages name the offending wire field, such as
 * `depth.json: storage.scale must be a positive number`. Unknown fields are
 * ignored so newer producers stay readable.
 */
export function parseDepthManifest(json: unknown): DepthManifest {
  const root = readObject(json, "the manifest");

  if (root.schema !== DEPTH_MANIFEST_SCHEMA) {
    fail(`schema must be "${DEPTH_MANIFEST_SCHEMA}"`);
  }
  if (root.version !== 1) {
    fail(`version ${String(root.version)} is not supported; expected 1`);
  }

  const kind = root.kind;
  if (typeof kind !== "string" || !depthMapKinds.has(kind)) {
    fail(`kind must be one of ${[...depthMapKinds].join(", ")}`);
  }
  const depthKind = kind as DepthMapKind;
  const width = readPositiveInteger(root.width, "width");
  const height = readPositiveInteger(root.height, "height");
  const view = readOptionalString(root.view, "view");

  const storage = readObject(root.storage, "storage");
  if (storage.format !== "png16") {
    fail('storage.format must be "png16"');
  }
  const scale = readPositiveNumber(storage.scale, "storage.scale");
  if (storage.no_depth !== 0) {
    fail("storage.no_depth must be 0");
  }

  const camera =
    root.camera === undefined || root.camera === null
      ? undefined
      : readCamera(root.camera);
  const displayRange = readDisplayRange(root, depthKind);

  const hasImage = root.image !== undefined && root.image !== null;
  const hasFrames = root.frames !== undefined && root.frames !== null;
  if (hasImage === hasFrames) {
    fail("exactly one of image or frames must be present");
  }
  const image = hasImage ? readImage(root.image) : undefined;
  const frames = hasFrames ? readFrames(root.frames) : undefined;

  let preview: DepthPreviewTrack | undefined;
  if (root.preview !== undefined && root.preview !== null) {
    if (!frames) {
      fail("preview is only valid next to frames");
    }
    if (depthKind !== DepthMapKind.DisparityPx) {
      fail(`preview is only supported for kind ${DepthMapKind.DisparityPx}`);
    }
    preview = readPreview(root.preview);
  }

  return {
    schema: DEPTH_MANIFEST_SCHEMA,
    version: 1,
    kind: depthKind,
    ...(view === undefined ? {} : { view }),
    width,
    height,
    storage: { format: "png16", noDepth: 0, scale },
    ...(camera === undefined ? {} : { camera }),
    ...(displayRange === undefined ? {} : { displayRange }),
    ...(image === undefined ? {} : { image }),
    ...(frames === undefined ? {} : { frames }),
    ...(preview === undefined ? {} : { preview }),
  };
}

/**
 * Expands a clip frame pattern for one frame index: `{index}` becomes the
 * plain number and `{index:06}` the number zero-padded to six digits.
 */
export function resolveDepthFrameFile(pattern: string, index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError(
      `Depth frame index must be a non-negative integer, got ${index}.`,
    );
  }

  return pattern.replace(FRAME_INDEX_TOKEN, (_token, width?: string) =>
    width === undefined
      ? String(index)
      : String(index).padStart(Number(width), "0"),
  );
}

/**
 * Checks a host-supplied depth map's shape, without reading its sample values.
 */
export function validateDepthMap(map: DepthMap): void {
  const reject = (message: string): never => {
    throw new RangeError(`DepthMap ${message}.`);
  };

  if (!depthMapKinds.has(map.kind)) {
    reject(`kind must be one of ${[...depthMapKinds].join(", ")}`);
  }
  if (!isPositiveInteger(map.width) || !isPositiveInteger(map.height)) {
    reject("width and height must be positive integers");
  }
  const pixelCount = map.width * map.height;
  const samples = map.samples;

  if (samples?.encoding === "scaled16") {
    if (!(samples.values instanceof Uint16Array)) {
      reject("samples.values must be a Uint16Array for scaled16 samples");
    }
    if (!isPositiveNumber(samples.scale)) {
      reject("samples.scale must be a positive number");
    }
  } else if (samples?.encoding === "preview8") {
    if (!(samples.values instanceof Uint8Array)) {
      reject("samples.values must be a Uint8Array for preview8 samples");
    }
    const levels = samples.levels ?? DepthPreviewLevels.Full;

    if (!depthPreviewLevels.has(levels)) {
      reject(
        `samples.levels must be one of ${[...depthPreviewLevels].join(", ")}`,
      );
    }
    if (!isReservedPreviewCode(samples.reservedMax, levels)) {
      reject(`samples.reservedMax must be ${describeReservedCodes(levels)}`);
    }
    if (!isRange(samples.range)) {
      reject("samples.range must have finite bounds with min < max");
    }
  } else {
    reject('samples.encoding must be "scaled16" or "preview8"');
  }
  if (samples.values.length !== pixelCount) {
    reject(
      `samples.values has ${samples.values.length} values for ${map.width}x${map.height} pixels`,
    );
  }
  if (map.camera !== undefined && !isCamera(map.camera)) {
    reject(
      "camera needs finite fxPx and baselineM above 0, and finite optional offsets",
    );
  }
  if (map.displayRange !== undefined && !isRange(map.displayRange)) {
    reject("displayRange must have finite bounds with min < max");
  }
  if (map.confidence !== undefined) {
    if (!(map.confidence instanceof Uint8Array)) {
      reject("confidence must be a Uint8Array");
    }
    if (map.confidence.length !== pixelCount) {
      reject(
        `confidence has ${map.confidence.length} values for ${map.width}x${map.height} pixels`,
      );
    }
  }
}

function readCamera(value: unknown): DepthCamera {
  const camera = readObject(value, "camera");
  const fxPx = readPositiveNumber(camera.fx_px, "camera.fx_px");
  const baselineM = readPositiveNumber(camera.baseline_m, "camera.baseline_m");
  const doffsPx = readOptionalFinite(camera.doffs_px, "camera.doffs_px");
  const cxPx = readOptionalFinite(camera.cx_px, "camera.cx_px");
  const cyPx = readOptionalFinite(camera.cy_px, "camera.cy_px");

  return {
    fxPx,
    baselineM,
    ...(doffsPx === undefined ? {} : { doffsPx }),
    ...(cxPx === undefined ? {} : { cxPx }),
    ...(cyPx === undefined ? {} : { cyPx }),
  };
}

/**
 * `display_range` is in the kind's unit; `display_range_px` is its name for
 * disparity, kept because disparity producers already write it.
 */
function readDisplayRange(
  root: WireObject,
  kind: DepthMapKind,
): DepthRange | undefined {
  const inKindUnit = readOptionalRange(root.display_range, "display_range");
  const inPixels = readOptionalRange(root.display_range_px, "display_range_px");

  if (inPixels !== undefined && kind !== DepthMapKind.DisparityPx) {
    fail(
      `display_range_px is only valid for kind ${DepthMapKind.DisparityPx}; use display_range`,
    );
  }
  if (
    inKindUnit !== undefined &&
    inPixels !== undefined &&
    (inKindUnit.min !== inPixels.min || inKindUnit.max !== inPixels.max)
  ) {
    fail("display_range and display_range_px disagree");
  }

  return inKindUnit ?? inPixels;
}

function readImage(value: unknown): DepthImageEntry {
  const image = readObject(value, "image");
  const file = readFileName(image.file, "image.file");
  const confidenceFile = readOptionalFileName(
    image.confidence_file,
    "image.confidence_file",
  );

  return {
    file,
    ...(confidenceFile === undefined ? {} : { confidenceFile }),
  };
}

function readFrames(value: unknown): DepthClipFrames {
  const frames = readObject(value, "frames");
  const count = readPositiveInteger(frames.count, "frames.count");
  const exact = readFramePattern(frames.exact, "frames.exact");
  const confidence =
    frames.confidence === undefined || frames.confidence === null
      ? undefined
      : readFramePattern(frames.confidence, "frames.confidence");
  const timesS =
    frames.times_s === undefined || frames.times_s === null
      ? undefined
      : readFrameTimes(frames.times_s, count);

  return {
    count,
    exact,
    ...(confidence === undefined ? {} : { confidence }),
    ...(timesS === undefined ? {} : { timesS }),
  };
}

function readFrameTimes(value: unknown, count: number): readonly number[] {
  if (!Array.isArray(value) || value.length !== count) {
    fail(`frames.times_s must be an array of frames.count (${count}) times`);
  }
  const times = value as readonly unknown[];

  times.forEach((time, index) => {
    if (typeof time !== "number" || !Number.isFinite(time) || time < 0) {
      fail(`frames.times_s[${index}] must be a finite number of seconds >= 0`);
    }
    if (index > 0 && time <= (times[index - 1] as number)) {
      fail(`frames.times_s must strictly increase at index ${index}`);
    }
  });

  return [...(times as readonly number[])];
}

/** A preview without `levels` predates TV range and is read as full range. */
function readPreview(value: unknown): DepthPreviewTrack {
  const preview = readObject(value, "preview");
  const file = readFileName(preview.file, "preview.file");
  const codec = readOptionalString(preview.codec, "preview.codec");
  const levels = preview.levels ?? DepthPreviewLevels.Full;
  const reservedMax = preview.reserved_max;

  if (typeof levels !== "string" || !depthPreviewLevels.has(levels)) {
    fail(`preview.levels must be one of ${[...depthPreviewLevels].join(", ")}`);
  }
  const previewLevels = levels as DepthPreviewLevels;

  if (!isReservedPreviewCode(reservedMax, previewLevels)) {
    fail(
      `preview.reserved_max must be ${describeReservedCodes(previewLevels)}`,
    );
  }
  const range = readOptionalRange(preview.range_px, "preview.range_px");

  if (range === undefined) {
    fail("preview.range_px is required");
  }

  return {
    file,
    ...(codec === undefined ? {} : { codec }),
    levels: previewLevels,
    reservedMax,
    range,
  };
}

/** The code that stands for the top of a preview's range: 255, or 235 in TV range. */
export function depthPreviewTopCode(levels: DepthPreviewLevels = "full") {
  return PREVIEW_TOP_CODES[levels];
}

function readFramePattern(value: unknown, path: string): string {
  const pattern = readFileName(value, path);

  if (!new RegExp(FRAME_INDEX_TOKEN.source).test(pattern)) {
    fail(`${path} must contain {index} or a padded {index:06}`);
  }

  return pattern;
}

function readOptionalRange(
  value: unknown,
  path: string,
): DepthRange | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !value.every((bound) => typeof bound === "number" && Number.isFinite(bound))
  ) {
    fail(`${path} must be two finite numbers [low, high]`);
  }
  const [min, max] = value as [number, number];

  if (!(min < max)) {
    fail(`${path} must have low < high`);
  }

  return { min, max };
}

function readObject(value: unknown, path: string): WireObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${path} must be an object`);
  }

  return value as WireObject;
}

function readPositiveInteger(value: unknown, path: string): number {
  if (!isPositiveInteger(value)) {
    fail(`${path} must be a positive integer`);
  }

  return value;
}

function readPositiveNumber(value: unknown, path: string): number {
  if (!isPositiveNumber(value)) {
    fail(`${path} must be a positive number`);
  }

  return value;
}

function readOptionalFinite(value: unknown, path: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${path} must be a finite number`);
  }

  return value;
}

function readOptionalString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    fail(`${path} must be a string`);
  }

  return value;
}

function readFileName(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${path} must be a non-empty file name`);
  }

  return value;
}

function readOptionalFileName(
  value: unknown,
  path: string,
): string | undefined {
  return value === undefined || value === null
    ? undefined
    : readFileName(value, path);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** At least two valid codes must remain, or the preview span is zero. */
function isReservedPreviewCode(
  value: unknown,
  levels: DepthPreviewLevels,
): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= PREVIEW_MIN_RESERVED_CODES[levels] &&
    value <= PREVIEW_TOP_CODES[levels] - 2
  );
}

function describeReservedCodes(levels: DepthPreviewLevels) {
  return `an integer from ${PREVIEW_MIN_RESERVED_CODES[levels]} to ${PREVIEW_TOP_CODES[levels] - 2} at ${levels} levels`;
}

function isRange(range: DepthRange | undefined): boolean {
  return (
    range !== undefined &&
    Number.isFinite(range.min) &&
    Number.isFinite(range.max) &&
    range.min < range.max
  );
}

function isCamera(camera: DepthCamera): boolean {
  return (
    isPositiveNumber(camera.fxPx) &&
    isPositiveNumber(camera.baselineM) &&
    [camera.doffsPx, camera.cxPx, camera.cyPx].every(
      (value) => value === undefined || Number.isFinite(value),
    )
  );
}

function fail(message: string): never {
  throw new RangeError(`depth.json: ${message}`);
}
