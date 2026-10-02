import { useRef, type ReactElement } from "react";
import { depthColormapColors, type DepthQuantity } from "supervision";
import {
  DEFAULT_NO_DEPTH_COLOR,
  DepthRangeMode,
  changeDepthQuantity,
  changeDepthRangeMode,
  depthColormapOptions,
  depthMapSpan,
  depthRangeTrack,
  depthSamplingOptions,
  lockDepthRange,
  resolveDepthColourRange,
  type DepthColourRange,
  type DepthSettings,
} from "../depth";
import { useShownDepthMap, type DepthProbe } from "../hooks/depth-probe";
import { RangeSlider } from "./RangeSlider";
import "./depth-controls.css";

interface DepthControlProps<Value> {
  readonly disabled: boolean;
  readonly label: string;
  readonly onChange: (value: Value) => void;
  readonly tooltip?: string;
  readonly value: Value;
}

export type DepthChoiceProps<Value extends string> =
  DepthControlProps<Value> & {
    readonly options: readonly {
      readonly label: string;
      readonly value: Value;
    }[];
  };

/** The widgets a page draws the depth controls with, in its own look. */
export interface DepthControlKit {
  readonly Choice: <Value extends string>(
    props: DepthChoiceProps<Value>,
  ) => ReactElement;
  readonly Color: (props: DepthControlProps<number>) => ReactElement;
  readonly Number: (props: DepthControlProps<number>) => ReactElement;
  /** From 0 to 1. */
  readonly Slider: (props: DepthControlProps<number>) => ReactElement;
  readonly Toggle: (
    props: Omit<DepthControlProps<boolean>, "value"> & {
      readonly checked: boolean;
    },
  ) => ReactElement;
}

/** `probe` supplies the depth on screen, which the legend and the range lock read. */
export function DepthControls({
  disabled = false,
  kit,
  onChange,
  probe,
  settings,
}: {
  readonly disabled?: boolean;
  readonly kit: DepthControlKit;
  readonly onChange: (patch: Partial<DepthSettings>) => void;
  readonly probe: DepthProbe;
  readonly settings: DepthSettings;
}) {
  const { Choice, Color, Number: NumberField, Slider, Toggle } = kit;
  const shown = useShownDepthMap(probe);
  /** The colour painting turns back on with: the last one picked. */
  const noDepthColorRef = useRef(
    settings.noDepthColor ?? DEFAULT_NO_DEPTH_COLOR,
  );
  const unit = settings.quantity === "depth" ? "m" : "px";
  /** What the slider spans before any depth has been on screen. */
  const idleSpanRef = useRef(settings.manualRange);
  const lockRange = (quantity: DepthQuantity) =>
    lockDepthRange(shown.active?.map, quantity);
  const manual = settings.rangeMode === DepthRangeMode.Manual;
  const track = manual
    ? depthRangeTrack(
        (shown.lastMap && depthMapSpan(shown.lastMap, settings.quantity)) ??
          idleSpanRef.current,
        settings.manualRange,
      )
    : null;
  const colors = depthColormapColors(settings.colormap);

  if (settings.noDepthColor !== null) {
    noDepthColorRef.current = settings.noDepthColor;
  }

  return (
    <>
      <Choice
        disabled={disabled}
        label="Colormap"
        onChange={(colormap) => onChange({ colormap })}
        options={depthColormapOptions}
        tooltip="The near end is always the warm or bright end. Turbo separates the most depth steps; Viridis and Cividis keep their order in grayscale and for colour-blind viewers."
        value={settings.colormap}
      />
      <Choice
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
      <Choice
        disabled={disabled}
        label="Range"
        onChange={(rangeMode) =>
          onChange(changeDepthRangeMode(settings, rangeMode, lockRange))
        }
        options={[
          { label: "Clip", value: DepthRangeMode.Clip },
          { label: "Auto", value: DepthRangeMode.Auto },
          { label: "Manual", value: DepthRangeMode.Manual },
        ]}
        tooltip="Clip uses the manifest's display range, Auto this frame's 2nd to 98th percentile, and Manual a fixed min and max in the quantity's unit. Values outside the range take its end colours."
        value={settings.rangeMode}
      />
      {track ? (
        <RangeSlider
          bounds={track.bounds}
          colors={
            settings.quantity === "depth" ? [...colors].reverse() : colors
          }
          disabled={disabled}
          format={(value) => `${value} ${unit}`}
          labels={{ max: `Max (${unit})`, min: `Min (${unit})` }}
          onChange={(manualRange) => onChange({ manualRange })}
          step={track.step}
          value={settings.manualRange}
        />
      ) : null}
      <DepthColourLegend
        colors={colors}
        range={resolveDepthColourRange(shown.lastMap, settings)}
      />
      {manual ? (
        <div className="depth-controls__range">
          <NumberField
            disabled={disabled}
            label={`Min (${unit})`}
            onChange={(min) =>
              onChange({ manualRange: { ...settings.manualRange, min } })
            }
            value={settings.manualRange.min}
          />
          <NumberField
            disabled={disabled}
            label={`Max (${unit})`}
            onChange={(max) =>
              onChange({ manualRange: { ...settings.manualRange, max } })
            }
            value={settings.manualRange.max}
          />
          <button
            className="depth-controls__lock"
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
      <Slider
        disabled={disabled}
        label="Opacity"
        onChange={(opacity) => onChange({ opacity })}
        value={settings.opacity}
      />
      <Slider
        disabled={disabled}
        label="Wipe"
        onChange={(wipe) => onChange({ wipe })}
        tooltip="The share of the picture, from the left, that shows depth. The rest shows the video."
        value={settings.wipe}
      />
      <Choice
        disabled={disabled}
        label="Sampling"
        onChange={(sampling) => onChange({ sampling })}
        options={depthSamplingOptions}
        tooltip="Auto shows the nearest map pixel when the map is at least the picture's size, and filters edge-aware when it is smaller so a near edge never blends into the background."
        value={settings.sampling}
      />
      <Toggle
        checked={settings.noDepthColor !== null}
        disabled={disabled}
        label="Paint pixels without depth"
        onChange={(checked) =>
          onChange({ noDepthColor: checked ? noDepthColorRef.current : null })
        }
        tooltip="Off leaves them unpainted, so the video shows through."
      />
      <Color
        disabled={disabled || settings.noDepthColor === null}
        label="No-depth colour"
        onChange={(noDepthColor) => onChange({ noDepthColor })}
        value={settings.noDepthColor ?? noDepthColorRef.current}
      />
    </>
  );
}

function DepthColourLegend(props: {
  readonly colors: readonly string[];
  readonly range: DepthColourRange;
}) {
  const { range } = props;

  return (
    <div className="depth-controls__legend">
      <span
        aria-hidden="true"
        style={{
          background: `linear-gradient(to right, ${props.colors.join(", ")})`,
        }}
      />
      {"message" in range ? (
        <p>
          <small>{range.message}</small>
        </p>
      ) : (
        <p
          aria-label={`Colours run from ${range.far} ${range.unit} (far) to ${range.near} ${range.unit} (near)`}
        >
          <small>
            far {range.far} {range.unit}
          </small>
          <small>
            near {range.near} {range.unit}
          </small>
        </p>
      )}
    </div>
  );
}
