import { BoxShape } from "supervision-js";
import type { CSSProperties } from "react";
import type { BasketballPresentationSettings } from "../presentation/basketball-presentation";

export function RenderControls({
  onChange,
  settings,
}: {
  readonly onChange: (settings: BasketballPresentationSettings) => void;
  readonly settings: BasketballPresentationSettings;
}) {
  const updateSettings = <Key extends keyof BasketballPresentationSettings>(
    key: Key,
    value: BasketballPresentationSettings[Key],
  ) => {
    onChange({ ...settings, [key]: value });
  };

  return (
    <section className="render-controls" aria-label="Render controls">
      <div className="render-controls__toggles">
        <label className="render-control render-control--toggle">
          <input
            checked={settings.boxesEnabled}
            onChange={(event) =>
              updateSettings("boxesEnabled", event.currentTarget.checked)
            }
            type="checkbox"
          />
          <span>Boxes</span>
        </label>
        <label className="render-control render-control--toggle">
          <input
            checked={settings.masksEnabled}
            onChange={(event) =>
              updateSettings("masksEnabled", event.currentTarget.checked)
            }
            type="checkbox"
          />
          <span>Masks</span>
        </label>
      </div>

      <fieldset className="render-control render-control--shape">
        <legend>Shape</legend>
        <div className="render-control__segments">
          <button
            aria-pressed={settings.boxShape === BoxShape.Rect}
            disabled={!settings.boxesEnabled}
            onClick={() => updateSettings("boxShape", BoxShape.Rect)}
            type="button"
          >
            Rect
          </button>
          <button
            aria-pressed={settings.boxShape === BoxShape.RoundedRect}
            disabled={!settings.boxesEnabled}
            onClick={() => updateSettings("boxShape", BoxShape.RoundedRect)}
            type="button"
          >
            Rounded
          </button>
        </div>
      </fieldset>

      <SliderControl
        disabled={!settings.boxesEnabled}
        label="Stroke"
        max={8}
        min={1}
        onChange={(value) => updateSettings("boxStrokeWidth", value)}
        step={1}
        value={settings.boxStrokeWidth}
        valueLabel={`${settings.boxStrokeWidth}px`}
      />
      <SliderControl
        disabled={!settings.boxesEnabled}
        label="Box Fill"
        max={0.35}
        min={0}
        onChange={(value) => updateSettings("boxFillAlpha", value)}
        step={0.01}
        value={settings.boxFillAlpha}
        valueLabel={formatPercent(settings.boxFillAlpha)}
      />
      <SliderControl
        disabled={!settings.masksEnabled}
        label="Mask"
        max={1}
        min={0}
        onChange={(value) => updateSettings("maskAlpha", value)}
        step={0.01}
        value={settings.maskAlpha}
        valueLabel={formatPercent(settings.maskAlpha)}
      />
      <SliderControl
        label="Confidence"
        max={1}
        min={0}
        onChange={(value) => updateSettings("confidenceThreshold", value)}
        step={0.01}
        value={settings.confidenceThreshold}
        valueLabel={`${Math.round(settings.confidenceThreshold * 100)}%`}
      />
    </section>
  );
}

function SliderControl({
  disabled = false,
  label,
  max,
  min,
  onChange,
  step,
  value,
  valueLabel,
}: {
  readonly disabled?: boolean;
  readonly label: string;
  readonly max: number;
  readonly min: number;
  readonly onChange: (value: number) => void;
  readonly step: number;
  readonly value: number;
  readonly valueLabel: string;
}) {
  const progress = max === min ? 0 : ((value - min) / (max - min)) * 100;

  return (
    <label
      className="render-control render-control--slider"
      style={{ "--control-progress": `${progress}%` } as SliderControlStyle}
    >
      <span className="render-control__label">
        <span>{label}</span>
        <strong>{valueLabel}</strong>
      </span>
      <input
        disabled={disabled}
        max={max}
        min={min}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
        step={step}
        type="range"
        value={value}
      />
    </label>
  );
}

type SliderControlStyle = CSSProperties & {
  readonly "--control-progress": string;
};

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}
