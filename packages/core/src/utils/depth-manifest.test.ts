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

function withField(
  base: Record<string, unknown>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  const keys = path.split(".");
  let target = copy as Record<string, unknown>;

  for (const key of keys.slice(0, -1)) {
    target = target[key] as Record<string, unknown>;
  }
  if (value === undefined) {
    delete target[keys[keys.length - 1]];
  } else {
    target[keys[keys.length - 1]] = value;
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
  });

  it("reads a clip manifest with its frames and preview track", () => {
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
  });

  it("reads a TV-range preview, and a preview without levels as full range", () => {
    const tv = parseDepthManifest(
      withField(
        withField(clipManifest, "preview.levels", "tv"),
        "preview.reserved_max",
        31,
      ),
    );

    expect(tv.preview).toMatchObject({ levels: "tv", reservedMax: 31 });
    expect(
      parseDepthManifest(withField(clipManifest, "preview.levels", "full"))
        .preview?.levels,
    ).toBe("full");
  });

  it("keeps per-frame times when depth covers a sampled subset", () => {
    const manifest = parseDepthManifest(
      withField(
        withField(clipManifest, "frames.count", 3),
        "frames.times_s",
        [0, 0.5, 1.25],
      ),
    );

    expect(manifest.frames?.timesS).toEqual([0, 0.5, 1.25]);
  });

  it("accepts display_range in the kind's unit and display_range_px as its disparity name", () => {
    const metric = parseDepthManifest({
      ...withField(imageManifest, "display_range_px", undefined),
      kind: "depth_m",
      display_range: [0.4, 12],
    });
    const both = parseDepthManifest({
      ...imageManifest,
      display_range: [4.2, 118.7],
    });

    expect(metric.displayRange).toEqual({ max: 12, min: 0.4 });
    expect(both.displayRange).toEqual({ max: 118.7, min: 4.2 });
  });

  it.each([
    [
      "schema",
      "other",
      'depth.json: schema must be "supervision.depth-manifest"',
    ],
    ["version", 2, "depth.json: version 2 is not supported"],
    ["kind", "depth_mm", "depth.json: kind must be one of"],
    ["width", 0, "depth.json: width must be a positive integer"],
    ["height", 7.5, "depth.json: height must be a positive integer"],
    ["storage.format", "exr", 'depth.json: storage.format must be "png16"'],
    ["storage.scale", 0, "depth.json: storage.scale must be a positive number"],
    [
      "storage.scale",
      Number.NaN,
      "depth.json: storage.scale must be a positive number",
    ],
    ["storage.no_depth", 65535, "depth.json: storage.no_depth must be 0"],
    ["camera.fx_px", -1, "depth.json: camera.fx_px must be a positive number"],
    [
      "camera.baseline_m",
      0,
      "depth.json: camera.baseline_m must be a positive number",
    ],
    [
      "camera.doffs_px",
      "0",
      "depth.json: camera.doffs_px must be a finite number",
    ],
    [
      "display_range_px",
      [10, 10],
      "depth.json: display_range_px must have low < high",
    ],
    [
      "display_range_px",
      [1],
      "depth.json: display_range_px must be two finite numbers",
    ],
    ["image.file", "", "depth.json: image.file must be a non-empty file name"],
  ])(
    "rejects %s = %j with a RangeError that names it",
    (path, value, message) => {
      const parse = () =>
        parseDepthManifest(withField(imageManifest, path, value));

      expect(parse).toThrow(RangeError);
      expect(parse).toThrow(message);
    },
  );

  it.each([
    ["frames.count", 0, "depth.json: frames.count must be a positive integer"],
    [
      "frames.exact",
      "exact/frame.png",
      "depth.json: frames.exact must contain {index}",
    ],
    [
      "frames.confidence",
      "c.png",
      "depth.json: frames.confidence must contain {index}",
    ],
    [
      "frames.times_s",
      [0, 1],
      "depth.json: frames.times_s must be an array of frames.count (300) times",
    ],
    [
      "preview.reserved_max",
      254,
      "depth.json: preview.reserved_max must be an integer from 0 to 253",
    ],
    [
      "preview.reserved_max",
      1.5,
      "depth.json: preview.reserved_max must be an integer from 0 to 253",
    ],
    [
      "preview.levels",
      "pc",
      "depth.json: preview.levels must be one of full, tv",
    ],
    [
      "preview.range_px",
      [192, 0],
      "depth.json: preview.range_px must have low < high",
    ],
    ["preview.range_px", undefined, "depth.json: preview.range_px is required"],
  ])("rejects clip field %s = %j", (path, value, message) => {
    const parse = () =>
      parseDepthManifest(withField(clipManifest, path, value));

    expect(parse).toThrow(RangeError);
    expect(parse).toThrow(message);
  });

  it.each([15, 234])(
    "rejects a TV-range preview reserving up to %i",
    (reservedMax) => {
      const parse = () =>
        parseDepthManifest(
          withField(
            withField(clipManifest, "preview.levels", "tv"),
            "preview.reserved_max",
            reservedMax,
          ),
        );

      expect(parse).toThrow(
        "depth.json: preview.reserved_max must be an integer from 16 to 233 at tv levels",
      );
    },
  );

  it("rejects frame times that do not strictly increase", () => {
    const manifest = withField(
      withField(clipManifest, "frames.count", 3),
      "frames.times_s",
      [0, 0.5, 0.5],
    );

    expect(() => parseDepthManifest(manifest)).toThrow(
      "depth.json: frames.times_s must strictly increase at index 2",
    );
  });

  it("requires exactly one of image or frames", () => {
    expect(() =>
      parseDepthManifest({ ...clipManifest, image: { file: "depth.png" } }),
    ).toThrow("depth.json: exactly one of image or frames must be present");
    expect(() =>
      parseDepthManifest(withField(imageManifest, "image", undefined)),
    ).toThrow("depth.json: exactly one of image or frames must be present");
  });

  it("keeps preview tracks to disparity clips", () => {
    expect(() =>
      parseDepthManifest({ ...imageManifest, preview: clipManifest.preview }),
    ).toThrow("depth.json: preview is only valid next to frames");
    expect(() =>
      parseDepthManifest({
        ...withField(clipManifest, "display_range_px", undefined),
        kind: "depth_m",
      }),
    ).toThrow("depth.json: preview is only supported for kind disparity_px");
  });

  it("keeps display_range_px to disparity and rejects two ranges that disagree", () => {
    expect(() =>
      parseDepthManifest({ ...imageManifest, kind: "depth_m" }),
    ).toThrow(
      "depth.json: display_range_px is only valid for kind disparity_px",
    );
    expect(() =>
      parseDepthManifest({ ...imageManifest, display_range: [1, 2] }),
    ).toThrow("depth.json: display_range and display_range_px disagree");
  });

  it("rejects input that is not an object", () => {
    expect(() => parseDepthManifest(null)).toThrow(
      "depth.json: the manifest must be an object",
    );
    expect(() => parseDepthManifest([])).toThrow(RangeError);
  });
});

describe("depth frame files", () => {
  it("expands plain and zero-padded frame indexes", () => {
    expect(resolveDepthFrameFile("exact/{index:06}.png", 42)).toBe(
      "exact/000042.png",
    );
    expect(resolveDepthFrameFile("f{index}-{index:03}.png", 7)).toBe(
      "f7-007.png",
    );
    expect(resolveDepthFrameFile("exact/{index:02}.png", 1234)).toBe(
      "exact/1234.png",
    );
  });

  it("rejects an index that is not a frame", () => {
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

  it("accepts a well-formed map", () => {
    expect(() => validateDepthMap(map)).not.toThrow();
    expect(() =>
      validateDepthMap({
        ...map,
        camera: { baselineM: 0.1, fxPx: 500 },
        confidence: new Uint8Array(6),
        displayRange: { max: 10, min: 1 },
        samples: {
          encoding: "preview8",
          range: { max: 192, min: 0 },
          reservedMax: 15,
          values: new Uint8Array(6),
        },
      }),
    ).not.toThrow();
  });

  it.each([
    [{ width: 0 }, "width and height must be positive integers"],
    [
      {
        samples: {
          encoding: "scaled16",
          scale: 256,
          values: new Uint16Array(5),
        },
      },
      "samples.values has 5 values for 3x2 pixels",
    ],
    [
      {
        samples: {
          encoding: "scaled16",
          scale: 256,
          values: new Uint8Array(6),
        },
      },
      "samples.values must be a Uint16Array",
    ],
    [
      {
        samples: { encoding: "scaled16", scale: 0, values: new Uint16Array(6) },
      },
      "samples.scale must be a positive number",
    ],
    [
      {
        samples: {
          encoding: "preview8",
          range: { max: 1, min: 1 },
          reservedMax: 15,
          values: new Uint8Array(6),
        },
      },
      "samples.range must have finite bounds with min < max",
    ],
    [
      {
        samples: {
          encoding: "preview8",
          levels: "tv",
          range: { max: 192, min: 0 },
          reservedMax: 15,
          values: new Uint8Array(6),
        },
      },
      "samples.reservedMax must be an integer from 16 to 233 at tv levels",
    ],
    [
      {
        samples: {
          encoding: "preview8",
          levels: "studio",
          range: { max: 192, min: 0 },
          reservedMax: 31,
          values: new Uint8Array(6),
        },
      },
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
    [{ kind: "disparity" }, "kind must be one of"],
  ])("rejects %j", (override, message) => {
    const invalid = { ...map, ...override } as DepthMap;

    expect(() => validateDepthMap(invalid)).toThrow(RangeError);
    expect(() => validateDepthMap(invalid)).toThrow(message);
  });
});
