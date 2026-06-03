import { BoxShape } from "supervision-js";
import { useState, type CSSProperties } from "react";
import {
  resolveDemoClassStyle,
  type DemoClassStyle,
  type DemoPresentationSettings,
} from "../presentation/demo-presentation";

enum RenderControlsTab {
  Global = "global",
  Classes = "classes",
}

export function RenderControls({
  classNames,
  onChange,
  settings,
}: {
  readonly classNames: readonly string[];
  readonly onChange: (settings: DemoPresentationSettings) => void;
  readonly settings: DemoPresentationSettings;
}) {
  const [activeTab, setActiveTab] = useState(RenderControlsTab.Global);
  const updateSettings = <Key extends keyof DemoPresentationSettings>(
    key: Key,
    value: DemoPresentationSettings[Key],
  ) => {
    onChange({ ...settings, [key]: value });
  };
  const updateClassStyle = (
    className: string,
    key: keyof DemoClassStyle,
    value: number,
  ) => {
    const currentStyle = resolveDemoClassStyle(settings, className);

    onChange({
      ...settings,
      classStyles: {
        ...settings.classStyles,
        [className]: {
          ...currentStyle,
          [key]: value,
        },
      },
    });
  };

  return (
    <section className="render-controls" aria-label="Render controls">
      <div className="render-controls__tabs" role="tablist">
        <button
          aria-pressed={activeTab === RenderControlsTab.Global}
          onClick={() => setActiveTab(RenderControlsTab.Global)}
          type="button"
        >
          Global
        </button>
        <button
          aria-pressed={activeTab === RenderControlsTab.Classes}
          onClick={() => setActiveTab(RenderControlsTab.Classes)}
          type="button"
        >
          Classes
        </button>
      </div>

      {activeTab === RenderControlsTab.Global ? (
        <GlobalRenderControls onChange={updateSettings} settings={settings} />
      ) : (
        <ClassRenderControls
          classNames={classNames}
          onChange={updateClassStyle}
          settings={settings}
        />
      )}
    </section>
  );
}

function GlobalRenderControls({
  onChange,
  settings,
}: {
  readonly onChange: <Key extends keyof DemoPresentationSettings>(
    key: Key,
    value: DemoPresentationSettings[Key],
  ) => void;
  readonly settings: DemoPresentationSettings;
}) {
  return (
    <div className="render-controls__panel render-controls__panel--global">
      <div className="render-controls__toggles">
        <ToggleControl
          checked={settings.boxesEnabled}
          label="Boxes"
          onChange={(checked) => onChange("boxesEnabled", checked)}
        />
        <ToggleControl
          checked={settings.masksEnabled}
          label="Masks"
          onChange={(checked) => onChange("masksEnabled", checked)}
        />
        <ToggleControl
          checked={settings.labelsEnabled}
          label="Labels"
          onChange={(checked) => onChange("labelsEnabled", checked)}
        />
      </div>

      <fieldset className="render-control render-control--shape">
        <legend>Box Shape</legend>
        <div className="render-control__segments">
          <button
            aria-pressed={settings.boxShape === BoxShape.Rect}
            disabled={!settings.boxesEnabled}
            onClick={() => onChange("boxShape", BoxShape.Rect)}
            type="button"
          >
            Rect
          </button>
          <button
            aria-pressed={settings.boxShape === BoxShape.RoundedRect}
            disabled={!settings.boxesEnabled}
            onClick={() => onChange("boxShape", BoxShape.RoundedRect)}
            type="button"
          >
            Rounded
          </button>
        </div>
      </fieldset>

      <SliderControl
        disabled={!settings.boxesEnabled}
        label="Box Stroke"
        max={8}
        min={1}
        onChange={(value) => onChange("boxStrokeWidth", value)}
        step={1}
        value={settings.boxStrokeWidth}
        valueLabel={`${settings.boxStrokeWidth}px`}
      />
      <SliderControl
        disabled={!settings.boxesEnabled}
        label="Box Fill"
        max={0.35}
        min={0}
        onChange={(value) => onChange("boxFillAlpha", value)}
        step={0.01}
        value={settings.boxFillAlpha}
        valueLabel={formatPercent(settings.boxFillAlpha)}
      />
      <SliderControl
        disabled={!settings.masksEnabled}
        label="Mask"
        max={1}
        min={0}
        onChange={(value) => onChange("maskAlpha", value)}
        step={0.01}
        value={settings.maskAlpha}
        valueLabel={formatPercent(settings.maskAlpha)}
      />
      <SliderControl
        disabled={!settings.masksEnabled}
        label="Mask Border"
        max={8}
        min={0}
        onChange={(value) => onChange("maskStrokeWidth", value)}
        step={1}
        value={settings.maskStrokeWidth}
        valueLabel={`${settings.maskStrokeWidth}px`}
      />
      <SliderControl
        disabled={!settings.masksEnabled || settings.maskStrokeWidth === 0}
        label="Border Alpha"
        max={1}
        min={0}
        onChange={(value) => onChange("maskStrokeAlpha", value)}
        step={0.01}
        value={settings.maskStrokeAlpha}
        valueLabel={formatPercent(settings.maskStrokeAlpha)}
      />
      <SliderControl
        disabled={!settings.labelsEnabled}
        label="Label Size"
        max={22}
        min={10}
        onChange={(value) => onChange("labelFontSize", value)}
        step={1}
        value={settings.labelFontSize}
        valueLabel={`${settings.labelFontSize}px`}
      />
      <SliderControl
        disabled={!settings.labelsEnabled}
        label="Label BG"
        max={1}
        min={0}
        onChange={(value) => onChange("labelBackgroundAlpha", value)}
        step={0.01}
        value={settings.labelBackgroundAlpha}
        valueLabel={formatPercent(settings.labelBackgroundAlpha)}
      />
      <SliderControl
        label="Confidence"
        max={1}
        min={0}
        onChange={(value) => onChange("confidenceThreshold", value)}
        step={0.01}
        value={settings.confidenceThreshold}
        valueLabel={`${Math.round(settings.confidenceThreshold * 100)}%`}
      />
    </div>
  );
}

function ClassRenderControls({
  classNames,
  onChange,
  settings,
}: {
  readonly classNames: readonly string[];
  readonly onChange: (
    className: string,
    key: keyof DemoClassStyle,
    value: number,
  ) => void;
  readonly settings: DemoPresentationSettings;
}) {
  return (
    <div className="render-controls__panel render-controls__panel--classes">
      {classNames.map((className) => {
        const style = resolveDemoClassStyle(settings, className);

        return (
          <article className="class-style-card" key={className}>
            <header>
              <span
                className="class-style-card__swatch"
                style={
                  { "--class-color": toHexColor(style.fill) } as ClassColorStyle
                }
              />
              <strong>{className}</strong>
            </header>
            <div className="class-style-card__controls">
              <ColorControl
                label="Fill"
                onChange={(value) => onChange(className, "fill", value)}
                value={style.fill}
              />
              <ColorControl
                label="Border"
                onChange={(value) => onChange(className, "stroke", value)}
                value={style.stroke}
              />
              <ColorControl
                label="Label"
                onChange={(value) =>
                  onChange(className, "labelBackground", value)
                }
                value={style.labelBackground}
              />
              <ColorControl
                label="Text"
                onChange={(value) => onChange(className, "labelText", value)}
                value={style.labelText}
              />
            </div>
          </article>
        );
      })}
    </div>
  );
}

function ToggleControl({
  checked,
  label,
  onChange,
}: {
  readonly checked: boolean;
  readonly label: string;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <label className="render-control render-control--toggle">
      <input
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
        type="checkbox"
      />
      <span>{label}</span>
    </label>
  );
}

function ColorControl({
  label,
  onChange,
  value,
}: {
  readonly label: string;
  readonly onChange: (value: number) => void;
  readonly value: number;
}) {
  return (
    <label className="class-color-control">
      <span>{label}</span>
      <input
        onChange={(event) =>
          onChange(Number.parseInt(event.currentTarget.value.slice(1), 16))
        }
        type="color"
        value={toHexColor(value)}
      />
    </label>
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

type ClassColorStyle = CSSProperties & {
  readonly "--class-color": string;
};

type SliderControlStyle = CSSProperties & {
  readonly "--control-progress": string;
};

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function toHexColor(color: number) {
  return `#${color.toString(16).padStart(6, "0").slice(-6)}`;
}
