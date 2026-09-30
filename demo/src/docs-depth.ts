import {
  annotationRenderers,
  type DepthAnnotationRenderer,
  type DepthColormap,
  type DepthQuantity,
  type DepthRange,
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
