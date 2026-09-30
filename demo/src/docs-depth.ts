import {
  annotationRenderers,
  type DepthAnnotationRenderer,
  type DepthColormap,
  type DepthMapKind,
  type DepthQuantity,
  type DepthRange,
  type DepthReadout,
  type DepthSampling,
} from "supervision";

export const DocsDepthRangeMode = {
  Clip: "clip",
  Auto: "auto",
  Manual: "manual",
} as const;

export type DocsDepthRangeMode =
  (typeof DocsDepthRangeMode)[keyof typeof DocsDepthRangeMode];

/** Every depth renderer control a playground offers, in descriptor units. */
export interface DocsDepthSettings {
  readonly colormap: DepthColormap;
  readonly quantity: DepthQuantity;
  readonly rangeMode: DocsDepthRangeMode;
  /** In the quantity's unit: pixels of disparity or metres of depth. */
  readonly manualRange: DepthRange;
  readonly opacity: number;
  readonly sampling: DepthSampling;
  readonly wipe: number;
  readonly noDepthColor: number | null;
}

export const initialDocsDepthSettings: DocsDepthSettings = {
  colormap: "turbo",
  manualRange: { max: 150, min: 3 },
  noDepthColor: null,
  opacity: 1,
  quantity: "disparity",
  rangeMode: DocsDepthRangeMode.Clip,
  sampling: "auto",
  wipe: 1,
};

export function createDocsDepthRenderer(
  settings: DocsDepthSettings,
): DepthAnnotationRenderer {
  return annotationRenderers.depth({
    colormap: settings.colormap,
    noDepthColor: settings.noDepthColor,
    opacity: settings.opacity,
    quantity: settings.quantity,
    range:
      settings.rangeMode === DocsDepthRangeMode.Manual
        ? { max: settings.manualRange.max, min: settings.manualRange.min }
        : settings.rangeMode,
    sampling: settings.sampling,
    wipe: settings.wipe,
  });
}

/** The `setPresentation` call that builds exactly `createDocsDepthRenderer`. */
export function createDocsDepthSnippet(settings: DocsDepthSettings): string {
  const range =
    settings.rangeMode === DocsDepthRangeMode.Manual
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

/** One line of the pointer readout. */
export interface DocsDepthReadoutRow {
  readonly label: string;
  readonly value: string;
}

/** What the pointer readout shows: a status line and a fixed set of rows. */
export interface DocsDepthReadoutView {
  readonly status: string;
  readonly rows: readonly DocsDepthReadoutRow[];
}

const NOT_AVAILABLE = "—";

/**
 * The pointer readout as text. It always has the same rows, whether the
 * pointer is off the picture, over a pixel without depth or over depth, so
 * the panel around it never changes height as the pointer moves; a row with
 * nothing to say reads "—".
 */
export function describeDepthReadout(
  readout: DepthReadout | null,
  kind: DepthMapKind = "disparity_px",
): DocsDepthReadoutView {
  const unit = kind === "depth_m" ? "m" : kind === "disparity_px" ? "px" : "";
  const valid = readout?.valid === true;
  const value = (number: number | undefined, digits: number, suffix: string) =>
    valid && number !== undefined
      ? `${number.toFixed(digits)}${suffix ? ` ${suffix}` : ""}`
      : NOT_AVAILABLE;

  return {
    rows: [
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
    status: !readout
      ? "Point at the picture"
      : !readout.valid
        ? "No depth at this pixel"
        : readout.precision === "preview"
          ? "≈ 8-bit preview value"
          : "Exact value",
  };
}
