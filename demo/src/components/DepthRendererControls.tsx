import { useState, type ReactNode } from "react";
import {
  depthColormapColors,
  type DepthColormap,
  type DepthQuantity,
  type DepthRange,
  type DepthSampling,
} from "supervision";
import {
  DEFAULT_NO_DEPTH_COLOR,
  DocsDepthRangeMode,
  changeDepthQuantity,
  changeDepthRangeMode,
  createDocsDepthSnippet,
  depthColormapOptions,
  depthSamplingOptions,
  type DocsDepthColourRange,
  type DocsDepthSettings,
} from "../docs-depth";
import { toHexColor } from "./InspectorControls";
import "./depth-renderer-controls.css";

/**
 * The depth renderer's options as controls, the same in every depth
 * playground. `lockRange` reads the percentiles of the depth on screen, in the
 * quantity given, and returns null when there is none.
 */
export function DepthRendererControls(props: {
  readonly settings: DocsDepthSettings;
  readonly onChange: (patch: Partial<DocsDepthSettings>) => void;
  readonly lockRange: (quantity: DepthQuantity) => DepthRange | null;
  readonly canLock: boolean;
  /** What the legend under the range control labels its ends with. */
  readonly colourRange: DocsDepthColourRange;
  /** Controls that choose what is shown, placed before the renderer's own. */
  readonly children?: ReactNode;
}) {
  const { lockRange, onChange, settings } = props;
  const [noDepthHex, setNoDepthHex] = useState(
    toHexColor(DEFAULT_NO_DEPTH_COLOR),
  );
  const unit = settings.quantity === "depth" ? "m" : "px";

  return (
    <div className="docs-layer-playground__controls">
      {props.children}
      <PlaygroundSelect
        label="Colormap"
        onChange={(value) => onChange({ colormap: value as DepthColormap })}
        options={depthColormapOptions.map((name) => [name, name])}
        value={settings.colormap}
      />
      <PlaygroundSelect
        label="Quantity"
        onChange={(value) =>
          onChange(
            changeDepthQuantity(settings, value as DepthQuantity, lockRange),
          )
        }
        options={[
          ["disparity", "Disparity (px)"],
          ["depth", "Depth (m)"],
        ]}
        value={settings.quantity}
      />
      <PlaygroundSelect
        label="Range"
        onChange={(value) =>
          onChange(
            changeDepthRangeMode(
              settings,
              value as DocsDepthRangeMode,
              lockRange,
            ),
          )
        }
        options={[
          [DocsDepthRangeMode.Clip, "Clip (manifest)"],
          [DocsDepthRangeMode.Auto, "Auto (this frame)"],
          [DocsDepthRangeMode.Manual, "Manual"],
        ]}
        value={settings.rangeMode}
      />
      {settings.rangeMode === DocsDepthRangeMode.Manual ? (
        <div className="depth-renderer-controls__range-inputs">
          <NumberField
            label={`Min (${unit})`}
            onChange={(min) =>
              onChange({ manualRange: { ...settings.manualRange, min } })
            }
            value={settings.manualRange.min}
          />
          <NumberField
            label={`Max (${unit})`}
            onChange={(max) =>
              onChange({ manualRange: { ...settings.manualRange, max } })
            }
            value={settings.manualRange.max}
          />
          <button
            disabled={!props.canLock}
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
        range={props.colourRange}
      />
      <PlaygroundSlider
        label="Opacity"
        onChange={(opacity) => onChange({ opacity })}
        value={settings.opacity}
      />
      <PlaygroundSlider
        label="Wipe"
        onChange={(wipe) => onChange({ wipe })}
        value={settings.wipe}
      />
      <PlaygroundSelect
        label="Sampling"
        onChange={(value) => onChange({ sampling: value as DepthSampling })}
        options={depthSamplingOptions.map((name) => [name, name])}
        value={settings.sampling}
      />
      <label className="docs-layer-playground__toggle">
        <span>
          <strong>Paint pixels without depth</strong>
          <small>Off leaves them unpainted</small>
        </span>
        <span className="depth-renderer-controls__no-depth">
          <input
            aria-label="No-depth colour"
            disabled={settings.noDepthColor === null}
            onChange={(event) => {
              setNoDepthHex(event.currentTarget.value);
              onChange({
                noDepthColor: Number.parseInt(
                  event.currentTarget.value.slice(1),
                  16,
                ),
              });
            }}
            type="color"
            value={noDepthHex}
          />
          <input
            checked={settings.noDepthColor !== null}
            onChange={(event) =>
              onChange({
                noDepthColor: event.currentTarget.checked
                  ? Number.parseInt(noDepthHex.slice(1), 16)
                  : null,
              })
            }
            type="checkbox"
          />
        </span>
      </label>
    </div>
  );
}

/**
 * The colormap as the renderer draws it, far end on the left, with the value
 * at each end. It keeps one height whatever the range says.
 */
export function DepthColourLegend(props: {
  readonly colormap: DepthColormap;
  readonly range: DocsDepthColourRange;
}) {
  const { range } = props;

  return (
    <div className="depth-renderer-controls__legend">
      <span
        aria-hidden="true"
        style={{
          background: `linear-gradient(to right, ${depthColormapColors(props.colormap).join(", ")})`,
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

/** The `setPresentation` call the controls describe, kept in step with them. */
export function DepthLiveCode(props: { readonly settings: DocsDepthSettings }) {
  return (
    <section
      className="docs-layer-playground__code"
      aria-label="Live presentation code"
    >
      <div>
        <span>Live code</span>
        <small>Values update with the controls</small>
      </div>
      <pre>
        <code>{createDocsDepthSnippet(props.settings)}</code>
      </pre>
    </section>
  );
}

function PlaygroundSelect(props: {
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly (readonly [string, string])[];
  readonly value: string;
}) {
  return (
    <label className="docs-layer-playground__select">
      <strong>{props.label}</strong>
      <select
        onChange={(event) => props.onChange(event.currentTarget.value)}
        value={props.value}
      >
        {props.options.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}

function PlaygroundSlider(props: {
  readonly label: string;
  readonly onChange: (value: number) => void;
  readonly value: number;
}) {
  return (
    <label className="docs-layer-playground__range">
      <span>
        <strong>{props.label}</strong>
        <output>{Math.round(props.value * 100)}%</output>
      </span>
      <input
        max="1"
        min="0"
        onChange={(event) => props.onChange(Number(event.currentTarget.value))}
        step="0.05"
        type="range"
        value={props.value}
      />
    </label>
  );
}

function NumberField(props: {
  readonly label: string;
  readonly onChange: (value: number) => void;
  readonly value: number;
}) {
  return (
    <label>
      <strong>{props.label}</strong>
      <input
        onChange={(event) => {
          const value = Number(event.currentTarget.value);
          if (Number.isFinite(value)) props.onChange(value);
        }}
        step="any"
        type="number"
        value={props.value}
      />
    </label>
  );
}
