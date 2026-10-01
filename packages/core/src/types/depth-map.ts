/**
 * What the stored values of a depth map measure.
 *
 * Every kind stores 0 where there is no depth, so "no measurement" never
 * reads as a distance.
 */
export const DepthMapKind = {
  /** Stereo disparity in pixels of the map. Larger is nearer. */
  DisparityPx: "disparity_px",
  /** Metric depth along the optical axis in metres. Smaller is nearer. */
  DepthM: "depth_m",
  /**
   * Unitless inverse depth up to an unknown scale and shift, as monocular
   * models produce it. Larger is nearer; it has no metric depth.
   */
  RelativeInverse: "relative_inverse",
} as const;

export type DepthMapKind = (typeof DepthMapKind)[keyof typeof DepthMapKind];

/**
 * The quantity a depth renderer colours.
 *
 * Disparity is inverse depth, so it spends colour on near detail the way
 * stereo measures it. Either way the nearest end of the range is the warm or
 * bright end of the colour table.
 */
export const DepthQuantity = {
  Disparity: "disparity",
  Depth: "depth",
} as const;

export type DepthQuantity = (typeof DepthQuantity)[keyof typeof DepthQuantity];

/** Colour tables a depth renderer can paint with. */
export const DepthColormap = {
  Turbo: "turbo",
  Viridis: "viridis",
  Cividis: "cividis",
  Inferno: "inferno",
  Magma: "magma",
  Grayscale: "grayscale",
} as const;

export type DepthColormap = (typeof DepthColormap)[keyof typeof DepthColormap];

/** How a depth map is sampled where one map pixel does not cover one media pixel. */
export const DepthSampling = {
  /** Nearest when the map is at least media size, edge-aware otherwise. */
  Auto: "auto",
  /** Each media pixel shows the map pixel under it. */
  Nearest: "nearest",
  /**
   * Bilinear over valid neighbours only, falling back to the nearest one
   * across a depth edge, so objects never bleed into the background.
   */
  EdgeAware: "edge-aware",
} as const;

export type DepthSampling = (typeof DepthSampling)[keyof typeof DepthSampling];

/**
 * The luma range a depth preview video's codes are written in.
 *
 * TV range is what browsers' hardware decoders return as written; a decoder
 * may squeeze full range into TV range or move codes converting it to RGB.
 */
export const DepthPreviewLevels = {
  /** Every code from 0 to 255; the top code is 255. */
  Full: "full",
  /** Limited range: black is 16 and the top code is 235. */
  Tv: "tv",
} as const;

export type DepthPreviewLevels =
  (typeof DepthPreviewLevels)[keyof typeof DepthPreviewLevels];

/** Pinhole camera parameters that relate disparity to metric depth. */
export interface DepthCamera {
  /** Focal length in pixels of the depth map. */
  readonly fxPx: number;
  /** Stereo baseline in metres. */
  readonly baselineM: number;
  /**
   * Difference between the two views' principal points in pixels, so that
   * depth is `fxPx * baselineM / (disparity + doffsPx)`. Defaults to 0.
   */
  readonly doffsPx?: number;
  readonly cxPx?: number;
  readonly cyPx?: number;
}

/** A closed value range in the unit of the quantity it belongs to. */
export interface DepthRange {
  readonly min: number;
  readonly max: number;
}

/**
 * Exact samples: each stored value divided by `scale` is the value in the
 * map kind's unit, and a stored 0 is no depth.
 */
export interface ScaledDepthSamples {
  readonly encoding: "scaled16";
  readonly values: Uint16Array;
  readonly scale: number;
}

/**
 * Approximate 8-bit samples, as a preview video carries them. Codes up to
 * `reservedMax` are no depth; code `reservedMax + 1` is `range.min` and the
 * top code of `levels` (255, or 235 in TV range) is `range.max`, in even
 * steps. Codes above the top code read as `range.max`.
 */
export interface PreviewDepthSamples {
  readonly encoding: "preview8";
  readonly values: Uint8Array;
  readonly reservedMax: number;
  readonly range: DepthRange;
  /** Defaults to full range. */
  readonly levels?: DepthPreviewLevels;
}

/**
 * One frame of depth, row-major from the top-left pixel.
 *
 * A map is stretched over the whole media rectangle, as masks are, so it may
 * be smaller than the media it describes as long as it keeps its aspect ratio.
 */
export interface DepthMap {
  readonly kind: DepthMapKind;
  /** Which camera of a stereo pair the map is registered to, such as `"left"`. */
  readonly view?: string;
  readonly width: number;
  readonly height: number;
  readonly samples: ScaledDepthSamples | PreviewDepthSamples;
  /** Needed to convert between disparity and metric depth. */
  readonly camera?: DepthCamera;
  /** The producer's suggested colour range, in the map kind's unit. */
  readonly displayRange?: DepthRange;
  /** Optional per-pixel confidence, 0 to 255, with the map's dimensions. */
  readonly confidence?: Uint8Array;
}

/** What a depth map holds under one point. */
export interface DepthReadout {
  /** Map pixel column. */
  readonly x: number;
  /** Map pixel row. */
  readonly y: number;
  /** The raw stored value or preview code. */
  readonly stored: number;
  /** False where the map has no depth. */
  readonly valid: boolean;
  /** `"preview"` when the value came from 8-bit preview codes. */
  readonly precision: "exact" | "preview";
  readonly disparityPx?: number;
  readonly depthM?: number;
  readonly relativeInverse?: number;
  /** One quantisation step in the map kind's unit. */
  readonly step?: number;
  /** Confidence from 0 to 1 when the map carries a confidence plane. */
  readonly confidence?: number;
}

/** A still depth image described by a manifest. */
export interface DepthImageEntry {
  readonly file: string;
  readonly confidenceFile?: string;
}

/** The per-frame exact depth files of a clip manifest. */
export interface DepthClipFrames {
  readonly count: number;
  /** File pattern with `{index}` or a zero-padded `{index:06}`. */
  readonly exact: string;
  /** Optional confidence file pattern, written like `exact`. */
  readonly confidence?: string;
  /**
   * Seconds on the media's zero-based timeline for each depth frame, when
   * depth covers only some of the video's frames.
   */
  readonly timesS?: readonly number[];
}

/** An 8-bit preview video of a clip's depth. */
export interface DepthPreviewTrack {
  readonly file: string;
  readonly codec?: string;
  /** The luma range the video's codes are written in. */
  readonly levels: DepthPreviewLevels;
  /** Codes up to this value are no depth. */
  readonly reservedMax: number;
  /** The disparity the lowest and highest valid codes stand for. */
  readonly range: DepthRange;
}

/**
 * A parsed depth manifest.
 *
 * Exactly one of `image` or `frames` is present. File names are relative to
 * the manifest.
 */
export interface DepthManifest {
  readonly schema: "supervision.depth-manifest";
  readonly version: 1;
  readonly kind: DepthMapKind;
  readonly view?: string;
  readonly width: number;
  readonly height: number;
  readonly storage: {
    readonly format: "png16";
    /** Stored value divided by this is the value in the kind's unit. */
    readonly scale: number;
    readonly noDepth: 0;
  };
  readonly camera?: DepthCamera;
  /** The producer's suggested colour range, in the kind's unit. */
  readonly displayRange?: DepthRange;
  readonly image?: DepthImageEntry;
  readonly frames?: DepthClipFrames;
  readonly preview?: DepthPreviewTrack;
}
