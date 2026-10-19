import type { DepthLayerLoad, DepthSettings } from "../depth";
import type { DepthProbe } from "../hooks/depth-probe";
import { DepthControls, type DepthControlKit } from "./DepthControls";
import {
  ColorControl,
  ControlNote,
  ControlSection,
  NumberControl,
  SegmentedControl,
  SliderControl,
  ToggleControl,
} from "./InspectorControls";

export interface WorkbenchDepth {
  readonly blockedReason: string | null;
  readonly layerId: string | null;
  readonly layerLoad: DepthLayerLoad;
  readonly layers: readonly { readonly id: string; readonly label: string }[];
  readonly onLayerChange: (layerId: string) => void;
  readonly probe: DepthProbe;
}

export const depthStyleKit: DepthControlKit = {
  Choice: SegmentedControl,
  Color: ColorControl,
  Number: ({ onChange, ...props }) => (
    <NumberControl
      {...props}
      onChange={(value) => {
        if (value !== undefined) onChange(value);
      }}
      step={0.001}
    />
  ),
  Slider: (props) => (
    <SliderControl
      {...props}
      max={1}
      min={0}
      step={0.05}
      valueLabel={`${Math.round(props.value * 100)}%`}
    />
  ),
  Toggle: ToggleControl,
};

export function DepthStyleSection({
  available,
  depth,
  enabled,
  onChange,
  onToggleEnabled,
  settings,
}: {
  readonly available: boolean;
  readonly depth: WorkbenchDepth;
  readonly enabled: boolean;
  readonly onChange: (patch: Partial<DepthSettings>) => void;
  readonly onToggleEnabled: (enabled: boolean) => void;
  readonly settings: DepthSettings;
}) {
  return (
    <ControlSection
      description={depth.blockedReason ?? undefined}
      enabled={enabled}
      evalHook="section:depth"
      onToggleEnabled={onToggleEnabled}
      title="Depth"
      toggleDisabled={!available}
    >
      {depth.layers.length > 1 ? (
        <>
          <SegmentedControl
            disabled={!enabled}
            label="Layer"
            onChange={depth.onLayerChange}
            options={depth.layers.map((layer) => ({
              label: shortLayerLabel(layer.label),
              value: layer.id,
            }))}
            tooltip="Which of the sample's depth layers is drawn. Switching loads it without reopening the clip."
            value={depth.layerId ?? ""}
          />
          <ControlNote>{describeLayer(depth)}</ControlNote>
        </>
      ) : null}
      <DepthControls
        disabled={!enabled}
        kit={depthStyleKit}
        onChange={onChange}
        probe={depth.probe}
        settings={settings}
      />
    </ControlSection>
  );
}

/** "Stereo matcher (OpenCV SGBM)" fits a segment as "Stereo matcher". */
export function shortLayerLabel(label: string) {
  return label.replace(/\s*\([^)]*\)\s*$/, "");
}

function describeLayer(depth: WorkbenchDepth) {
  const layer = depth.layers.find(({ id }) => id === depth.layerId);

  if (depth.layerLoad.status === "failed") {
    return `Depth did not load: ${depth.layerLoad.message}`;
  }
  if (depth.layerLoad.status === "loading") {
    return `Loading ${layer?.label ?? "depth"}…`;
  }
  return layer?.label ?? "";
}
