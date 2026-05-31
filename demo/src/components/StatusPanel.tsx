import type { ReactNode } from "react";
import {
  MediaRendererPlaybackState,
  RenderPreparationArtifactKind,
  type MediaRendererState,
  type MediaSessionState,
  type MediaSourceState,
  type RenderPreparationDiagnostics,
} from "supervision-js";
import type {
  BasketballSampleDetectionSourceSummary,
  BasketballSampleSummary,
} from "../fixtures/basketball-sample";
import {
  formatExactTime,
  formatInteger,
  formatTime,
  formatTimeRange,
} from "../format";
import { Readout } from "./Readout";

export interface StatusPanelMediaState {
  readonly errorMessage: string | null;
  readonly status: string;
}

export interface StatusPanelDetectionSourceState {
  readonly datasetId: string | null;
  readonly errorMessage: string | null;
  readonly sourceSummary: BasketballSampleDetectionSourceSummary | null;
  readonly status: string;
}

export function StatusPanel({
  detectionSourceState,
  errorMessage,
  fixtureSummary,
  mediaState,
  playbackState,
  renderPreparationDiagnostics,
  rendererState,
  sessionState,
  sourceState,
}: {
  readonly detectionSourceState: StatusPanelDetectionSourceState;
  readonly errorMessage: string | null;
  readonly fixtureSummary: BasketballSampleSummary | null;
  readonly mediaState: StatusPanelMediaState;
  readonly playbackState: MediaRendererPlaybackState | null;
  readonly renderPreparationDiagnostics: RenderPreparationDiagnostics | null;
  readonly rendererState: MediaRendererState | null;
  readonly sessionState: MediaSessionState | null;
  readonly sourceState: MediaSourceState | null;
}) {
  const rendererErrorMessage =
    !errorMessage &&
    rendererState?.playbackState === MediaRendererPlaybackState.Error
      ? (rendererState.source.errorMessage ??
        rendererState.detectionBuffer.errorMessage ??
        "Unable to decode media with Mediabunny.")
      : null;
  const hasErrors =
    Boolean(errorMessage) ||
    Boolean(rendererErrorMessage) ||
    Boolean(mediaState.errorMessage) ||
    Boolean(detectionSourceState.errorMessage);
  const maskFrameArtifact = renderPreparationDiagnostics?.artifacts.find(
    (artifact) => artifact.kind === RenderPreparationArtifactKind.MaskFrame,
  );

  return (
    <section className="status-panel" aria-label="Renderer status">
      <StatusGroup title="Playback">
        <Readout
          label="Source"
          value={fixtureSummary?.fixtureName ?? "loading"}
        />
        <Readout label="State" value={playbackState ?? "-"} />
        <Readout
          label="Detection Frame"
          value={
            rendererState
              ? rendererState.activeDetectionFrameIndex === null
                ? "none"
                : `#${formatInteger(rendererState.activeDetectionFrameIndex)}`
              : "-"
          }
        />
        <Readout
          label="Presented"
          value={String(rendererState?.presentedFrames ?? "-")}
        />
        <Readout
          label="Detections"
          value={
            rendererState
              ? rendererState.activeDetectionFrameTime === null
                ? `none | ${rendererState.activeDetectionCount} detections`
                : `${formatExactTime(
                    rendererState.activeDetectionFrameTime,
                  )} | ${rendererState.activeDetectionCount} detections`
              : "-"
          }
        />
        <Readout
          label="Buffer"
          value={rendererState?.detectionBuffer.status ?? "-"}
        />
        <Readout
          label="Loaded"
          value={
            rendererState
              ? `${formatTimeRange(
                  rendererState.detectionBuffer.bufferStartTime,
                  rendererState.detectionBuffer.bufferEndTime,
                )} | ${formatInteger(
                  rendererState.detectionBuffer.frameCount,
                )} frames | ${formatInteger(
                  rendererState.detectionBuffer.detectionCount,
                )} detections`
              : "-"
          }
        />
        <Readout
          label="Requested"
          value={
            rendererState
              ? formatTimeRange(
                  rendererState.detectionBuffer.requestedStartTime,
                  rendererState.detectionBuffer.requestedEndTime,
                )
              : "-"
          }
        />
      </StatusGroup>

      <StatusGroup title="Cold Source">
        <Readout
          label="Cold Source"
          value={
            detectionSourceState.sourceSummary
              ? `${detectionSourceState.status} | ${detectionSourceState.datasetId}`
              : detectionSourceState.status
          }
        />
        <Readout
          label="Source Chunks"
          value={
            detectionSourceState.sourceSummary
              ? `${formatInteger(
                  detectionSourceState.sourceSummary.chunkCount,
                )} x ${formatTime(
                  detectionSourceState.sourceSummary.chunkDurationSeconds,
                )}`
              : "-"
          }
        />
        <Readout
          label="Detections"
          value={
            fixtureSummary
              ? `${formatInteger(fixtureSummary.frameCount)} frames | ${formatInteger(
                  fixtureSummary.detectionCount,
                )} detections`
              : "loading"
          }
        />
        <Readout
          label="Missing"
          value={
            fixtureSummary
              ? fixtureSummary.missingFrameIndexes.length === 0
                ? "none"
                : fixtureSummary.missingFrameIndexes.join(", ")
              : "-"
          }
        />
      </StatusGroup>

      <StatusGroup title="Render Prep">
        <Readout
          label="Execution"
          value={renderPreparationDiagnostics?.executionMode ?? "-"}
        />
        <Readout
          label="Worker"
          value={renderPreparationDiagnostics?.workerStatus ?? "-"}
        />
        <Readout
          label="Prepared Masks"
          value={
            maskFrameArtifact
              ? formatInteger(maskFrameArtifact.preparedCount)
              : "-"
          }
        />
        <Readout
          label="Pending Masks"
          value={
            maskFrameArtifact
              ? formatInteger(maskFrameArtifact.pendingCount)
              : "-"
          }
        />
        <Readout
          label="Ready Ahead"
          value={
            maskFrameArtifact
              ? `${formatInteger(
                  maskFrameArtifact.preparedAheadFrameCount ?? 0,
                )} frames | ${formatExactTime(
                  maskFrameArtifact.preparedAheadSeconds ?? 0,
                )}`
              : "-"
          }
        />
        <Readout
          label="Mask Window"
          value={
            maskFrameArtifact
              ? `${formatInteger(maskFrameArtifact.prefetchCount ?? 0)} prefetch | ${formatInteger(
                  maskFrameArtifact.maxPreparedCount ?? 0,
                )} cache`
              : "-"
          }
        />
        <Readout
          label="Mask Queue"
          value={
            maskFrameArtifact
              ? `${formatInteger(maskFrameArtifact.pendingCount)} / ${formatInteger(
                  maskFrameArtifact.maxPendingCount ?? 0,
                )} pending | ${formatInteger(
                  maskFrameArtifact.scheduleBatchSize ?? 0,
                )} batch`
              : "-"
          }
        />
        <Readout
          label="Active Mask"
          value={maskFrameArtifact?.activeFrame?.status ?? "-"}
        />
        {renderPreparationDiagnostics?.message ? (
          <Readout
            label="Message"
            value={renderPreparationDiagnostics.message}
          />
        ) : null}
      </StatusGroup>

      <StatusGroup title="Session">
        <Readout label="State" value={sessionState?.status ?? "-"} />
        <Readout
          label="Activities"
          value={
            sessionState
              ? sessionState.activities.length === 0
                ? "none"
                : sessionState.activities
                    .map((activity) => activity.label)
                    .join(" | ")
              : "-"
          }
        />
      </StatusGroup>

      <StatusGroup title="Media Source">
        <Readout
          label="Size"
          value={
            rendererState?.mediaWidth && rendererState.mediaHeight
              ? `${rendererState.mediaWidth} x ${rendererState.mediaHeight}`
              : "-"
          }
        />
        <Readout
          label="Source"
          value={
            sourceState
              ? [
                  sourceState.status,
                  sourceState.formatName,
                  sourceState.duration === null
                    ? null
                    : `${sourceState.duration.toFixed(2)}s`,
                  sourceState.primaryVideoWidth &&
                  sourceState.primaryVideoHeight
                    ? `${sourceState.primaryVideoWidth} x ${sourceState.primaryVideoHeight}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" | ")
              : "-"
          }
        />
        <Readout label="Media" value={mediaState.status} />
        <Readout
          label="Inference"
          value={
            fixtureSummary
              ? `${fixtureSummary.inferenceLabel} ${formatInteger(
                  fixtureSummary.inferenceFrameRate,
                )} fps | compressed RLE masks ${formatInteger(
                  fixtureSummary.maskWidth,
                )} x ${formatInteger(fixtureSummary.maskHeight)}`
              : "-"
          }
        />
        <Readout label="Audio" value="video-only source" />
      </StatusGroup>

      {hasErrors ? (
        <StatusGroup title="Errors">
          {mediaState.errorMessage ? (
            <Readout
              label="Media Error"
              tone="danger"
              value={mediaState.errorMessage}
            />
          ) : null}
          {detectionSourceState.errorMessage ? (
            <Readout
              label="Source Error"
              tone="danger"
              value={detectionSourceState.errorMessage}
            />
          ) : null}
          {errorMessage ? (
            <Readout label="Error" tone="danger" value={errorMessage} />
          ) : null}
          {rendererErrorMessage ? (
            <Readout label="Error" tone="danger" value={rendererErrorMessage} />
          ) : null}
        </StatusGroup>
      ) : null}
    </section>
  );
}

function StatusGroup({
  children,
  title,
}: {
  readonly children: ReactNode;
  readonly title: string;
}) {
  return (
    <section className="status-group" aria-label={title}>
      <h2 className="status-group__title">{title}</h2>
      <div className="status-group__items">{children}</div>
    </section>
  );
}
