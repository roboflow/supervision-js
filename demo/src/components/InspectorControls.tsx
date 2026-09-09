import { Fragment, useState, type CSSProperties, type ReactNode } from "react";

import {
  DemoOptionOrigin,
  demoOptionOriginLabels,
} from "../session/library-defaults";
import { DiagnosticLabel } from "./DiagnosticLabel";

/**
 * `description` sits outside the collapsible body on purpose: a reader deciding
 * which group to open can only decide from what a closed group still shows.
 */
export function ControlSection({
  children,
  description,
  enabled,
  evalHook,
  onToggleEnabled,
  title,
  toggleDisabled = false,
}: {
  readonly children: ReactNode;
  readonly description?: string;
  readonly enabled?: boolean;
  readonly evalHook?: string;
  readonly onToggleEnabled?: (enabled: boolean) => void;
  readonly title: string;
  readonly toggleDisabled?: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <section className="render-control-section">
      <div className="render-control-section__header">
        <button
          aria-expanded={open}
          className="render-control-section__toggle"
          data-eval={evalHook}
          onClick={() => setOpen((current) => !current)}
          type="button"
        >
          <h3>{title}</h3>
          <span
            aria-hidden="true"
            className="render-control-section__chevron"
          />
        </button>
        {onToggleEnabled ? (
          <label className="render-control-section__enable">
            <input
              aria-label={`Show ${title.toLowerCase()}`}
              checked={enabled}
              disabled={toggleDisabled}
              onChange={(event) => onToggleEnabled(event.currentTarget.checked)}
              type="checkbox"
            />
            <span>Show</span>
          </label>
        ) : null}
      </div>
      {description === undefined ? null : (
        <p className="render-control-section__description">{description}</p>
      )}
      {open ? (
        <div className="render-control-section__body">{children}</div>
      ) : null}
    </section>
  );
}

export function ControlSubheading({ children }: { readonly children: string }) {
  return <h4 className="render-control-section__subheading">{children}</h4>;
}

export function ToggleControl({
  checked,
  disabled = false,
  evalHook,
  label,
  libraryDefault,
  onChange,
  optionPath,
  origin,
  tooltip,
}: {
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly evalHook?: string;
  readonly label: string;
  readonly libraryDefault?: string;
  readonly onChange: (checked: boolean) => void;
  readonly optionPath?: string;
  readonly origin?: DemoOptionOrigin;
  readonly tooltip?: string;
}) {
  return (
    <label
      className="render-control render-control--toggle"
      data-eval={evalHook}
    >
      <input
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
        type="checkbox"
      />
      <ControlName
        label={label}
        libraryDefault={libraryDefault}
        optionPath={optionPath}
        origin={origin}
        tooltip={tooltip}
      />
    </label>
  );
}

export function SegmentedControl<Value extends string>({
  disabled = false,
  label,
  libraryDefault,
  onChange,
  optionPath,
  options,
  origin,
  tooltip,
  value,
}: {
  readonly disabled?: boolean;
  readonly label: string;
  readonly libraryDefault?: string;
  readonly onChange: (value: Value) => void;
  readonly optionPath?: string;
  readonly origin?: DemoOptionOrigin;
  readonly options: readonly {
    readonly label: string;
    readonly value: Value;
  }[];
  readonly tooltip?: string;
  readonly value: Value;
}) {
  return (
    <div className="render-control render-control--segmented">
      <span className="render-control__label">
        <ControlName
          label={label}
          libraryDefault={libraryDefault}
          optionPath={optionPath}
          origin={origin}
          tooltip={tooltip}
        />
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

export function SliderControl({
  disabled = false,
  evalHook,
  label,
  libraryDefault,
  max,
  min,
  onChange,
  optionPath,
  origin,
  step,
  tooltip,
  value,
  valueLabel,
}: {
  readonly disabled?: boolean;
  readonly evalHook?: string;
  readonly label: string;
  readonly libraryDefault?: string;
  readonly max: number;
  readonly min: number;
  readonly onChange: (value: number) => void;
  readonly optionPath?: string;
  readonly origin?: DemoOptionOrigin;
  readonly step: number;
  readonly tooltip?: string;
  readonly value: number;
  readonly valueLabel: string;
}) {
  const progress = max === min ? 0 : ((value - min) / (max - min)) * 100;

  return (
    <label
      className="render-control render-control--slider"
      data-eval={evalHook}
      style={{ "--control-progress": `${progress}%` } as SliderControlStyle}
    >
      <span className="render-control__label">
        <ControlName
          label={label}
          libraryDefault={libraryDefault}
          optionPath={optionPath}
          origin={origin}
          tooltip={tooltip}
        />
        <strong>{valueLabel}</strong>
      </span>
      <input
        aria-label={label}
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

/** An empty field reports `undefined`, so a value can be left unset. */
export function NumberControl({
  disabled = false,
  label,
  libraryDefault,
  max,
  min,
  onChange,
  optionPath,
  origin,
  placeholder,
  step,
  tooltip,
  value,
}: {
  readonly disabled?: boolean;
  readonly label: string;
  readonly libraryDefault?: string;
  readonly max?: number;
  readonly min?: number;
  readonly onChange: (value: number | undefined) => void;
  readonly optionPath?: string;
  readonly origin?: DemoOptionOrigin;
  readonly placeholder?: string;
  readonly step?: number;
  readonly tooltip?: string;
  readonly value: number | undefined;
}) {
  return (
    <label className="render-control render-control--number">
      <span className="render-control__label">
        <ControlName
          label={label}
          libraryDefault={libraryDefault}
          optionPath={optionPath}
          origin={origin}
          tooltip={tooltip}
        />
      </span>
      <input
        aria-label={label}
        disabled={disabled}
        inputMode="decimal"
        max={max}
        min={min}
        onChange={(event) => {
          const raw = event.currentTarget.value.trim();
          const parsed = Number(raw);

          onChange(raw === "" || !Number.isFinite(parsed) ? undefined : parsed);
        }}
        placeholder={placeholder}
        step={step}
        type="number"
        value={value === undefined ? "" : String(value)}
      />
    </label>
  );
}

/**
 * A tooltip target inside a wrapping `<label>` lands in the labelled control's
 * accessible name, tooltip sentence and all, which is why every control here
 * carries its own `aria-label`.
 */
function ControlName({
  label,
  libraryDefault,
  optionPath,
  origin,
  tooltip,
}: {
  readonly label: string;
  readonly libraryDefault?: string;
  readonly optionPath?: string;
  readonly origin?: DemoOptionOrigin;
  readonly tooltip?: string;
}) {
  return (
    <span className="render-control__name">
      {tooltip === undefined ? (
        <span>{label}</span>
      ) : (
        <DiagnosticLabel label={label} tooltip={tooltip} />
      )}
      {optionPath === undefined ? null : (
        <code className="render-control__path">
          {breakAtSegments(optionPath)}
        </code>
      )}
      <ControlOrigin libraryDefault={libraryDefault} origin={origin} />
    </span>
  );
}

/**
 * Whether this control is sitting where the library would leave it, and what
 * the library would leave it at when it is not.
 */
function ControlOrigin({
  libraryDefault,
  origin,
}: {
  readonly libraryDefault?: string;
  readonly origin?: DemoOptionOrigin;
}) {
  if (origin === undefined) {
    return null;
  }

  const atLibraryDefault = origin === DemoOptionOrigin.Library;

  return (
    <span
      className={`render-control__origin render-control__origin--${origin}`}
    >
      <span className="render-control__origin-mark" aria-hidden="true" />
      {demoOptionOriginLabels[origin]}
      {atLibraryDefault || libraryDefault === undefined ? null : (
        <span className="render-control__origin-was">
          library {libraryDefault}
        </span>
      )}
    </span>
  );
}

/**
 * A path is one unbreakable run, so a column narrow enough to need a second
 * line breaks it mid-word. `<wbr>` offers the breaks at the dots and adds no
 * character, so a copied path is still the path.
 */
function breakAtSegments(optionPath: string) {
  const segments = optionPath.split(".");

  return segments.map((segment, index) => (
    <Fragment key={`${segment}-${String(index)}`}>
      {segment}
      {index === segments.length - 1 ? null : (
        <>
          .<wbr />
        </>
      )}
    </Fragment>
  ));
}

export function ControlNote({ children }: { readonly children: ReactNode }) {
  return <p className="render-control-note">{children}</p>;
}

type SliderControlStyle = CSSProperties & {
  readonly "--control-progress": string;
};
