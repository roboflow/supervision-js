import { useState, type ReactNode } from "react";
import type { DepthColormap, DepthQuantity, DepthSampling } from "supervision";
import {
  DocsDepthRangeMode,
  createDocsDepthSnippet,
  type DocsDepthSettings,
} from "../docs-depth";
import "./depth-renderer-controls.css";

const colormaps: readonly DepthColormap[] = [
  "turbo",
  "viridis",
  "cividis",
  "inferno",
  "magma",
  "grayscale",
];
const samplings: readonly DepthSampling[] = ["auto", "nearest", "edge-aware"];
const DEFAULT_NO_DEPTH_HEX = "#202020";

/**
 * The depth renderer's options as controls, the same in every depth
 * playground. `onLock` fixes a manual range to the percentiles of the depth
 * on screen, in the quantity given, and returns false when there is none.
 */
export function DepthRendererControls(props: {
  readonly settings: DocsDepthSettings;
  readonly onChange: (patch: Partial<DocsDepthSettings>) => void;
  readonly onLock: (quantity: DepthQuantity) => boolean;
  readonly canLock: boolean;
  /** The note under the range control, from `describeDepthColourRange`. */
  readonly colourRange: string;
  /** Controls that choose what is shown, placed before the renderer's own. */
  readonly children?: ReactNode;
}) {
  const { onChange, onLock, settings } = props;
  const [noDepthHex, setNoDepthHex] = useState(DEFAULT_NO_DEPTH_HEX);
  const unit = settings.quantity === "depth" ? "m" : "px";

  return (
    <div className="docs-layer-playground__controls">
      {props.children}
      <PlaygroundSelect
        label="Colormap"
        onChange={(value) => onChange({ colormap: value as DepthColormap })}
        options={colormaps.map((name) => [name, name])}
        value={settings.colormap}
      />
      <PlaygroundSelect
        label="Quantity"
        onChange={(value) => {
          const quantity = value as DepthQuantity;

          // A manual range in pixels means nothing in metres, so it is
          // locked again in the new unit.
          if (settings.rangeMode !== DocsDepthRangeMode.Manual) {
            onChange({ quantity });
          } else if (!onLock(quantity)) {
            onChange({ quantity, rangeMode: DocsDepthRangeMode.Clip });
          }
        }}
        options={[
          ["disparity", "Disparity (px)"],
          ["depth", "Depth (m)"],
        ]}
        value={settings.quantity}
      />
      <PlaygroundSelect
        label="Range"
        onChange={(value) => {
          if (value !== DocsDepthRangeMode.Manual) {
            onChange({ rangeMode: value as DocsDepthRangeMode });
          } else if (!onLock(settings.quantity)) {
            onChange({ rangeMode: DocsDepthRangeMode.Manual });
          }
        }}
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
            onClick={() => onLock(settings.quantity)}
            type="button"
          >
            Lock to this frame
          </button>
        </div>
      ) : null}
      <p className="depth-renderer-controls__note">{props.colourRange}</p>
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
        options={samplings.map((name) => [name, name])}
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

export function PlaygroundSelect(props: {
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
