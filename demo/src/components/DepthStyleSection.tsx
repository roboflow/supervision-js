import { useRef } from "react";
import type { DepthMap, DepthQuantity, DepthSampling } from "supervision";
import {
  DEFAULT_NO_DEPTH_COLOR,
  DocsDepthRangeMode,
  changeDepthQuantity,
  changeDepthRangeMode,
  depthColormapOptions,
  depthSamplingOptions,
  lockDepthRange,
  resolveDepthColourRange,
  type DocsDepthSettings,
} from "../docs-depth";
import { useDepthProbe, type DepthProbe } from "../hooks/depth-probe";
import type { DemoDepthLayerLoad } from "../hooks/useDemoRenderer";
import { DepthColourLegend } from "./DepthRendererControls";
import { DepthReadoutPanel } from "./DepthReadoutPanel";
import {
  ColorControl,
  ControlNote,
  ControlSection,
  NumberControl,
  SegmentedControl,
  SliderControl,
  ToggleControl,
} from "./InspectorControls";
import "./depth-renderer-controls.css";
import "./depth-style-section.css";

/** One of the open sample's depth layers. */
export interface WorkbenchDepthLayer {
  readonly id: string;
  readonly label: string;
}

/** What the workbench knows about depth beside its style settings. */
export interface WorkbenchDepth {
  /** Why the sample's depth cannot be drawn on this path, or null when it can. */
  readonly blockedReason: string | null;
  readonly layerId: string | null;
  readonly layerLoad: DemoDepthLayerLoad;
  readonly layers: readonly WorkbenchDepthLayer[];
  readonly onLayerChange: (layerId: string) => void;
  readonly probe: DepthProbe;
}

const colormapLabels: Record<string, string> = {
  cividis: "Cividis",
  grayscale: "Grayscale",
  inferno: "Inferno",
  magma: "Magma",
  turbo: "Turbo",
  viridis: "Viridis",
};

const samplingLabels: Record<DepthSampling, string> = {
  auto: "Auto",
  "edge-aware": "Edge-aware",
  nearest: "Nearest",
};

/**
 * The depth renderer's options in the Style panel, with the same options and
 * the same range behaviour as the docs depth playground.
 */
export function DepthStyleSection({
  available,
  depth,
  enabled,
  onChange,
  onToggleEnabled,
  settings,
}: {
  readonly available: boolean;
  readonly depth?: WorkbenchDepth;
  readonly enabled: boolean;
  readonly onChange: (patch: Partial<DocsDepthSettings>) => void;
  readonly onToggleEnabled: (enabled: boolean) => void;
  readonly settings: DocsDepthSettings;
}) {
  return (
    <ControlSection
      description={depth?.blockedReason ?? undefined}
      enabled={enabled}
      evalHook="section:depth"
      onToggleEnabled={onToggleEnabled}
      title="Depth"
      toggleDisabled={!available}
    >
      <DepthStyleControls
        depth={depth}
        disabled={!enabled}
        onChange={onChange}
        settings={settings}
      />
    </ControlSection>
  );
}

/**
 * The section's body. It reads the depth on screen only while it is open: the
 * legend's ends and the range lock both come from that map.
 */
export function DepthStyleControls({
  depth,
  disabled,
  onChange,
  settings,
}: {
  readonly depth?: WorkbenchDepth;
  readonly disabled: boolean;
  readonly onChange: (patch: Partial<DocsDepthSettings>) => void;
  readonly settings: DocsDepthSettings;
}) {
  const shown = useShownDepthMap(depth?.probe ?? null);
  /** The colour painting is turned back on with, the last one picked. */
  const noDepthColorRef = useRef(
    settings.noDepthColor ?? DEFAULT_NO_DEPTH_COLOR,
  );
  const unit = settings.quantity === "depth" ? "m" : "px";

  if (settings.noDepthColor !== null) {
    noDepthColorRef.current = settings.noDepthColor;
  }
  const lockRange = (quantity: DepthQuantity) =>
    lockDepthRange(shown.active?.map, quantity);

  return (
    <>
      {depth && depth.layers.length > 1 ? (
        <>
          <SegmentedControl
            disabled={disabled}
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
      <SegmentedControl
        disabled={disabled}
        label="Colormap"
        onChange={(colormap) => onChange({ colormap })}
        options={depthColormapOptions.map((colormap) => ({
          label: colormapLabels[colormap] ?? colormap,
          value: colormap,
        }))}
        tooltip="The near end is always the warm or bright end. Turbo separates the most depth steps; Viridis and Cividis keep their order in grayscale and for colour-blind viewers."
        value={settings.colormap}
      />
      <SegmentedControl
        disabled={disabled}
        label="Quantity"
        onChange={(quantity) =>
          onChange(changeDepthQuantity(settings, quantity, lockRange))
        }
        options={[
          { label: "Disparity (px)", value: "disparity" },
          { label: "Depth (m)", value: "depth" },
        ]}
        tooltip="Disparity colours inverse depth, which spends colour on near detail the way stereo measures it. Depth colours metres and needs the map's camera."
        value={settings.quantity}
      />
      <SegmentedControl<DocsDepthRangeMode>
        disabled={disabled}
        label="Range"
        onChange={(rangeMode) =>
          onChange(changeDepthRangeMode(settings, rangeMode, lockRange))
        }
        options={[
          { label: "Clip", value: DocsDepthRangeMode.Clip },
          { label: "Auto", value: DocsDepthRangeMode.Auto },
          { label: "Manual", value: DocsDepthRangeMode.Manual },
        ]}
        tooltip="Clip uses the manifest's display range, Auto this frame's 2nd to 98th percentile, and Manual a fixed min and max in the quantity's unit. Values outside the range take its end colours."
        value={settings.rangeMode}
      />
      {settings.rangeMode === DocsDepthRangeMode.Manual ? (
        <div className="depth-style__range">
          <NumberControl
            disabled={disabled}
            label={`Min (${unit})`}
            onChange={(min) => {
              if (min !== undefined) {
                onChange({ manualRange: { ...settings.manualRange, min } });
              }
            }}
            step={0.001}
            value={settings.manualRange.min}
          />
          <NumberControl
            disabled={disabled}
            label={`Max (${unit})`}
            onChange={(max) => {
              if (max !== undefined) {
                onChange({ manualRange: { ...settings.manualRange, max } });
              }
            }}
            step={0.001}
            value={settings.manualRange.max}
          />
          <button
            className="depth-style__lock"
            disabled={disabled || shown.active === null}
            onClick={() => {
              const manualRange = lockRange(settings.quantity);
              if (manualRange) onChange({ manualRange });
            }}
            type="button"
          >
            Lock to this frame
          </button>
        </div>
      ) : null}
      <DepthColourLegend
        colormap={settings.colormap}
        range={resolveDepthColourRange(shown.lastMap, settings)}
      />
      <SliderControl
        disabled={disabled}
        label="Opacity"
        max={1}
        min={0}
        onChange={(opacity) => onChange({ opacity })}
        step={0.05}
        value={settings.opacity}
        valueLabel={formatPercent(settings.opacity)}
      />
      <SliderControl
        disabled={disabled}
        label="Wipe"
        max={1}
        min={0}
        onChange={(wipe) => onChange({ wipe })}
        step={0.05}
        tooltip="The share of the picture, from the left, that shows depth. The rest shows the video."
        value={settings.wipe}
        valueLabel={formatPercent(settings.wipe)}
      />
      <SegmentedControl
        disabled={disabled}
        label="Sampling"
        onChange={(sampling) => onChange({ sampling })}
        options={depthSamplingOptions.map((sampling) => ({
          label: samplingLabels[sampling],
          value: sampling,
        }))}
        tooltip="Auto shows the nearest map pixel when the map is at least the picture's size, and filters edge-aware when it is smaller so a near edge never blends into the background."
        value={settings.sampling}
      />
      <ToggleControl
        checked={settings.noDepthColor !== null}
        disabled={disabled}
        label="Paint pixels without depth"
        onChange={(checked) =>
          onChange({ noDepthColor: checked ? noDepthColorRef.current : null })
        }
        tooltip="Off leaves pixels without depth unpainted, so the video shows through them."
      />
      <ColorControl
        disabled={disabled || settings.noDepthColor === null}
        label="No-depth colour"
        onChange={(noDepthColor) => onChange({ noDepthColor })}
        value={settings.noDepthColor ?? noDepthColorRef.current}
      />
    </>
  );
}

/** The pointer readout for the Inspect panel, drawn from the same probe. */
export function WorkbenchDepthReadout({
  probe,
}: {
  readonly probe: DepthProbe;
}) {
  const { active, readout } = useDepthProbe(probe);

  return (
    <DepthReadoutPanel
      frameIndex={active?.frameIndex ?? null}
      idleStatus={active ? "Point at the picture" : "No depth on screen yet"}
      kind={active?.map.kind}
      readout={readout}
    />
  );
}

/**
 * The depth on screen, and the last map that was, so the legend keeps its
 * ends while playback passes frames whose depth is not drawn yet.
 */
function useShownDepthMap(probe: DepthProbe | null) {
  const snapshot = useDepthProbe(probe ?? idleProbe);
  const lastMapRef = useRef<DepthMap | null>(null);

  if (snapshot.active) lastMapRef.current = snapshot.active.map;

  return { active: snapshot.active, lastMap: lastMapRef.current };
}

const idleProbe: DepthProbe = {
  getSnapshot: () => idleSnapshot,
  onPointerLeave: () => {},
  onPointerMove: () => {},
  refresh: () => {},
  subscribe: () => () => {},
};
const idleSnapshot = { active: null, readout: null };

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

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}
