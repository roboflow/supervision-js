import { memo } from "react";
import type { AnnotationAntialiasing } from "supervision";
import {
  defaultDemoRenderQuality,
  formatDemoRenderQualityValue,
  getDemoRenderQualityDescription,
  type DemoRenderQuality,
} from "../session/render-quality";

export const QualityControls = memo(function QualityControls({
  annotationAntialiasing,
  disabled,
  onAnnotationAntialiasingChange,
  onChange,
  quality,
}: {
  readonly annotationAntialiasing: AnnotationAntialiasing;
  readonly disabled: boolean;
  readonly onAnnotationAntialiasingChange: (
    value: AnnotationAntialiasing,
  ) => void;
  readonly onChange: (quality: DemoRenderQuality) => void;
  readonly quality: DemoRenderQuality;
}) {
  return (
    <section className="quality-controls" aria-label="Render quality">
      <header className="inspector-card__header">
        <h2>Quality</h2>
        <span>{getDemoRenderQualityDescription(quality)}</span>
      </header>
      <div className="quality-controls__input-row">
        <label>
          <span>Max DPR</span>
          <input
            disabled={disabled || quality === undefined}
            inputMode="decimal"
            min="0.25"
            onChange={(event) => {
              const value = Number(event.currentTarget.value);

              if (Number.isFinite(value) && value > 0) {
                onChange(value);
              }
            }}
            step="0.25"
            type="number"
            value={quality === undefined ? "" : formatInputValue(quality)}
          />
        </label>
        <label className="quality-controls__toggle">
          <input
            checked={quality === undefined}
            disabled={disabled}
            onChange={(event) => {
              onChange(
                event.currentTarget.checked
                  ? undefined
                  : defaultDemoRenderQuality,
              );
            }}
            type="checkbox"
          />
          <span>No limit</span>
        </label>
      </div>
      <label className="quality-controls__aa">
        <span>Smooth annotation edges</span>
        <select
          aria-label="Smooth annotation edges"
          disabled={disabled}
          onChange={(event) => {
            const option = antialiasOptions.find(
              (option) => option.id === event.currentTarget.value,
            );
            if (option) onAnnotationAntialiasingChange(option.value);
          }}
          value={antialiasOptionId(annotationAntialiasing)}
        >
          {antialiasOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <p className="quality-controls__note">
        {
          antialiasOptions.find(
            (option) => option.id === antialiasOptionId(annotationAntialiasing),
          )?.description
        }
      </p>
    </section>
  );
});

const antialiasOptions: readonly {
  readonly id: string;
  readonly label: string;
  readonly value: AnnotationAntialiasing;
  readonly description: string;
}[] = [
  {
    id: "off",
    label: "Off",
    value: false,
    description:
      "Optional smoothing for annotations, focus and interaction. Video resolution stays unchanged. The choice is kept when changing clips.",
  },
  {
    id: "fxaa",
    label: "FXAA",
    value: true,
    description:
      "Blends annotation edges at output resolution. Label text stays sharp. Mask preview detail is controlled separately in Segmentation.",
  },
  {
    id: "fxaa-2",
    label: "FXAA + 2×",
    value: 2,
    description:
      "Combines FXAA with a 2× capture and finer mask detail. Label text stays sharp. Uses more preparation, cache and GPU memory.",
  },
];

function antialiasOptionId(value: AnnotationAntialiasing): string {
  if (!value) return "off";
  return value === 2 ? "fxaa-2" : "fxaa";
}

function formatInputValue(quality: number) {
  return Number.isInteger(quality)
    ? String(quality)
    : formatDemoRenderQualityValue(quality);
}
