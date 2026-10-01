import {
  annotationRenderers,
  computeDepthPercentileRange,
  type ActiveDepthMap,
  type DepthAnnotationRenderer,
  type DepthColormap,
  type DepthMap,
  type DepthQuantity,
  type DepthRange,
  type DepthReadout,
  type DepthSampling,
} from "supervision";

export const DepthRangeMode = {
  Clip: "clip",
  Auto: "auto",
  Manual: "manual",
} as const;

export type DepthRangeMode =
  (typeof DepthRangeMode)[keyof typeof DepthRangeMode];

/** Every depth renderer option the demo offers, in descriptor units. */
export interface DepthSettings {
  readonly colormap: DepthColormap;
  readonly quantity: DepthQuantity;
  readonly rangeMode: DepthRangeMode;
  /** In the quantity's unit: pixels of disparity or metres of depth. */
  readonly manualRange: DepthRange;
  readonly opacity: number;
  readonly sampling: DepthSampling;
  readonly wipe: number;
  readonly noDepthColor: number | null;
}

export const depthColormapOptions: readonly {
  readonly label: string;
  readonly value: DepthColormap;
}[] = [
  { label: "Turbo", value: "turbo" },
  { label: "Viridis", value: "viridis" },
  { label: "Cividis", value: "cividis" },
  { label: "Inferno", value: "inferno" },
  { label: "Magma", value: "magma" },
  { label: "Grayscale", value: "grayscale" },
];

export const depthSamplingOptions: readonly {
  readonly label: string;
  readonly value: DepthSampling;
}[] = [
  { label: "Auto", value: "auto" },
  { label: "Nearest", value: "nearest" },
  { label: "Edge-aware", value: "edge-aware" },
];

/** The colour pixels without depth take when painting them is first turned on. */
export const DEFAULT_NO_DEPTH_COLOR = 0x202020;

export const initialDepthSettings: DepthSettings = {
  colormap: "turbo",
  manualRange: { max: 150, min: 3 },
  noDepthColor: null,
  opacity: 1,
  quantity: "disparity",
  rangeMode: DepthRangeMode.Clip,
  sampling: "auto",
  wipe: 1,
};

export function createDepthRenderer(
  settings: DepthSettings,
): DepthAnnotationRenderer {
  return annotationRenderers.depth({
    colormap: settings.colormap,
    noDepthColor: settings.noDepthColor,
    opacity: settings.opacity,
    quantity: settings.quantity,
    range:
      settings.rangeMode === DepthRangeMode.Manual
        ? { max: settings.manualRange.max, min: settings.manualRange.min }
        : settings.rangeMode,
    sampling: settings.sampling,
    wipe: settings.wipe,
  });
}

/** The `setPresentation` call that builds exactly `createDepthRenderer`. */
export function createDepthSnippet(settings: DepthSettings): string {
  const range =
    settings.rangeMode === DepthRangeMode.Manual
      ? `{ min: ${settings.manualRange.min}, max: ${settings.manualRange.max} }`
      : `"${settings.rangeMode}"`;
  const noDepthColor =
    settings.noDepthColor === null
      ? "null"
      : `0x${settings.noDepthColor.toString(16).padStart(6, "0")}`;

  return `session.setPresentation({
  renderers: [
    annotationRenderers.depth({
      colormap: "${settings.colormap}",
      quantity: "${settings.quantity}",
      range: ${range},
      opacity: ${settings.opacity},
      sampling: "${settings.sampling}",
      wipe: ${settings.wipe},
      noDepthColor: ${noDepthColor},
    }),
  ],
});`;
}

/**
 * A manual range fixed to the 2nd and 98th percentile of a map, in the
 * quantity given, or null when there is no map or too little depth in it.
 */
export function lockDepthRange(
  map: DepthMap | null | undefined,
  quantity: DepthQuantity,
): DepthRange | null {
  const range = map ? computeDepthPercentileRange(map, { quantity }) : null;

  return range
    ? { max: roundRange(range.max), min: roundRange(range.min) }
    : null;
}

/**
 * A manual range in pixels means nothing in metres, so it is locked again in
 * the new unit, or falls back to the clip's range when there is no depth on
 * screen to lock it to.
 */
export function changeDepthQuantity(
  settings: DepthSettings,
  quantity: DepthQuantity,
  lockRange: (quantity: DepthQuantity) => DepthRange | null,
): Partial<DepthSettings> {
  if (settings.rangeMode !== DepthRangeMode.Manual) return { quantity };

  const manualRange = lockRange(quantity);

  return manualRange
    ? { manualRange, quantity }
    : { quantity, rangeMode: DepthRangeMode.Clip };
}

/**
 * Manual starts from the depth on screen when there is some, and from the
 * last manual range when there is not.
 */
export function changeDepthRangeMode(
  settings: DepthSettings,
  rangeMode: DepthRangeMode,
  lockRange: (quantity: DepthQuantity) => DepthRange | null,
): Partial<DepthSettings> {
  const manualRange =
    rangeMode === DepthRangeMode.Manual ? lockRange(settings.quantity) : null;

  return manualRange ? { manualRange, rangeMode } : { rangeMode };
}

/** What the colours span, or why that is not known yet. */
export type DepthColourRange =
  | {
      readonly near: number;
      readonly far: number;
      readonly unit: "px" | "m";
    }
  | { readonly message: string };

/**
 * The values at the near (warm) and far ends of the colours. `"clip"` reads
 * the map's display range, converted to metres through its camera when the
 * quantity is depth.
 */
export function resolveDepthColourRange(
  map: DepthMap | null,
  settings: DepthSettings,
): DepthColourRange {
  const unit = settings.quantity === "depth" ? "m" : "px";
  let range: DepthRange | null;

  if (settings.rangeMode === DepthRangeMode.Manual) {
    range = settings.manualRange;
  } else if (!map) {
    return { message: "Shown once depth is on screen" };
  } else if (settings.rangeMode === DepthRangeMode.Auto || !map.displayRange) {
    range = computeDepthPercentileRange(map, { quantity: settings.quantity });
  } else if (settings.quantity === "depth" && map.camera) {
    const focalBaseline = map.camera.fxPx * map.camera.baselineM;
    const doffs = map.camera.doffsPx ?? 0;

    range = {
      max: focalBaseline / (map.displayRange.min + doffs),
      min: focalBaseline / (map.displayRange.max + doffs),
    };
  } else {
    range = map.displayRange;
  }

  if (!range) return { message: "Not enough valid samples" };

  return settings.quantity === "depth"
    ? { far: roundRange(range.max), near: roundRange(range.min), unit }
    : { far: roundRange(range.min), near: roundRange(range.max), unit };
}

export interface DepthReadoutView {
  readonly status: string;
  readonly rows: readonly { readonly label: string; readonly value: string }[];
}

const NOT_AVAILABLE = "—";

/**
 * The same rows whether the pointer is off the picture, over a pixel without
 * depth or over depth, so the readout never changes height as it moves.
 */
export function describeDepthReadout(
  active: ActiveDepthMap | null,
  readout: DepthReadout | null,
): DepthReadoutView {
  const kind = active?.map.kind ?? "disparity_px";
  const unit = kind === "depth_m" ? "m" : kind === "disparity_px" ? "px" : "";
  const valid = readout?.valid === true;
  const value = (number: number | undefined, digits: number, suffix: string) =>
    valid && number !== undefined
      ? `${number.toFixed(digits)}${suffix ? ` ${suffix}` : ""}`
      : NOT_AVAILABLE;

  return {
    rows: [
      {
        label: "Depth frame",
        value: active ? String(active.frameIndex) : NOT_AVAILABLE,
      },
      {
        label: "Map pixel",
        value: readout ? `${readout.x}, ${readout.y}` : NOT_AVAILABLE,
      },
      {
        label: "Stored",
        value: readout ? String(readout.stored) : NOT_AVAILABLE,
      },
      kind === "relative_inverse"
        ? {
            label: "Inverse depth",
            value: value(readout?.relativeInverse, 4, ""),
          }
        : {
            label: "Disparity",
            value: value(readout?.disparityPx, 3, "px"),
          },
      { label: "Depth", value: value(readout?.depthM, 3, "m") },
      { label: "Step", value: value(readout?.step, 5, unit) },
      {
        label: "Confidence",
        value:
          readout?.confidence === undefined
            ? NOT_AVAILABLE
            : `${(readout.confidence * 100).toFixed(1)} %`,
      },
    ],
    status: !active
      ? "No depth on screen yet"
      : !readout
        ? "Point at the picture"
        : !readout.valid
          ? "No depth at this pixel"
          : readout.precision === "preview"
            ? "≈ 8-bit preview value"
            : "Exact value",
  };
}

export type DepthLayerLoad =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string };

/**
 * Reports how a depth layer swap is going. Only the latest swap reports, so a
 * slow earlier load never overwrites a later one's status.
 */
export function createDepthLayerLoader(report: (load: DepthLayerLoad) => void) {
  let latest = 0;

  return {
    load(swap: () => Promise<unknown>): Promise<void> {
      const request = ++latest;

      report({ status: "loading" });
      return swap().then(
        () => {
          if (request === latest) report({ status: "idle" });
        },
        (error: unknown) => {
          if (request === latest) {
            report({
              message: error instanceof Error ? error.message : String(error),
              status: "failed",
            });
          }
        },
      );
    },
    reset() {
      latest += 1;
      report({ status: "idle" });
    },
  };
}

/** Three decimals at most, as the range inputs and the snippet show them. */
function roundRange(value: number) {
  return Number(value.toFixed(3));
}
