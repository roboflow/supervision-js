import { memo, useState, type CSSProperties, type ReactNode } from "react";
import {
  BoxStrokeAlignment,
  FocusTargetMode,
  LabelPlacement,
  MaskRenderMode,
} from "supervision-js";
import {
  resolveDemoClassStyle,
  type DemoClassStyle,
  type DemoPresentationSettings,
} from "../presentation/demo-presentation";

enum RenderControlsTab {
  Global = "global",
  Classes = "classes",
}

export const RenderControls = memo(function RenderControls({
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
      <header className="inspector-card__header">
        <h2>Style</h2>
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
      </header>

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
});

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
      <ControlSection title="Layers">
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
            checked={settings.polygonsEnabled}
            label="Polygons"
            onChange={(checked) => onChange("polygonsEnabled", checked)}
          />
          <ToggleControl
            checked={settings.keypointsEnabled}
            label="Keypoints"
            onChange={(checked) => onChange("keypointsEnabled", checked)}
          />
          <ToggleControl
            checked={settings.labelsEnabled}
            label="Labels"
            onChange={(checked) => onChange("labelsEnabled", checked)}
          />
          <ToggleControl
            checked={settings.focusEnabled}
            label="Focus"
            onChange={(checked) => onChange("focusEnabled", checked)}
          />
        </div>
      </ControlSection>

      <ControlSection title="Boxes">
        <SegmentedControl
          disabled={!settings.boxesEnabled}
          label="Stroke Align"
          onChange={(value) => onChange("boxStrokeAlignment", value)}
          options={[
            { label: "Inside", value: BoxStrokeAlignment.Inside },
            { label: "Center", value: BoxStrokeAlignment.Center },
            { label: "Outside", value: BoxStrokeAlignment.Outside },
          ]}
          value={settings.boxStrokeAlignment}
        />
        <SliderControl
          disabled={!settings.boxesEnabled}
          label="Radius"
          max={24}
          min={0}
          onChange={(value) => onChange("boxCornerRadius", value)}
          step={1}
          value={settings.boxCornerRadius}
          valueLabel={`${settings.boxCornerRadius}px`}
        />
        <SliderControl
          disabled={!settings.boxesEnabled}
          label="Stroke"
          max={8}
          min={1}
          onChange={(value) => onChange("boxStrokeWidth", value)}
          step={1}
          value={settings.boxStrokeWidth}
          valueLabel={`${settings.boxStrokeWidth}px`}
        />
        <SliderControl
          disabled={!settings.boxesEnabled}
          label="Fill"
          max={0.35}
          min={0}
          onChange={(value) => onChange("boxFillAlpha", value)}
          step={0.01}
          value={settings.boxFillAlpha}
          valueLabel={formatPercent(settings.boxFillAlpha)}
        />
      </ControlSection>

      <ControlSection title="Masks">
        <SegmentedControl
          disabled={!settings.masksEnabled}
          label="Mode"
          onChange={(value) => onChange("maskMode", value)}
          options={[
            { label: "Fill + Border", value: MaskRenderMode.FillAndStroke },
            { label: "Fill", value: MaskRenderMode.FillOnly },
            { label: "Border", value: MaskRenderMode.StrokeOnly },
          ]}
          value={settings.maskMode}
        />
        <SliderControl
          disabled={!settings.masksEnabled}
          label="Opacity"
          max={1}
          min={0}
          onChange={(value) => onChange("maskOpacity", value)}
          step={0.01}
          value={settings.maskOpacity}
          valueLabel={formatPercent(settings.maskOpacity)}
        />
        <SliderControl
          disabled={!settings.masksEnabled}
          label="Border"
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
      </ControlSection>

      <ControlSection title="Polygons">
        <SliderControl
          disabled={!settings.polygonsEnabled}
          label="Stroke"
          max={8}
          min={1}
          onChange={(value) => onChange("polygonStrokeWidth", value)}
          step={1}
          value={settings.polygonStrokeWidth}
          valueLabel={`${settings.polygonStrokeWidth}px`}
        />
        <SliderControl
          disabled={!settings.polygonsEnabled}
          label="Fill"
          max={0.5}
          min={0}
          onChange={(value) => onChange("polygonFillAlpha", value)}
          step={0.01}
          value={settings.polygonFillAlpha}
          valueLabel={formatPercent(settings.polygonFillAlpha)}
        />
      </ControlSection>

      <ControlSection title="Keypoints">
        <SliderControl
          disabled={!settings.keypointsEnabled}
          label="Radius"
          max={12}
          min={2}
          onChange={(value) => onChange("keypointRadius", value)}
          step={1}
          value={settings.keypointRadius}
          valueLabel={`${settings.keypointRadius}px`}
        />
        <SliderControl
          disabled={!settings.keypointsEnabled}
          label="Edge Width"
          max={8}
          min={1}
          onChange={(value) => onChange("keypointEdgeWidth", value)}
          step={1}
          value={settings.keypointEdgeWidth}
          valueLabel={`${settings.keypointEdgeWidth}px`}
        />
      </ControlSection>

      <ControlSection title="Labels">
        <SegmentedControl
          disabled={!settings.labelsEnabled}
          label="Placement"
          onChange={(value) => onChange("labelPlacement", value)}
          options={[
            { label: "Top", value: LabelPlacement.Top },
            { label: "Bottom", value: LabelPlacement.Bottom },
            { label: "Inside Top", value: LabelPlacement.InsideTop },
            { label: "Inside Bottom", value: LabelPlacement.InsideBottom },
            { label: "Center", value: LabelPlacement.Center },
          ]}
          value={settings.labelPlacement}
        />
        <SliderControl
          disabled={!settings.labelsEnabled}
          label="Size"
          max={22}
          min={10}
          onChange={(value) => onChange("labelFontSize", value)}
          step={1}
          value={settings.labelFontSize}
          valueLabel={`${settings.labelFontSize}px`}
        />
        <SliderControl
          disabled={!settings.labelsEnabled}
          label="Background"
          max={1}
          min={0}
          onChange={(value) => onChange("labelBackgroundAlpha", value)}
          step={0.01}
          value={settings.labelBackgroundAlpha}
          valueLabel={formatPercent(settings.labelBackgroundAlpha)}
        />
        <SliderControl
          disabled={!settings.labelsEnabled}
          label="Radius"
          max={16}
          min={0}
          onChange={(value) => onChange("labelCornerRadius", value)}
          step={1}
          value={settings.labelCornerRadius}
          valueLabel={`${settings.labelCornerRadius}px`}
        />
        <SliderControl
          disabled={!settings.labelsEnabled}
          label="Padding X"
          max={16}
          min={0}
          onChange={(value) => onChange("labelPaddingX", value)}
          step={1}
          value={settings.labelPaddingX}
          valueLabel={`${settings.labelPaddingX}px`}
        />
        <SliderControl
          disabled={!settings.labelsEnabled}
          label="Padding Y"
          max={12}
          min={0}
          onChange={(value) => onChange("labelPaddingY", value)}
          step={1}
          value={settings.labelPaddingY}
          valueLabel={`${settings.labelPaddingY}px`}
        />
        <SliderControl
          disabled={!settings.labelsEnabled}
          label="Offset X"
          max={30}
          min={-30}
          onChange={(value) => onChange("labelOffsetX", value)}
          step={1}
          value={settings.labelOffsetX}
          valueLabel={`${settings.labelOffsetX}px`}
        />
        <SliderControl
          disabled={!settings.labelsEnabled}
          label="Offset Y"
          max={30}
          min={-30}
          onChange={(value) => onChange("labelOffsetY", value)}
          step={1}
          value={settings.labelOffsetY}
          valueLabel={`${settings.labelOffsetY}px`}
        />
      </ControlSection>

      <ControlSection title="Filter">
        <SliderControl
          label="Confidence"
          max={1}
          min={0}
          onChange={(value) => onChange("confidenceThreshold", value)}
          step={0.01}
          value={settings.confidenceThreshold}
          valueLabel={`${Math.round(settings.confidenceThreshold * 100)}%`}
        />
      </ControlSection>

      <ControlSection title="Interaction">
        <SliderControl
          label="Hover Fill"
          max={0.5}
          min={0}
          onChange={(value) => onChange("interactionHoverFillAlpha", value)}
          step={0.01}
          value={settings.interactionHoverFillAlpha}
          valueLabel={formatPercent(settings.interactionHoverFillAlpha)}
        />
        <SliderControl
          label="Hover Stroke"
          max={12}
          min={1}
          onChange={(value) => onChange("interactionHoverStrokeWidth", value)}
          step={1}
          value={settings.interactionHoverStrokeWidth}
          valueLabel={`${settings.interactionHoverStrokeWidth}px`}
        />
        <SliderControl
          label="Selected Fill"
          max={0.65}
          min={0}
          onChange={(value) => onChange("interactionSelectedFillAlpha", value)}
          step={0.01}
          value={settings.interactionSelectedFillAlpha}
          valueLabel={formatPercent(settings.interactionSelectedFillAlpha)}
        />
        <SliderControl
          label="Selected Stroke"
          max={16}
          min={1}
          onChange={(value) =>
            onChange("interactionSelectedStrokeWidth", value)
          }
          step={1}
          value={settings.interactionSelectedStrokeWidth}
          valueLabel={`${settings.interactionSelectedStrokeWidth}px`}
        />
      </ControlSection>

      <ControlSection title="Focus">
        <SegmentedControl
          disabled={!settings.focusEnabled}
          label="Target"
          onChange={(value) => onChange("focusTargetMode", value)}
          options={[
            { label: "Selected", value: FocusTargetMode.Selected },
            { label: "Hover", value: FocusTargetMode.Hovered },
            { label: "Both", value: FocusTargetMode.HoveredAndSelected },
          ]}
          value={settings.focusTargetMode}
        />
        <ColorControl
          disabled={!settings.focusEnabled}
          label="Tone"
          onChange={(value) => onChange("focusDimColor", value)}
          value={settings.focusDimColor}
        />
        <SliderControl
          disabled={!settings.focusEnabled}
          label="Dim"
          max={0.8}
          min={0}
          onChange={(value) => onChange("focusDimAlpha", value)}
          step={0.01}
          value={settings.focusDimAlpha}
          valueLabel={formatPercent(settings.focusDimAlpha)}
        />
        <SliderControl
          disabled={!settings.focusEnabled}
          label="Cutout Radius"
          max={36}
          min={0}
          onChange={(value) => onChange("focusCornerRadius", value)}
          step={1}
          value={settings.focusCornerRadius}
          valueLabel={`${settings.focusCornerRadius}px`}
        />
      </ControlSection>
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

function ControlSection({
  children,
  title,
}: {
  readonly children: ReactNode;
  readonly title: string;
}) {
  return (
    <section className="render-control-section">
      <h3>{title}</h3>
      <div className="render-control-section__body">{children}</div>
    </section>
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

function SegmentedControl<Value extends string>({
  disabled = false,
  label,
  onChange,
  options,
  value,
}: {
  readonly disabled?: boolean;
  readonly label: string;
  readonly onChange: (value: Value) => void;
  readonly options: readonly {
    readonly label: string;
    readonly value: Value;
  }[];
  readonly value: Value;
}) {
  return (
    <div className="render-control render-control--segmented">
      <span className="render-control__label">
        <span>{label}</span>
      </span>
      <div className="render-control__segments">
        {options.map((option) => (
          <button
            aria-pressed={option.value === value}
            disabled={disabled}
            key={option.value}
            onClick={() => onChange(option.value)}
            type="button"
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ColorControl({
  disabled = false,
  label,
  onChange,
  value,
}: {
  readonly disabled?: boolean;
  readonly label: string;
  readonly onChange: (value: number) => void;
  readonly value: number;
}) {
  return (
    <label className="class-color-control">
      <span>{label}</span>
      <input
        disabled={disabled}
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
