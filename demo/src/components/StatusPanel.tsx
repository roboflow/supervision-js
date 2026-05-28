import type { ReactNode } from "react";
import {
  MediaRendererPlaybackState,
  type ColdDetectionFrameStoreWriteSummary,
  type MediaRendererState,
  type MediaSourceState,
} from "supervision-js";
import type { BasketballSampleSummary } from "../fixtures/basketball-sample";
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

export interface StatusPanelColdDetectionState {
  readonly datasetId: string | null;
  readonly errorMessage: string | null;
  readonly status: string;
  readonly writeSummary: ColdDetectionFrameStoreWriteSummary | null;
}

export function StatusPanel({
  coldDetectionState,
  errorMessage,
  fixtureSummary,
  mediaState,
  playbackState,
  rendererState,
  sourceState,
}: {
  readonly coldDetectionState: StatusPanelColdDetectionState;
  readonly errorMessage: string | null;
  readonly fixtureSummary: BasketballSampleSummary | null;
  readonly mediaState: StatusPanelMediaState;
  readonly playbackState: MediaRendererPlaybackState | null;
  readonly rendererState: MediaRendererState | null;
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
    Boolean(coldDetectionState.errorMessage);

  return (
    <section className="status-panel" aria-label="Renderer status">
      <StatusGroup title="Playback">
        <Readout
          label="Fixture"
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

      <StatusGroup title="Cold Store">
        <Readout
          label="Cold Store"
          value={
            coldDetectionState.writeSummary
              ? `${coldDetectionState.status} | ${coldDetectionState.datasetId}`
              : coldDetectionState.status
          }
        />
        <Readout
          label="Cold Chunks"
          value={
            coldDetectionState.writeSummary
              ? `${formatInteger(
                  coldDetectionState.writeSummary.chunkCount,
                )} x ${formatTime(
                  coldDetectionState.writeSummary.chunkDurationSeconds,
                )}`
              : "-"
          }
        />
        <Readout
          label="Fixture Detections"
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
        <Readout label="Audio" value="video-only fixture" />
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
          {coldDetectionState.errorMessage ? (
            <Readout
              label="Cold Error"
              tone="danger"
              value={coldDetectionState.errorMessage}
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
