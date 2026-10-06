import { memo } from "react";
import {
  defaultDemoRenderQuality,
  formatDemoRenderQualityValue,
  getDemoRenderQualityDescription,
  type DemoRenderQuality,
} from "../session/render-quality";

export const QualityControls = memo(function QualityControls({
  disabled,
  onChange,
  quality,
}: {
  readonly disabled: boolean;
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
    </section>
  );
});

function formatInputValue(quality: number) {
  return Number.isInteger(quality)
    ? String(quality)
    : formatDemoRenderQualityValue(quality);
}
