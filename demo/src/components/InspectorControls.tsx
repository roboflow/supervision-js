import { useState, type CSSProperties, type ReactNode } from "react";

export function ControlSection({
  children,
  enabled,
  evalHook,
  onToggleEnabled,
  title,
  toggleDisabled = false,
}: {
  readonly children: ReactNode;
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
      {open ? (
        <div className="render-control-section__body">{children}</div>
      ) : null}
    </section>
  );
}

export function ToggleControl({
  checked,
  disabled = false,
  evalHook,
  label,
  onChange,
}: {
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly evalHook?: string;
  readonly label: string;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <label
      className="render-control render-control--toggle"
      data-eval={evalHook}
    >
      <input
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
        type="checkbox"
      />
      <span>{label}</span>
    </label>
  );
}

export function SegmentedControl<Value extends string>({
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

export function SliderControl({
  disabled = false,
  evalHook,
  label,
  max,
  min,
  onChange,
  step,
  value,
  valueLabel,
}: {
  readonly disabled?: boolean;
  readonly evalHook?: string;
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
      data-eval={evalHook}
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

/** An empty field reports `undefined`, so a value can be left unset. */
export function NumberControl({
  disabled = false,
  label,
  max,
  min,
  onChange,
  placeholder,
  step,
  value,
}: {
  readonly disabled?: boolean;
  readonly label: string;
  readonly max?: number;
  readonly min?: number;
  readonly onChange: (value: number | undefined) => void;
  readonly placeholder?: string;
  readonly step?: number;
  readonly value: number | undefined;
}) {
  return (
    <label className="render-control render-control--number">
      <span className="render-control__label">
        <span>{label}</span>
      </span>
      <input
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

export function ControlNote({ children }: { readonly children: ReactNode }) {
  return <p className="render-control-note">{children}</p>;
}

type SliderControlStyle = CSSProperties & {
  readonly "--control-progress": string;
};
