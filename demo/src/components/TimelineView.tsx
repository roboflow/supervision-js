import type {
  ChangeEvent,
  CSSProperties,
  PointerEvent as ReactPointerEvent,
} from "react";
import type { DetectionBufferState } from "supervision-js";

export function TimelineView({
  activeDetectionFrameTime,
  currentTime,
  detectionBuffer,
  disabled,
  duration,
  onSeek,
}: {
  readonly activeDetectionFrameTime: number | null;
  readonly currentTime: number;
  readonly detectionBuffer: DetectionBufferState | null;
  readonly disabled: boolean;
  readonly duration: number | null;
  readonly onSeek: (time: number) => void;
}) {
  const mediaDuration = duration !== null && duration > 0 ? duration : null;
  const visualDuration =
    mediaDuration ??
    Math.max(
      currentTime,
      detectionBuffer?.bufferEndTime ?? 0,
      detectionBuffer?.requestedEndTime ?? 0,
      activeDetectionFrameTime ?? 0,
      1,
    );
  const requestedRange = createRangeStyle({
    duration: visualDuration,
    endTime: detectionBuffer?.requestedEndTime ?? null,
    startTime: detectionBuffer?.requestedStartTime ?? null,
  });
  const bufferRange = createRangeStyle({
    duration: visualDuration,
    endTime: detectionBuffer?.bufferEndTime ?? null,
    startTime: detectionBuffer?.bufferStartTime ?? null,
  });
  const showRequestedRange =
    requestedRange !== null &&
    !sameRange(
      detectionBuffer?.requestedStartTime ?? null,
      detectionBuffer?.requestedEndTime ?? null,
      detectionBuffer?.bufferStartTime ?? null,
      detectionBuffer?.bufferEndTime ?? null,
    );
  const inputMax = mediaDuration ?? visualDuration;
  const inputValue = clamp(currentTime, 0, inputMax);
  const playheadLeft = toPercent(currentTime, visualDuration);
  const playheadProgress = toPercent(inputValue, inputMax);
  const activeFrameLeft =
    activeDetectionFrameTime === null
      ? null
      : toPercent(activeDetectionFrameTime, visualDuration);
  const stripClassName = [
    "timeline-view__strip",
    !disabled && mediaDuration !== null
      ? "timeline-view__strip--interactive"
      : null,
  ]
    .filter(Boolean)
    .join(" ");

  const handleSeek = (event: ChangeEvent<HTMLInputElement>) => {
    onSeek(Number(event.currentTarget.value));
  };
  const handleStripPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || mediaDuration === null) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    seekToPointer(event);
  };
  const handleStripPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.buttons !== 1) {
      return;
    }

    seekToPointer(event);
  };
  const seekToPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (mediaDuration === null) {
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const offset = event.clientX - rect.left;

    onSeek(clamp(offset / rect.width, 0, 1) * mediaDuration);
  };

  return (
    <div className="timeline-view">
      <div
        aria-hidden="true"
        className={stripClassName}
        onPointerDown={handleStripPointer}
        onPointerMove={handleStripPointerMove}
      >
        {showRequestedRange && requestedRange ? (
          <span
            className="timeline-view__range timeline-view__range--requested"
            style={requestedRange}
          />
        ) : null}
        {bufferRange ? (
          <span
            className="timeline-view__range timeline-view__range--buffer"
            style={bufferRange}
          />
        ) : null}
        {activeFrameLeft !== null ? (
          <span
            className="timeline-view__marker timeline-view__marker--active-frame"
            style={
              { "--timeline-left": activeFrameLeft } as TimelineMarkerStyle
            }
          />
        ) : null}
        <span
          className="timeline-view__marker timeline-view__marker--playhead"
          style={{ "--timeline-left": playheadLeft } as TimelineMarkerStyle}
        />
      </div>
      <input
        aria-label="Timeline"
        className="timeline-view__input"
        disabled={disabled || mediaDuration === null}
        max={inputMax}
        min={0}
        onChange={handleSeek}
        step={0.01}
        style={
          { "--timeline-progress": playheadProgress } as TimelineInputStyle
        }
        type="range"
        value={inputValue}
      />
    </div>
  );
}

type TimelineRangeStyle = CSSProperties & {
  readonly "--timeline-left": string;
  readonly "--timeline-width": string;
};

type TimelineMarkerStyle = CSSProperties & {
  readonly "--timeline-left": string;
};

type TimelineInputStyle = CSSProperties & {
  readonly "--timeline-progress": string;
};

function createRangeStyle({
  duration,
  endTime,
  startTime,
}: {
  readonly duration: number;
  readonly endTime: number | null;
  readonly startTime: number | null;
}): TimelineRangeStyle | null {
  if (startTime === null || endTime === null || duration <= 0) {
    return null;
  }

  const start = clamp(startTime, 0, duration);
  const end = clamp(Math.max(start, endTime), 0, duration);

  return {
    "--timeline-left": toPercent(start, duration),
    "--timeline-width": toPercent(end - start, duration),
  } as TimelineRangeStyle;
}

function sameRange(
  firstStart: number | null,
  firstEnd: number | null,
  secondStart: number | null,
  secondEnd: number | null,
) {
  return firstStart === secondStart && firstEnd === secondEnd;
}

function toPercent(time: number, duration: number) {
  return `${clamp(time / duration, 0, 1) * 100}%`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
