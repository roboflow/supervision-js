import { memo, type ReactNode } from "react";
import {
  MediaRendererPlaybackState,
  type DetectionPickResult,
  type MediaRendererState,
  type MediaSessionState,
  type MediaSourceState,
  type RenderPreparationDiagnostics,
} from "supervision";
import type {
  DemoFixtureDetectionSourceSummary,
  DemoFixtureSummary,
} from "../fixtures/demo-fixtures";
import {
  formatExactTime,
  formatInteger,
  formatMilliseconds,
  formatTime,
  formatTimeRange,
  toSourceTimeRange,
} from "../format";
import {
  formatPlaybackRate,
  isPlaybackRateSustained,
} from "../session/playback-rate";
import { selectPreparedWindowArtifact } from "../render-preparation";
import { readPreparedWindow } from "./prepared-window";
import { Readout } from "./Readout";

export interface StatusPanelMediaState {
  readonly errorMessage: string | null;
  readonly status: string;
}

export interface StatusPanelDetectionSourceState {
  readonly datasetId: string | null;
  readonly errorMessage: string | null;
  readonly sourceSummary: DemoFixtureDetectionSourceSummary | null;
  readonly status: string;
}

export const StatusPanel = memo(function StatusPanel({
  detectionSourceState,
  errorMessage,
  fixtureSummary,
  hoveredDetectionPick,
  mediaState,
  playbackState,
  presentedRate,
  renderPreparationDiagnostics,
  rendererState,
  selectedDetectionPick,
  sessionState,
  sourceState,
}: {
  readonly detectionSourceState: StatusPanelDetectionSourceState;
  readonly errorMessage: string | null;
  readonly fixtureSummary: DemoFixtureSummary | null;
  readonly hoveredDetectionPick: DetectionPickResult | null;
  readonly mediaState: StatusPanelMediaState;
  readonly playbackState: MediaRendererPlaybackState | null;
  readonly presentedRate: number | null;
  readonly renderPreparationDiagnostics: RenderPreparationDiagnostics | null;
  readonly rendererState: MediaRendererState | null;
  readonly selectedDetectionPick: DetectionPickResult | null;
  readonly sessionState: MediaSessionState | null;
  readonly sourceState: MediaSourceState | null;
}) {
  const loadedSourceRange = toSourceTimeRange(
    rendererState?.detectionBuffer.bufferStartTime ?? null,
    rendererState?.detectionBuffer.bufferEndTime ?? null,
    sourceState?.duration ?? null,
  );
  const requestedSourceRange = toSourceTimeRange(
    rendererState?.detectionBuffer.requestedStartTime ?? null,
    rendererState?.detectionBuffer.requestedEndTime ?? null,
    sourceState?.duration ?? null,
  );
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
  const preparedWindowArtifact = selectPreparedWindowArtifact(
    renderPreparationDiagnostics,
  );
  const preparedWindow = readPreparedWindow(
    preparedWindowArtifact,
    sourceState?.estimatedFrameRate ?? null,
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
          label="Speed"
          tone={
            rendererState &&
            !isPlaybackRateSustained(rendererState.playbackRate, presentedRate)
              ? "danger"
              : "default"
          }
          value={
            rendererState
              ? `${formatPlaybackRate(rendererState.playbackRate)} commanded | ${
                  presentedRate === null
                    ? "not measured"
                    : `${presentedRate.toFixed(2)}x presented`
                }`
              : "-"
          }
        />
        <Readout
          label="Renderer"
          value={rendererState?.rendererBackend ?? "-"}
        />
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
                  loadedSourceRange.startTime,
                  loadedSourceRange.endTime,
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
                  requestedSourceRange.startTime,
                  requestedSourceRange.endTime,
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
          label="Geometry"
          value={formatGeometrySummary(fixtureSummary)}
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
          label="Prepared Frames"
          value={
            preparedWindowArtifact
              ? formatInteger(preparedWindowArtifact.preparedCount)
              : "-"
          }
        />
        <Readout
          label="Pending Frames"
          value={
            preparedWindowArtifact
              ? formatInteger(preparedWindowArtifact.pendingCount)
              : "-"
          }
        />
        <Readout
          label="Prepared Window"
          value={
            preparedWindow
              ? `${formatInteger(
                  preparedWindow.cookedFrameCount,
                )} frames | ${formatExactTime(preparedWindow.cookedSeconds)}`
              : "-"
          }
        />
        <Readout
          label="Window Limits"
          value={
            preparedWindowArtifact
              ? `${formatInteger(preparedWindowArtifact.prefetchCount ?? 0)} prefetch | ${formatInteger(
                  preparedWindowArtifact.refillThresholdCount ?? 0,
                )} refill | ${formatInteger(
                  preparedWindowArtifact.maxPreparedCount ?? 0,
                )} cache`
              : "-"
          }
        />
        <Readout
          label="Queue"
          value={
            preparedWindowArtifact
              ? `${formatInteger(preparedWindowArtifact.pendingCount)} / ${formatInteger(
                  preparedWindowArtifact.maxPendingCount ?? 0,
                )} pending | ${formatInteger(
                  preparedWindowArtifact.scheduleBatchSize ?? 0,
                )} batch`
              : "-"
          }
        />
        <Readout
          label="Workers"
          value={
            preparedWindowArtifact
              ? `${formatInteger(preparedWindowArtifact.inFlightCount ?? 0)} / ${formatInteger(
                  preparedWindowArtifact.maxInFlightCount ?? 0,
                )} in flight`
              : "-"
          }
        />
        <Readout
          label="Active Frame"
          value={preparedWindowArtifact?.activeFrame?.status ?? "-"}
        />
        {renderPreparationDiagnostics?.message ? (
          <Readout
            label="Message"
            value={renderPreparationDiagnostics.message}
          />
        ) : null}
      </StatusGroup>

      <RenderTimingStatusGroup rendererState={rendererState} />

      <InteractionStatusGroup
        hoveredDetectionPick={hoveredDetectionPick}
        selectedDetectionPick={selectedDetectionPick}
      />

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
          value={formatInferenceSummary(fixtureSummary)}
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
});

function RenderTimingStatusGroup({
  rendererState,
}: {
  readonly rendererState: MediaRendererState | null;
}) {
  const timings = rendererState?.lastFrameRenderTimings ?? null;

  return (
    <StatusGroup title="Frame Time">
      <Readout
        label="Total"
        value={formatMilliseconds(timings?.totalMs ?? null)}
      />
      <Readout
        label="Media"
        value={formatMilliseconds(timings?.mediaUploadMs ?? null)}
      />
      <Readout
        label="Masks"
        value={formatMilliseconds(timings?.maskMs ?? null)}
      />
      <Readout
        label="Boxes"
        value={formatMilliseconds(timings?.boxMs ?? null)}
      />
      <Readout
        label="Labels"
        value={formatMilliseconds(timings?.labelMs ?? null)}
      />
      <Readout
        label="Focus"
        value={formatMilliseconds(timings?.focusMs ?? null)}
      />
      <Readout
        label="Picking"
        value={formatMilliseconds(timings?.interactionMs ?? null)}
      />
      <Readout label="Fit" value={formatMilliseconds(timings?.fitMs ?? null)} />
    </StatusGroup>
  );
}

function InteractionStatusGroup({
  hoveredDetectionPick,
  selectedDetectionPick,
}: {
  readonly hoveredDetectionPick: DetectionPickResult | null;
  readonly selectedDetectionPick: DetectionPickResult | null;
}) {
  const activePick = selectedDetectionPick ?? hoveredDetectionPick;

  return (
    <StatusGroup title="Selection">
      <Readout label="Mode" value="paused-only" />
      <Readout
        label="State"
        value={
          selectedDetectionPick
            ? "selected"
            : hoveredDetectionPick
              ? "hover"
              : "none"
        }
      />
      <Readout label="ID" value={activePick?.detection.id ?? "-"} />
      <Readout label="Class" value={activePick?.detection.className ?? "-"} />
      <Readout
        label="Confidence"
        value={
          typeof activePick?.detection.confidence === "number"
            ? `${Math.round(activePick.detection.confidence * 100)}%`
            : "-"
        }
      />
      <Readout label="Frame" value={formatPickFrame(activePick)} />
      <Readout
        label="Time"
        value={activePick ? formatExactTime(activePick.mediaTime) : "-"}
      />
      <Readout label="Point" value={formatPickPoint(activePick)} />
      <Readout label="Rect" value={formatPickRect(activePick)} />
      <Readout label="Target" value={formatPickTarget(activePick)} />
    </StatusGroup>
  );
}

function formatGeometrySummary(fixtureSummary: DemoFixtureSummary | null) {
  const geometry = fixtureSummary?.geometry;

  if (!geometry) {
    return fixtureSummary?.maskWidth ? "masks + boxes" : "-";
  }

  const parts = [
    [geometry.boxDetectionCount, "boxes"],
    [geometry.maskDetectionCount, "masks"],
    [geometry.polygonDetectionCount, "polygons"],
    [geometry.polylineDetectionCount, "polylines"],
    [geometry.keypointDetectionCount, "keypoint detections"],
  ] as const;

  return (
    parts
      .filter(([count]) => count > 0)
      .map(([count, label]) => `${formatInteger(count)} ${label}`)
      .join(" | ") || "none"
  );
}

function formatInferenceSummary(fixtureSummary: DemoFixtureSummary | null) {
  if (!fixtureSummary) {
    return "-";
  }

  const maskInfo =
    fixtureSummary.maskWidth !== null && fixtureSummary.maskHeight !== null
      ? ` | compressed RLE masks ${formatInteger(
          fixtureSummary.maskWidth,
        )} x ${formatInteger(fixtureSummary.maskHeight)}`
      : "";

  return `${fixtureSummary.inferenceLabel} ${formatInteger(
    fixtureSummary.inferenceFrameRate,
  )} fps${maskInfo}`;
}

function formatPickTarget(pick: DetectionPickResult | null) {
  if (!pick) {
    return "-";
  }

  return pick.geometryIndex === undefined
    ? pick.target
    : `${pick.target} #${formatInteger(pick.geometryIndex)}`;
}

function formatPickFrame(pick: DetectionPickResult | null) {
  if (!pick) {
    return "-";
  }

  return pick.frame.frameIndex === undefined
    ? formatExactTime(pick.frame.mediaTime)
    : `#${formatInteger(pick.frame.frameIndex)}`;
}

function formatPickPoint(pick: DetectionPickResult | null) {
  if (!pick) {
    return "-";
  }

  return `${formatCoordinate(pick.point.x)}, ${formatCoordinate(pick.point.y)}`;
}

function formatPickRect(pick: DetectionPickResult | null) {
  if (!pick?.detection.rect) {
    return "-";
  }

  const rect = pick.detection.rect;

  return `${formatCoordinate(rect.x)}, ${formatCoordinate(
    rect.y,
  )}, ${formatCoordinate(rect.width)} x ${formatCoordinate(rect.height)}`;
}

function formatCoordinate(value: number) {
  return value.toFixed(0);
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
