import { memo } from "react";
import {
  type MediaRendererState,
  type RenderPreparationDiagnostics,
} from "supervision";
import { formatExactTime, formatInteger, formatMilliseconds } from "../format";
import { selectPreparedWindowArtifact } from "../render-preparation";

export const PerformanceStrip = memo(function PerformanceStrip({
  renderPreparationDiagnostics,
  rendererState,
}: {
  readonly renderPreparationDiagnostics: RenderPreparationDiagnostics | null;
  readonly rendererState: MediaRendererState | null;
}) {
  const preparedWindowArtifact = selectPreparedWindowArtifact(
    renderPreparationDiagnostics,
  );
  const frameTime = rendererState?.lastFrameRenderTimings?.totalMs ?? null;
  const preparedAheadSeconds =
    preparedWindowArtifact?.preparedAheadSeconds ?? null;
  const preparedAheadFrames =
    preparedWindowArtifact?.preparedAheadFrameCount ?? null;
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
          preparedAheadSeconds !== null && preparedAheadSeconds < 2
            ? "warn"
            : "good"
        }
        value={
          preparedAheadSeconds === null
            ? "-"
            : `${formatExactTime(preparedAheadSeconds)} · ${formatInteger(
                preparedAheadFrames ?? 0,
              )} frames`
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
