import { memo } from "react";
import {
  RenderPreparationArtifactKind,
  type MediaRendererState,
  type RenderPreparationDiagnostics,
} from "supervision-js";
import { formatExactTime, formatInteger, formatMilliseconds } from "../format";

export const PerformanceStrip = memo(function PerformanceStrip({
  renderPreparationDiagnostics,
  rendererState,
}: {
  readonly renderPreparationDiagnostics: RenderPreparationDiagnostics | null;
  readonly rendererState: MediaRendererState | null;
}) {
  const maskFrameArtifact = renderPreparationDiagnostics?.artifacts.find(
    (artifact) => artifact.kind === RenderPreparationArtifactKind.MaskFrame,
  );
  const frameTime = rendererState?.lastFrameRenderTimings?.totalMs ?? null;
  const readyAheadSeconds = maskFrameArtifact?.preparedAheadSeconds ?? null;
  const readyAheadFrames = maskFrameArtifact?.preparedAheadFrameCount ?? null;
  const workerLabel = renderPreparationDiagnostics
    ? `${renderPreparationDiagnostics.executionMode} · ${
        maskFrameArtifact
          ? `${formatInteger(
              maskFrameArtifact.inFlightCount ?? 0,
            )}/${formatInteger(maskFrameArtifact.maxInFlightCount ?? 0)}`
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
        label="Ready ahead"
        tone={
          readyAheadSeconds !== null && readyAheadSeconds < 2 ? "warn" : "good"
        }
        value={
          readyAheadSeconds === null
            ? "-"
            : `${formatExactTime(readyAheadSeconds)} · ${formatInteger(
                readyAheadFrames ?? 0,
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
