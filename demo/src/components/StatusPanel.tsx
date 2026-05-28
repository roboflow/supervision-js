import type { ReactNode } from "react";
import {
  MediaRendererPlaybackState,
  type MediaRendererState,
  type MediaSourceState,
} from "supervision-js";
import type {
  BasketballSampleColdDetectionSource,
  BasketballSampleSummary,
} from "../fixtures/basketball-sample";
import { formatInteger, formatTime, formatTimeRange } from "../format";
import { Readout } from "./Readout";

export interface StatusPanelMediaState {
  readonly errorMessage: string | null;
  readonly status: string;
}

export interface StatusPanelColdDetectionState {
  readonly datasetId: string | null;
  readonly errorMessage: string | null;
  readonly status: string;
  readonly writeSummary:
    | BasketballSampleColdDetectionSource["writeSummary"]
    | null;
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
        <Readout label="Fixture" value="Basketball / Rapid" />
        <Readout label="State" value={playbackState ?? "-"} />
        <Readout
          label="Frames"
          value={String(rendererState?.presentedFrames ?? "-")}
        />
        <Readout
          label="Detections"
          value={
            rendererState
              ? rendererState.activeDetectionFrameTime === null
                ? `none | ${rendererState.activeDetectionCount} detections`
                : `${formatTime(
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
                )} boxes`
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
          label="Fixture Boxes"
          value={
            fixtureSummary
              ? `${formatInteger(fixtureSummary.frameCount)} frames | ${formatInteger(
                  fixtureSummary.detectionCount,
                )} boxes`
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
          value="Rapid 30 fps | compressed RLE masks"
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
