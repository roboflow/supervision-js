import { describe, expect, it } from "vitest";

import { DepthMapKind, type DepthMap } from "#types/depth-map";
import {
  parseDepthManifest,
  resolveDepthFrameFile,
  validateDepthMap,
} from "#utils/depth-manifest";

const imageManifest = {
  schema: "supervision.depth-manifest",
  version: 1,
  kind: "disparity_px",
  view: "left",
  width: 1280,
  height: 720,
  storage: { format: "png16", scale: 256, no_depth: 0 },
  camera: {
    fx_px: 1050.3,
    baseline_m: 0.12,
    doffs_px: 0,
    cx_px: 640.2,
    cy_px: 361.7,
  },
  display_range_px: [4.2, 118.7],
  image: { file: "depth.png", confidence_file: "confidence.png" },
};

const clipManifest = {
  schema: "supervision.depth-manifest",
  version: 1,
  kind: "disparity_px",
  view: "left",
  width: 1920,
  height: 1080,
  storage: { format: "png16", scale: 256, no_depth: 0 },
  camera: { fx_px: 1400, baseline_m: 0.12, doffs_px: 0 },
  display_range_px: [3.1, 160.4],
  frames: {
    count: 300,
    exact: "exact/{index:06}.png",
    confidence: "confidence/{index:06}.png",
    times_s: null,
  },
  preview: {
    file: "preview.mp4",
    codec: "avc1.640028",
    reserved_max: 15,
    range_px: [0, 192],
  },
};

/** A deep copy of `base` with each dotted path set, or deleted when undefined. */
function withFields(
  base: Record<string, unknown>,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;

  for (const [path, value] of Object.entries(fields)) {
    const keys = path.split(".");
    const last = keys.pop()!;
    let target = copy;

    for (const key of keys) target = target[key] as Record<string, unknown>;
    if (value === undefined) delete target[last];
    else target[last] = value;
  }

  return copy;
}

describe("depth manifests", () => {
  it("maps a still-image manifest from snake_case to camelCase", () => {
    expect(parseDepthManifest(imageManifest)).toEqual({
      schema: "supervision.depth-manifest",
      version: 1,
      kind: DepthMapKind.DisparityPx,
      view: "left",
      width: 1280,
      height: 720,
      storage: { format: "png16", noDepth: 0, scale: 256 },
      camera: {
        baselineM: 0.12,
        cxPx: 640.2,
        cyPx: 361.7,
        doffsPx: 0,
        fxPx: 1050.3,
      },
      displayRange: { max: 118.7, min: 4.2 },
      image: { confidenceFile: "confidence.png", file: "depth.png" },
    });
    // display_range is in the kind's unit; display_range_px is its disparity name.
    expect(
      parseDepthManifest(
        withFields(imageManifest, {
          display_range: [0.4, 12],
          display_range_px: undefined,
          kind: "depth_m",
        }),
      ).displayRange,
    ).toEqual({ max: 12, min: 0.4 });
    expect(
      parseDepthManifest(
        withFields(imageManifest, { display_range: [4.2, 118.7] }),
      ).displayRange,
    ).toEqual({ max: 118.7, min: 4.2 });
  });

  it("reads a clip manifest with its frames, frame times and preview track", () => {
    const manifest = parseDepthManifest(clipManifest);

    expect(manifest.frames).toEqual({
      confidence: "confidence/{index:06}.png",
      count: 300,
      exact: "exact/{index:06}.png",
    });
    expect(manifest.preview).toEqual({
      codec: "avc1.640028",
      file: "preview.mp4",
      levels: "full",
      range: { max: 192, min: 0 },
      reservedMax: 15,
    });
    expect(manifest.image).toBeUndefined();

    const sampled = parseDepthManifest(
      withFields(clipManifest, {
        "frames.count": 3,
        "frames.times_s": [0, 0.5, 1.25],
        "preview.levels": "tv",
        "preview.reserved_max": 31,
      }),
    );

    expect(sampled.frames?.timesS).toEqual([0, 0.5, 1.25]);
    expect(sampled.preview).toMatchObject({ levels: "tv", reservedMax: 31 });
  });

  const image = (fields: Record<string, unknown>) =>
    withFields(imageManifest, fields);
  const clip = (fields: Record<string, unknown>) =>
    withFields(clipManifest, fields);

  it.each<[string, unknown, string]>([
    ["not an object", null, "the manifest must be an object"],
    [
      "schema",
      image({ schema: "other" }),
      'schema must be "supervision.depth-manifest"',
    ],
    ["version", image({ version: 2 }), "version 2 is not supported"],
    ["kind", image({ kind: "depth_mm" }), "kind must be one of"],
    ["height", image({ height: 7.5 }), "height must be a positive integer"],
    [
      "storage.format",
      image({ "storage.format": "exr" }),
      'storage.format must be "png16"',
    ],
    [
      "storage.scale",
      image({ "storage.scale": Number.NaN }),
      "storage.scale must be a positive number",
    ],
    [
      "storage.no_depth",
      image({ "storage.no_depth": 65535 }),
      "storage.no_depth must be 0",
    ],
    [
      "camera.baseline_m",
      image({ "camera.baseline_m": 0 }),
      "camera.baseline_m must be a positive number",
    ],
    [
      "camera.doffs_px",
      image({ "camera.doffs_px": "0" }),
      "camera.doffs_px must be a finite number",
    ],
    [
      "empty range",
      image({ display_range_px: [10, 10] }),
      "display_range_px must have low < high",
    ],
    [
      "short range",
      image({ display_range_px: [1] }),
      "display_range_px must be two finite numbers",
    ],
    [
      "pixel range on metric depth",
      image({ kind: "depth_m" }),
      "display_range_px is only valid for kind disparity_px",
    ],
    [
      "ranges that disagree",
      image({ display_range: [1, 2] }),
      "display_range and display_range_px disagree",
    ],
    [
      "image.file",
      image({ "image.file": "" }),
      "image.file must be a non-empty file name",
    ],
    [
      "neither image nor frames",
      image({ image: undefined }),
      "exactly one of image or frames must be present",
    ],
    [
      "both image and frames",
      clip({ image: { file: "depth.png" } }),
      "exactly one of image or frames must be present",
    ],
    [
      "preview on an image",
      image({ preview: clipManifest.preview }),
      "preview is only valid next to frames",
    ],
    [
      "preview on metric depth",
      clip({ display_range_px: undefined, kind: "depth_m" }),
      "preview is only supported for kind disparity_px",
    ],
    [
      "frames.exact",
      clip({ "frames.exact": "exact/frame.png" }),
      "frames.exact must contain {index}",
    ],
    [
      "frames.times_s length",
      clip({ "frames.times_s": [0, 1] }),
      "frames.times_s must be an array of frames.count (300) times",
    ],
    [
      "frames.times_s order",
      clip({ "frames.count": 3, "frames.times_s": [0, 0.5, 0.5] }),
      "frames.times_s must strictly increase at index 2",
    ],
    [
      "preview.reserved_max",
      clip({ "preview.reserved_max": 254 }),
      "preview.reserved_max must be an integer from 0 to 253",
    ],
    [
      "tv reserved_max under black",
      clip({ "preview.levels": "tv", "preview.reserved_max": 15 }),
      "preview.reserved_max must be an integer from 16 to 233 at tv levels",
    ],
    [
      "tv reserved_max over white",
      clip({ "preview.levels": "tv", "preview.reserved_max": 234 }),
      "preview.reserved_max must be an integer from 16 to 233 at tv levels",
    ],
    [
      "preview.levels",
      clip({ "preview.levels": "pc" }),
      "preview.levels must be one of full, tv",
    ],
    [
      "preview.range_px",
      clip({ "preview.range_px": undefined }),
      "preview.range_px is required",
    ],
  ])("rejects %s with a RangeError that names it", (_case, json, message) => {
    const parse = () => parseDepthManifest(json);

    expect(parse).toThrow(RangeError);
    expect(parse).toThrow(`depth.json: ${message}`);
  });
});

describe("depth frame files", () => {
  it("expands plain and zero-padded frame indexes, and only frame indexes", () => {
    expect(resolveDepthFrameFile("exact/{index:06}.png", 42)).toBe(
      "exact/000042.png",
    );
    expect(resolveDepthFrameFile("f{index}-{index:03}.png", 7)).toBe(
      "f7-007.png",
    );
    expect(resolveDepthFrameFile("exact/{index:02}.png", 1234)).toBe(
      "exact/1234.png",
    );
    expect(() => resolveDepthFrameFile("{index}.png", -1)).toThrow(RangeError);
    expect(() => resolveDepthFrameFile("{index}.png", 1.5)).toThrow(RangeError);
  });
});

describe("in-memory depth maps", () => {
  const map: DepthMap = {
    height: 2,
    kind: DepthMapKind.DisparityPx,
    samples: { encoding: "scaled16", scale: 256, values: new Uint16Array(6) },
    width: 3,
  };
  const preview = {
    encoding: "preview8",
    range: { max: 192, min: 0 },
    reservedMax: 15,
    values: new Uint8Array(6),
  } as const;

  it("accepts a well-formed map", () => {
    expect(() => validateDepthMap(map)).not.toThrow();
    expect(() =>
      validateDepthMap({
        ...map,
        camera: { baselineM: 0.1, fxPx: 500 },
        confidence: new Uint8Array(6),
        displayRange: { max: 10, min: 1 },
        samples: preview,
      }),
    ).not.toThrow();
  });

  it.each([
    [{ kind: "disparity" }, "kind must be one of"],
    [{ width: 0 }, "width and height must be positive integers"],
    [
      { samples: { ...map.samples, values: new Uint16Array(5) } },
      "samples.values has 5 values for 3x2 pixels",
    ],
    [
      { samples: { ...map.samples, values: new Uint8Array(6) } },
      "samples.values must be a Uint16Array",
    ],
    [
      { samples: { ...map.samples, scale: 0 } },
      "samples.scale must be a positive number",
    ],
    [
      { samples: { ...preview, range: { max: 1, min: 1 } } },
      "samples.range must have finite bounds with min < max",
    ],
    [
      { samples: { ...preview, levels: "tv" } },
      "samples.reservedMax must be an integer from 16 to 233 at tv levels",
    ],
    [
      { samples: { ...preview, levels: "studio", reservedMax: 31 } },
      "samples.levels must be one of full, tv",
    ],
    [
      { confidence: new Uint8Array(2) },
      "confidence has 2 values for 3x2 pixels",
    ],
    [{ camera: { baselineM: 0, fxPx: 500 } }, "camera needs finite fxPx"],
    [
      { displayRange: { max: 1, min: 2 } },
      "displayRange must have finite bounds",
    ],
  ])("rejects %j", (override, message) => {
    const validate = () =>
      validateDepthMap({ ...map, ...override } as DepthMap);

    expect(validate).toThrow(RangeError);
    expect(validate).toThrow(message);
  });
});
