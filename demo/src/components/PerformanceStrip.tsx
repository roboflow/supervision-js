import { memo } from "react";
import {
  type MediaRendererState,
  type RenderPreparationDiagnostics,
} from "supervision";
import { formatExactTime, formatInteger, formatMilliseconds } from "../format";
import { selectPreparedWindowArtifact } from "../render-preparation";
import { readPreparedWindow } from "./prepared-window";

/** Below this the cook is close enough to the playhead to run out mid-shot. */
const PREPARED_WINDOW_WARN_SECONDS = 2;

export const PerformanceStrip = memo(function PerformanceStrip({
  renderPreparationDiagnostics,
  rendererState,
  sourceFrameRate,
}: {
  readonly renderPreparationDiagnostics: RenderPreparationDiagnostics | null;
  readonly rendererState: MediaRendererState | null;
  readonly sourceFrameRate: number | null;
}) {
  const preparedWindowArtifact = selectPreparedWindowArtifact(
    renderPreparationDiagnostics,
  );
  const frameTime = rendererState?.lastFrameRenderTimings?.totalMs ?? null;
  const preparedWindow = readPreparedWindow(
    preparedWindowArtifact,
    sourceFrameRate,
  );
  const workerLabel = renderPreparationDiagnostics
    ? `${renderPreparationDiagnostics.executionMode} · ${
        preparedWindowArtifact
          ? `${formatInteger(
              preparedWindowArtifact.inFlightCount ?? 0,
            )}/${formatInteger(preparedWindowArtifact.maxInFlightCount ?? 0)}`
          : "-"
      }`
    : "-";

  return (
    <section className="performance-strip" aria-label="Performance summary">
      <PerformanceMetric
        label="Frame"
        tone={frameTime !== null && frameTime > 16.7 ? "warn" : "good"}
        value={formatMilliseconds(frameTime)}
      />
      <PerformanceMetric label="Workers" value={workerLabel} />
      <PerformanceMetric
        label="Prepared window"
        tone={
          preparedWindow !== null &&
          preparedWindow.cookedSeconds < PREPARED_WINDOW_WARN_SECONDS
            ? "warn"
            : "good"
        }
        value={
          preparedWindow === null
            ? "-"
            : `${formatExactTime(preparedWindow.cookedSeconds)} · ${formatInteger(
                preparedWindow.cookedFrameCount,
              )}/${formatInteger(preparedWindow.targetFrameCount)} frames`
        }
      />
      <PerformanceMetric
        label="Detections"
        value={
          rendererState
            ? formatInteger(rendererState.activeDetectionCount)
            : "-"
        }
      />
      <PerformanceMetric
        label="Buffer"
        value={rendererState?.detectionBuffer.status ?? "-"}
      />
    </section>
  );
});

function PerformanceMetric({
  label,
  tone = "default",
  value,
}: {
  readonly label: string;
  readonly tone?: "default" | "good" | "warn";
  readonly value: string;
}) {
  return (
    <article className={`performance-metric performance-metric--${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}
