import { heatmapPaletteOptions, type DemoHeatmapSettings } from "../heatmap";
import {
  ControlSection,
  NumberControl,
  SegmentedControl,
  SliderControl,
} from "./InspectorControls";

export function HeatmapStyleSection({
  available,
  enabled,
  onChange,
  onToggleEnabled,
  settings,
}: {
  readonly available: boolean;
  readonly enabled: boolean;
  readonly onChange: (patch: Partial<DemoHeatmapSettings>) => void;
  readonly onToggleEnabled: (enabled: boolean) => void;
  readonly settings: DemoHeatmapSettings;
}) {
  return (
    <ControlSection
      enabled={enabled}
      evalHook="section:heatmap"
      onToggleEnabled={onToggleEnabled}
      title="Heatmap"
      toggleDisabled={!available}
    >
      <SliderControl
        disabled={!enabled}
        label="Threshold scale"
        max={2}
        min={0}
        onChange={(heatmapThresholdScale) =>
          onChange({ heatmapThresholdScale })
        }
        optionPath="heatmap.thresholdScale"
        step={0.05}
        tooltip="Multiplies the model's anomaly threshold. Lower values show weaker scores; 1 uses the model threshold."
        value={settings.heatmapThresholdScale}
        valueLabel={`${Math.round(settings.heatmapThresholdScale * 100)}%`}
      />
      <SliderControl
        disabled={!enabled}
        label="Minimum alpha"
        max={1}
        min={0}
        onChange={(heatmapMinimumAlpha) => onChange({ heatmapMinimumAlpha })}
        optionPath="heatmap.minimumAlpha"
        step={0.05}
        tooltip="Minimum opacity of samples above the cutoff, before overall opacity is applied. Samples below the cutoff stay transparent."
        value={settings.heatmapMinimumAlpha}
        valueLabel={`${Math.round(settings.heatmapMinimumAlpha * 100)}%`}
      />
      <SliderControl
        disabled={!enabled}
        label="Opacity"
        max={1}
        min={0}
        onChange={(heatmapOpacity) => onChange({ heatmapOpacity })}
        optionPath="heatmap.opacity"
        step={0.05}
        value={settings.heatmapOpacity}
        valueLabel={`${Math.round(settings.heatmapOpacity * 100)}%`}
      />
      <NumberControl
        disabled={!enabled}
        label="Maximum score"
        min={0.001}
        onChange={(heatmapMaximumScore) => {
          if (heatmapMaximumScore === undefined || heatmapMaximumScore > 0) {
            onChange({ heatmapMaximumScore });
          }
        }}
        optionPath="heatmap.maximumScore"
        placeholder="1"
        step={0.05}
        tooltip="Score mapped to the final color. Leave empty for the library default of 1; use a positive value for other score ranges."
        value={settings.heatmapMaximumScore}
      />
      <SegmentedControl
        disabled={!enabled}
        label="Color palette"
        onChange={(heatmapPalette) => onChange({ heatmapPalette })}
        optionPath="heatmap.colorStops"
        options={heatmapPaletteOptions}
        tooltip="Default uses the library's warm colors. Viridis and Gray use fixed color stops across the score range."
        value={settings.heatmapPalette}
      />
    </ControlSection>
  );
}
