import { memo } from "react";
import {
  KeypointVisibility,
  MediaRendererPlaybackState,
  type DetectionPickResult,
} from "supervision";
import { formatExactTime, formatInteger, formatTime } from "../format";

export const SelectionPanel = memo(function SelectionPanel({
  hoveredDetectionPick,
  onClearSelection,
  playbackState,
  selectedDetectionPick,
}: {
  readonly hoveredDetectionPick: DetectionPickResult | null;
  readonly onClearSelection: () => void;
  readonly playbackState: MediaRendererPlaybackState | null;
  readonly selectedDetectionPick: DetectionPickResult | null;
}) {
  const activePick = selectedDetectionPick ?? hoveredDetectionPick;
  const interactionEnabled =
    playbackState !== MediaRendererPlaybackState.Playing &&
    playbackState !== MediaRendererPlaybackState.Buffering;

  return (
    <section className="selection-panel" aria-label="Detection selection">
      <header className="inspector-card__header">
        <h2>Inspect</h2>
        {selectedDetectionPick ? (
          <button onClick={onClearSelection} type="button">
            Clear
          </button>
        ) : null}
      </header>

      <p className="selection-panel__hint">
        {interactionEnabled
          ? "Hover a detection to preview it. Click to lock selection."
          : "Pause playback to inspect detections."}
      </p>

      <SelectionDetails activePick={activePick} />
    </section>
  );
});

function SelectionDetails({
  activePick,
}: {
  readonly activePick: DetectionPickResult | null;
}) {
  if (!activePick) {
    return (
      <div className="selection-details selection-details--empty">
        <strong>No detection selected</strong>
        <span>Hover or click inside the media after pausing.</span>
      </div>
    );
  }

  const detection = activePick.detection;

  return (
    <div className="selection-details">
      <div className="selection-details__title">
        <strong>{detection.className ?? "detection"}</strong>
        <span>{formatConfidence(detection.confidence)}</span>
      </div>
      <dl className="selection-details__grid">
        <SelectionDatum label="Target" value={formatTarget(activePick)} />
        <SelectionDatum
          label="Picked frame"
          value={
            activePick.frame.frameIndex === undefined
              ? formatTime(activePick.frame.mediaTime)
              : `#${formatInteger(activePick.frame.frameIndex)}`
          }
        />
        <SelectionDatum
          label="Picked at"
          value={formatExactTime(activePick.mediaTime)}
        />
        <SelectionDatum
          label="Point"
          value={`${formatCoordinate(activePick.point.x)}, ${formatCoordinate(
            activePick.point.y,
          )}`}
        />
        <SelectionDatum label="Rect" value={formatRect(detection.rect)} />
        <SelectionDatum
          label="Mask"
          value={
            detection.mask
              ? `${formatInteger(detection.mask.width)} x ${formatInteger(
                  detection.mask.height,
                )}`
              : "-"
          }
        />
        <SelectionDatum
          label="Polygon"
          value={
            detection.polygon
              ? `${formatInteger(detection.polygon.points.length)} points`
              : "-"
          }
        />
        <SelectionDatum
          label="Keypoints"
          value={formatKeypoints(detection.keypoints)}
        />
        <SelectionDatum
          label="ID"
          value={detection.id === undefined ? "-" : String(detection.id)}
        />
      </dl>
    </div>
  );
}

function SelectionDatum({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function formatTarget(pick: DetectionPickResult) {
  return pick.geometryIndex === undefined
    ? pick.target
    : `${pick.target} #${formatInteger(pick.geometryIndex)}`;
}

function formatKeypoints(
  keypoints: DetectionPickResult["detection"]["keypoints"],
) {
  if (!keypoints) {
    return "-";
  }

  const visibleCount = keypoints.points.filter(
    (_, index) =>
      keypoints.visibility?.[index] !== KeypointVisibility.NotLabeled,
  ).length;

  return `${formatInteger(visibleCount)} / ${formatInteger(
    keypoints.points.length,
  )} visible | ${formatInteger(keypoints.edges.length)} edges`;
}

function formatConfidence(confidence: number | undefined) {
  return typeof confidence === "number"
    ? `${Math.round(confidence * 100)}%`
    : "-";
}

function formatRect(rect: DetectionPickResult["detection"]["rect"]) {
  if (!rect) {
    return "-";
  }

  return `${formatCoordinate(rect.x)}, ${formatCoordinate(
    rect.y,
  )}, ${formatCoordinate(rect.width)} x ${formatCoordinate(rect.height)}`;
}

function formatCoordinate(value: number) {
  return value.toFixed(0);
}
