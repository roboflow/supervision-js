import type {
  ChangeEvent,
  CSSProperties,
  PointerEvent as ReactPointerEvent,
} from "react";
import { useEffect, useRef, useState } from "react";
import {
  MediaRendererPlaybackState,
  type DetectionBufferState,
} from "supervision-js";
import { formatTimeRange } from "../format";
import type { TimelineRange } from "../session/demo-session-types";

export function TimelineView({
  activeDetectionFrameTime,
  currentTime,
  detectionBuffer,
  disabled,
  duration,
  normalizedRanges = [],
  onSeek,
  playbackState,
  processedRanges = [],
  processingRanges = [],
}: {
  readonly activeDetectionFrameTime: number | null;
  readonly currentTime: number;
  readonly detectionBuffer: DetectionBufferState | null;
  readonly disabled: boolean;
  readonly duration: number | null;
  readonly normalizedRanges?: readonly TimelineRange[];
  readonly onSeek: (time: number) => void;
  readonly playbackState: MediaRendererPlaybackState | null;
  readonly processedRanges?: readonly TimelineRange[];
  readonly processingRanges?: readonly TimelineRange[];
}) {
  const mediaDuration = duration !== null && duration > 0 ? duration : null;
  const timelineCurrentTime = useSmoothTimelineCurrentTime({
    currentTime,
    disabled,
    duration: mediaDuration,
    playbackState,
  });
  const visualDuration =
    mediaDuration ??
    Math.max(
      timelineCurrentTime,
      detectionBuffer?.bufferEndTime ?? 0,
      detectionBuffer?.requestedEndTime ?? 0,
      activeDetectionFrameTime ?? 0,
      getMaxRangeEnd(normalizedRanges),
      getMaxRangeEnd(processedRanges),
      getMaxRangeEnd(processingRanges),
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
  const processedRangeStyles = createSegmentStyles(
    processedRanges,
    visualDuration,
  );
  const processingRangeStyles = createSegmentStyles(
    processingRanges,
    visualDuration,
  );
  const normalizedRangeStyles = createSegmentStyles(
    normalizedRanges,
    visualDuration,
  );
  const showRequestedRange =
    requestedRange !== null &&
    !sameRange(
      detectionBuffer?.requestedStartTime ?? null,
      detectionBuffer?.requestedEndTime ?? null,
      detectionBuffer?.bufferStartTime ?? null,
      detectionBuffer?.bufferEndTime ?? null,
    );
  const inputMax = mediaDuration ?? visualDuration;
  const inputValue = clamp(timelineCurrentTime, 0, inputMax);
  const playheadLeft = toPercent(timelineCurrentTime, visualDuration);
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
      <div className="timeline-view__legend" aria-hidden="true">
        <span className="timeline-view__chip timeline-view__chip--buffer">
          <span className="timeline-view__chip-dot" />
          Hot predictions{" "}
          <strong>
            {formatTimeRange(
              detectionBuffer?.bufferStartTime ?? null,
              detectionBuffer?.bufferEndTime ?? null,
            )}
          </strong>
        </span>
        <span className="timeline-view__chip timeline-view__chip--requested">
          <span className="timeline-view__chip-dot" />
          Requested{" "}
          <strong>
            {formatTimeRange(
              detectionBuffer?.requestedStartTime ?? null,
              detectionBuffer?.requestedEndTime ?? null,
            )}
          </strong>
        </span>
        <span className="timeline-view__chip timeline-view__chip--processed">
          <span className="timeline-view__chip-dot" />
          Has detections
        </span>
        <span className="timeline-view__chip timeline-view__chip--normalized">
          <span className="timeline-view__chip-dot" />
          Normalized
        </span>
        <span className="timeline-view__chip timeline-view__chip--processing">
          <span className="timeline-view__chip-dot" />
          Running inference
        </span>
      </div>

      <div className="timeline-view__scrubber">
        <div className="timeline-view__lanes" aria-hidden="true">
          <div className="timeline-view__lane timeline-view__lane--normalization">
            {normalizedRangeStyles.map(({ key, style }) => (
              <span
                className="timeline-view__segment timeline-view__segment--normalized"
                key={key}
                style={style}
              />
            ))}
          </div>
          <div className="timeline-view__lane timeline-view__lane--detections">
            {processedRangeStyles.map(({ key, style }) => (
              <span
                className="timeline-view__segment timeline-view__segment--processed"
                key={key}
                style={style}
              />
            ))}
            {processingRangeStyles.map(({ key, style }) => (
              <span
                className="timeline-view__segment timeline-view__segment--processing"
                key={key}
                style={style}
              />
            ))}
          </div>
        </div>
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
          <span
            className="timeline-view__knob"
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
    </div>
  );
}

interface SmoothTimelineCurrentTimeOptions {
  readonly currentTime: number;
  readonly disabled: boolean;
  readonly duration: number | null;
  readonly playbackState: MediaRendererPlaybackState | null;
}

interface TimelineClockAnchor {
  readonly mediaTime: number;
  readonly performanceTime: number;
}

const TIMELINE_DISCONTINUITY_THRESHOLD_SECONDS = 0.25;
const TIMELINE_RENDER_EPSILON_SECONDS = 0.001;

function useSmoothTimelineCurrentTime({
  currentTime,
  disabled,
  duration,
  playbackState,
}: SmoothTimelineCurrentTimeOptions) {
  const isPlaying = playbackState === MediaRendererPlaybackState.Playing;
  const [timelineCurrentTime, setTimelineCurrentTime] = useState(currentTime);
  const timelineCurrentTimeRef = useRef(currentTime);
  const anchorRef = useRef<TimelineClockAnchor>({
    mediaTime: currentTime,
    performanceTime: performance.now(),
  });
  const lastAuthoritativeTimeRef = useRef(currentTime);

  const updateTimelineCurrentTime = (nextCurrentTime: number) => {
    timelineCurrentTimeRef.current = nextCurrentTime;
    setTimelineCurrentTime((previousCurrentTime) =>
      Math.abs(previousCurrentTime - nextCurrentTime) <
      TIMELINE_RENDER_EPSILON_SECONDS
        ? previousCurrentTime
        : nextCurrentTime,
    );
  };

  useEffect(() => {
    const now = performance.now();
    const previousAuthoritativeTime = lastAuthoritativeTimeRef.current;
    const currentVisualTime = timelineCurrentTimeRef.current;
    const jumpedBackward =
      currentTime < previousAuthoritativeTime - TIMELINE_RENDER_EPSILON_SECONDS;
    const driftedFromAuthority =
      Math.abs(currentTime - currentVisualTime) >
      TIMELINE_DISCONTINUITY_THRESHOLD_SECONDS;

    lastAuthoritativeTimeRef.current = currentTime;
    anchorRef.current = {
      mediaTime: currentTime,
      performanceTime: now,
    };

    if (!isPlaying || disabled || jumpedBackward || driftedFromAuthority) {
      updateTimelineCurrentTime(currentTime);
    }
  }, [currentTime, disabled, isPlaying]);

  useEffect(() => {
    if (!isPlaying || disabled) {
      return;
    }

    let animationFrameHandle: number | undefined;
    const tick = (now: number) => {
      const anchor = anchorRef.current;
      const elapsedSeconds = Math.max(0, (now - anchor.performanceTime) / 1000);

      updateTimelineCurrentTime(
        clampTimelineTime(anchor.mediaTime + elapsedSeconds, duration),
      );
      animationFrameHandle = window.requestAnimationFrame(tick);
    };

    animationFrameHandle = window.requestAnimationFrame(tick);

    return () => {
      if (animationFrameHandle !== undefined) {
        window.cancelAnimationFrame(animationFrameHandle);
      }
    };
  }, [disabled, duration, isPlaying]);

  return timelineCurrentTime;
}

function clampTimelineTime(time: number, duration: number | null) {
  if (duration === null) {
    return Math.max(0, time);
  }

  return clamp(time, 0, duration);
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

interface StyledTimelineRange {
  readonly key: string;
  readonly style: TimelineRangeStyle;
}

function createSegmentStyles(
  ranges: readonly TimelineRange[],
  duration: number,
): StyledTimelineRange[] {
  return ranges.flatMap((range, index) => {
    const style = createRangeStyle({
      duration,
      endTime: range.endTime,
      startTime: range.startTime,
    });

    return style
      ? [
          {
            key: `${index}-${range.startTime}-${range.endTime}`,
            style,
          },
        ]
      : [];
  });
}

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

function getMaxRangeEnd(ranges: readonly TimelineRange[]) {
  return ranges.reduce(
    (maxEndTime, range) => Math.max(maxEndTime, range.endTime),
    0,
  );
}

function toPercent(time: number, duration: number) {
  return `${clamp(time / duration, 0, 1) * 100}%`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
