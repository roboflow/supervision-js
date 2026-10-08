import {
  annotationRenderers,
  depthColormapColors,
  type HeatmapAnnotationRenderer,
  type HeatmapColorStop,
} from "supervision";

export type DemoHeatmapPalette = "default" | "viridis" | "grayscale";

export interface DemoHeatmapSettings {
  readonly heatmapThresholdScale: number;
  readonly heatmapMinimumAlpha: number;
  readonly heatmapOpacity: number;
  readonly heatmapMaximumScore: number | undefined;
  readonly heatmapPalette: DemoHeatmapPalette;
}

export const initialDemoHeatmapSettings: DemoHeatmapSettings = {
  heatmapThresholdScale: 0.75,
  heatmapMinimumAlpha: 0.35,
  heatmapOpacity: 1,
  heatmapMaximumScore: undefined,
  heatmapPalette: "default",
};

export const heatmapPaletteOptions: readonly {
  readonly label: string;
  readonly value: DemoHeatmapPalette;
}[] = [
  { label: "Default", value: "default" },
  { label: "Viridis", value: "viridis" },
  { label: "Gray", value: "grayscale" },
];

const paletteStops: Readonly<
  Record<Exclude<DemoHeatmapPalette, "default">, readonly HeatmapColorStop[]>
> = {
  viridis: createStops("viridis", 6),
  grayscale: createStops("grayscale", 2),
};

export function createDemoHeatmapRenderer(
  settings: DemoHeatmapSettings,
): HeatmapAnnotationRenderer {
  return annotationRenderers.heatmap({
    thresholdScale: settings.heatmapThresholdScale,
    minimumAlpha: settings.heatmapMinimumAlpha,
    opacity: settings.heatmapOpacity,
    maximumScore: settings.heatmapMaximumScore,
    colorStops:
      settings.heatmapPalette === "default"
        ? undefined
        : paletteStops[settings.heatmapPalette],
  });
}

export function createDemoHeatmapSnippet(
  settings: DemoHeatmapSettings,
): string {
  const renderer = createDemoHeatmapRenderer(settings);
  const maximumScore =
    renderer.maximumScore === undefined
      ? ""
      : `\n      maximumScore: ${renderer.maximumScore},`;
  const colorStops = renderer.colorStops
    ? `\n      colorStops: [\n${renderer.colorStops
        .map(
          (stop) =>
            `        { position: ${stop.position}, color: 0x${stop.color.toString(16).padStart(6, "0")} },`,
        )
        .join("\n")}\n      ],`
    : "";

  return `session.setPresentation({
  renderers: [
    annotationRenderers.heatmap({
      thresholdScale: ${renderer.thresholdScale},
      minimumAlpha: ${renderer.minimumAlpha},
      opacity: ${renderer.opacity},${maximumScore}${colorStops}
    }),
  ],
});`;
}

function createStops(
  palette: "viridis" | "grayscale",
  count: number,
): readonly HeatmapColorStop[] {
  return depthColormapColors(palette, count).map((color, index) => ({
    color: Number.parseInt(color.slice(1), 16),
    position: index / (count - 1),
  }));
}
