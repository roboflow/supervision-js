import type {
  ChangeEvent,
  CSSProperties,
  PointerEvent as ReactPointerEvent,
} from "react";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  MediaRendererPlaybackState,
  type DetectionBufferState,
} from "supervision";
import { formatTime, formatTimeRange, toSourceTimeRange } from "../format";
import type { TimelineRange } from "../session/demo-session-types";
import { TimelineScrubInput } from "./TimelineScrubInput";

const AXIS_TICK_FRACTIONS = [0, 0.25, 0.5, 0.75, 1] as const;
const SHORT_MEDIA_SECONDS = 10;

/** Lanes start below the axis label row and the scrub strip. */
const LANE_ROW_OFFSET = 3;

export function TimelineView({
  activeDetectionFrameTime,
  currentTime,
  detectionBuffer,
  disabled,
  duration,
  onScrub,
  onSeek,
  playbackState,
  processedRanges = [],
  processingRanges = [],
  preparedAheadFrames,
  preparedAheadSeconds,
}: {
  readonly activeDetectionFrameTime: number | null;
  readonly currentTime: number;
  readonly detectionBuffer: DetectionBufferState | null;
  readonly disabled: boolean;
  readonly duration: number | null;
  readonly onScrub: (time: number) => void;
  readonly onSeek: (time: number) => void;
  readonly playbackState: MediaRendererPlaybackState | null;
  readonly processedRanges?: readonly TimelineRange[];
  readonly processingRanges?: readonly TimelineRange[];
  readonly preparedAheadFrames: number | null;
  readonly preparedAheadSeconds: number | null;
}) {
  const mediaDuration = duration !== null && duration > 0 ? duration : null;
  const bufferSourceRange = toSourceTimeRange(
    detectionBuffer?.bufferStartTime ?? null,
    detectionBuffer?.bufferEndTime ?? null,
    mediaDuration,
  );
  const requestedSourceRange = toSourceTimeRange(
    detectionBuffer?.requestedStartTime ?? null,
    detectionBuffer?.requestedEndTime ?? null,
    mediaDuration,
  );
  const { flushSeek, onScrubChange, onScrubEnd, onScrubStart, scrubTime } =
    useTimelineSeekGesture({
      currentTime,
      disabled,
      duration: mediaDuration,
      onScrub,
      onSeek,
    });
  const visualDuration =
    mediaDuration ??
    Math.max(
      currentTime,
      bufferSourceRange.endTime ?? 0,
      requestedSourceRange.endTime ?? 0,
      activeDetectionFrameTime ?? 0,
      currentTime + (preparedAheadSeconds ?? 0),
      getMaxRangeEnd(processedRanges),
      getMaxRangeEnd(processingRanges),
      1,
    );
  const { playheadRef, playheadTime, readPlayheadTime } = useTimelinePlayhead({
    currentTime,
    disabled,
    duration: mediaDuration,
    playbackState,
    scrubTime,
    visualDuration,
  });
  const displayedCurrentTime = scrubTime ?? playheadTime;
  const preparedWindowEndTime =
    preparedAheadSeconds === null
      ? null
      : currentTime + Math.max(0, preparedAheadSeconds);
  const preparedWindowStartTime =
    preparedAheadSeconds === null ? null : currentTime;
  /* A band whose numbers did not move keeps its style object, so React has
   * nothing to write back to the DOM while the player sits paused. */
  const requestedRange = useTimelineRangeStyle(
    visualDuration,
    requestedSourceRange.startTime,
    requestedSourceRange.endTime,
  );
  const bufferRange = useTimelineRangeStyle(
    visualDuration,
    bufferSourceRange.startTime,
    bufferSourceRange.endTime,
  );
  const preparedWindowRange = useTimelineRangeStyle(
    visualDuration,
    preparedWindowStartTime,
    preparedWindowEndTime,
  );
  const processedRangeStyles = useMemo(
    () => createSegmentStyles(processedRanges, visualDuration),
    [processedRanges, visualDuration],
  );
  const processingRangeStyles = useMemo(
    () => createSegmentStyles(processingRanges, visualDuration),
    [processingRanges, visualDuration],
  );
  const showRequestedRange =
    requestedRange !== null &&
    !sameRange(
      requestedSourceRange.startTime,
      requestedSourceRange.endTime,
      bufferSourceRange.startTime,
      bufferSourceRange.endTime,
    );
  const lanes: TimelineLane[] = [
    {
      key: "buffer",
      label: "Hot predictions",
      segments: bufferRange
        ? [{ key: "buffer", style: bufferRange }]
        : EMPTY_SEGMENTS,
      value: bufferRange
        ? formatTimeRange(
            bufferSourceRange.startTime,
            bufferSourceRange.endTime,
          )
        : "none",
      variant: "buffer",
    },
    {
      key: "requested",
      label: "Requested",
      segments:
        showRequestedRange && requestedRange
          ? [{ key: "requested", style: requestedRange }]
          : EMPTY_SEGMENTS,
      value:
        requestedRange === null
          ? "none"
          : showRequestedRange
            ? formatTimeRange(
                requestedSourceRange.startTime,
                requestedSourceRange.endTime,
              )
            : "same as hot",
      variant: "requested",
    },
    {
      key: "prepared",
      label: "Prepared",
      segments: preparedWindowRange
        ? [{ key: "prepared", style: preparedWindowRange }]
        : EMPTY_SEGMENTS,
      value:
        preparedAheadSeconds === null
          ? "unavailable"
          : `+${formatTime(Math.max(0, preparedAheadSeconds))} · ${preparedAheadFrames ?? 0}f`,
      variant: "ready",
    },
    {
      key: "processed",
      label: "Detections",
      segments: processedRangeStyles,
      value: formatRangeExtent(processedRanges, "none"),
      variant: "processed",
    },
    {
      key: "processing",
      label: "Inference",
      segments: processingRangeStyles,
      value: formatRangeExtent(processingRanges, "idle"),
      variant: "processing",
    },
  ];
  const axisTicks = createAxisTicks(mediaDuration);
  const inputMax = mediaDuration ?? visualDuration;
  // The input carries opacity 0: it is the interaction and accessibility
  // surface, never the visible playhead, which is drawn separately. Tracking
  // playback to the frame therefore bought nothing and repainted the whole bar
  // on every commit, so while the picture is moving the value is carried at
  // one-second resolution, which is all a keyboard step or a screen reader
  // needs. Scrubbing and paused positions stay exact.
  const rawInputValue = clamp(displayedCurrentTime, 0, inputMax);
  const inputValue =
    playbackState === MediaRendererPlaybackState.Playing && scrubTime === null
      ? Math.floor(rawInputValue)
      : rawInputValue;
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

  const hoverLabelRef = useRef<HTMLSpanElement>(null);
  const hoverLineRef = useRef<HTMLSpanElement>(null);
  const hoverHalfWidthRef = useRef(0);
  const writtenHoverLabelRef = useRef<string | null>(null);
  const hoverContextRef = useRef({ disabled, mediaDuration });

  useEffect(() => {
    hoverContextRef.current = { disabled, mediaDuration };
  });

  /**
   * A hover preview answers per pointer move, so it writes the label and the
   * guide straight to their elements: the panel's React state stays the scrub
   * gesture's, and hovering repaints nothing else.
   */
  const handleHoverMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const { disabled: isDisabled, mediaDuration: hoverDuration } =
        hoverContextRef.current;

      if (isDisabled || hoverDuration === null) {
        return;
      }

      const rect = event.currentTarget.getBoundingClientRect();
      const offset = clamp(event.clientX - rect.left, 0, rect.width);
      const label = hoverLabelRef.current;

      if (label !== null) {
        const nextLabel = formatTime((offset / rect.width) * hoverDuration);

        if (nextLabel !== writtenHoverLabelRef.current) {
          writtenHoverLabelRef.current = nextLabel;
          label.textContent = nextLabel;
        }

        const halfWidth = hoverHalfWidthRef.current;

        label.style.transform = `translateX(${clamp(
          offset,
          halfWidth,
          Math.max(halfWidth, rect.width - halfWidth),
        )}px) translateX(-50%)`;
      }

      if (hoverLineRef.current !== null) {
        hoverLineRef.current.style.transform = `translateX(${offset}px)`;
      }
    },
    [],
  );
  const handleHoverEnter = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const { disabled: isDisabled, mediaDuration: hoverDuration } =
        hoverContextRef.current;

      if (isDisabled || hoverDuration === null) {
        return;
      }

      const label = hoverLabelRef.current;

      if (label !== null) {
        hoverHalfWidthRef.current = label.offsetWidth / 2;
        label.classList.add("timeline-view__hover--visible");
      }

      hoverLineRef.current?.classList.add("timeline-view__hover-line--visible");
      handleHoverMove(event);
    },
    [handleHoverMove],
  );
  const handleHoverLeave = useCallback(() => {
    hoverLabelRef.current?.classList.remove("timeline-view__hover--visible");
    hoverLineRef.current?.classList.remove(
      "timeline-view__hover-line--visible",
    );
  }, []);

  const gestureRef = useRef({
    flushSeek,
    onScrubChange,
    onScrubEnd,
    onScrubStart,
    readPlayheadTime,
  });

  useEffect(() => {
    gestureRef.current = {
      flushSeek,
      onScrubChange,
      onScrubEnd,
      onScrubStart,
      readPlayheadTime,
    };
  });

  const handleSeek = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    gestureRef.current.onScrubChange(Number(event.currentTarget.value));
  }, []);
  const handleInputFlush = useCallback(() => {
    gestureRef.current.flushSeek();
  }, []);
  const handleInputPointerDown = useCallback(() => {
    gestureRef.current.onScrubStart(gestureRef.current.readPlayheadTime());
  }, []);
  const handleInputPointerUp = useCallback(() => {
    gestureRef.current.onScrubEnd();
  }, []);
  const handleStripPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || mediaDuration === null) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    const nextTime = getPointerTime(event);

    onScrubStart(nextTime);
    onScrubChange(nextTime);
  };
  const handleStripPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    handleHoverMove(event);

    if (event.buttons !== 1) {
      return;
    }

    onScrubChange(getPointerTime(event));
  };
  const handleStripPointerUp = () => {
    onScrubEnd();
  };
  const getPointerTime = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (mediaDuration === null) {
      return 0;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const offset = event.clientX - rect.left;

    return clamp(offset / rect.width, 0, 1) * mediaDuration;
  };

  return (
    <div className="timeline-view">
      <div className="timeline-view__cluster" aria-hidden="true" />
      <div className="timeline-view__axis" aria-hidden="true">
        {axisTicks.length === 0 ? (
          <span className="timeline-view__axis-note">duration unavailable</span>
        ) : (
          axisTicks.map((tick) => (
            <span
              className={`timeline-view__tick timeline-view__tick--${tick.anchor}`}
              key={tick.left}
              style={{ "--timeline-left": tick.left } as TimelineMarkerStyle}
            >
              {tick.label}
            </span>
          ))
        )}
      </div>
      <span
        aria-hidden="true"
        className="timeline-view__hover"
        ref={hoverLabelRef}
      />
      <div
        aria-hidden="true"
        className={stripClassName}
        onPointerDown={handleStripPointer}
        onPointerEnter={handleHoverEnter}
        onPointerLeave={handleHoverLeave}
        onPointerMove={handleStripPointerMove}
        onPointerUp={handleStripPointerUp}
      >
        {activeFrameLeft !== null ? (
          <span
            className="timeline-view__marker timeline-view__marker--active-frame"
            style={
              { "--timeline-left": activeFrameLeft } as TimelineMarkerStyle
            }
          />
        ) : null}
        <span className="timeline-view__hover-line" ref={hoverLineRef} />
      </div>
      <TimelineScrubInput
        disabled={disabled || mediaDuration === null}
        max={inputMax}
        onBlur={handleInputFlush}
        onChange={handleSeek}
        onKeyUp={handleInputFlush}
        onPointerDown={handleInputPointerDown}
        onPointerEnter={handleHoverEnter}
        onPointerLeave={handleHoverLeave}
        onPointerMove={handleHoverMove}
        onPointerUp={handleInputPointerUp}
        value={inputValue}
      />
      {lanes.map((lane, index) => {
        const rowStyle = LANE_ROW_STYLES[index];

        return (
          <Fragment key={lane.key}>
            <span className="timeline-view__lane-head" style={rowStyle}>
              <span className="timeline-view__lane-label">{lane.label}</span>
              <span className="timeline-view__lane-value">{lane.value}</span>
            </span>
            <div
              aria-hidden="true"
              className="timeline-view__lane"
              style={rowStyle}
            >
              {lane.segments.map(({ key, style }) => (
                <span
                  className={`timeline-view__segment timeline-view__segment--${lane.variant}`}
                  key={key}
                  style={style}
                />
              ))}
            </div>
          </Fragment>
        );
      })}
      <span
        aria-hidden="true"
        className="timeline-view__playhead"
        ref={playheadRef}
      >
        <span className="timeline-view__marker timeline-view__marker--playhead" />
        <span className="timeline-view__knob" />
      </span>
    </div>
  );
}

interface TimelinePlayheadOptions {
  readonly currentTime: number;
  readonly disabled: boolean;
  readonly duration: number | null;
  readonly playbackState: MediaRendererPlaybackState | null;
  readonly scrubTime: number | null;
  readonly visualDuration: number;
}

interface TimelineClockAnchor {
  readonly mediaTime: number;
  readonly performanceTime: number;
}

interface TimelinePlayheadClock {
  readonly duration: number | null;
  readonly isPlaying: boolean;
  readonly scrubTime: number | null;
  readonly visualDuration: number;
}

const TIMELINE_PUBLISH_INTERVAL_MS = 100;
/** Playhead step when the track has no measured width yet. */
const PLAYHEAD_MIN_STEP_PERCENT = 0.05;

/**
 * The player reports its time a few times a second, so the playhead is
 * interpolated against the wall clock in between. That interpolation runs at
 * the display's refresh rate: its position goes straight to the element as a
 * composited transform, and React hears the time only as often as the range
 * input's value needs it.
 */
function useTimelinePlayhead({
  currentTime,
  disabled,
  duration,
  playbackState,
  scrubTime,
  visualDuration,
}: TimelinePlayheadOptions) {
  const isPlaying =
    !disabled && playbackState === MediaRendererPlaybackState.Playing;
  const isDocumentVisible = useDocumentVisible();
  const [publishedTime, setPublishedTime] = useState(currentTime);
  const playheadRef = useRef<HTMLSpanElement>(null);
  const anchorRef = useRef<TimelineClockAnchor>({
    mediaTime: currentTime,
    performanceTime: performance.now(),
  });
  const clockRef = useRef<TimelinePlayheadClock>({
    duration,
    isPlaying,
    scrubTime,
    visualDuration,
  });
  const publishedAtRef = useRef(Number.NEGATIVE_INFINITY);
  const writtenPositionRef = useRef<string | null>(null);
  const trackWidthRef = useRef(0);

  const readPlayheadTime = () => {
    const clock = clockRef.current;

    if (clock.scrubTime !== null) {
      return clock.scrubTime;
    }

    const anchor = anchorRef.current;

    if (!clock.isPlaying) {
      return anchor.mediaTime;
    }

    const elapsedSeconds = Math.max(
      0,
      (performance.now() - anchor.performanceTime) / 1000,
    );

    return clampTimelineTime(anchor.mediaTime + elapsedSeconds, clock.duration);
  };

  const writePlayheadPosition = () => {
    const playhead = playheadRef.current;

    if (playhead === null) {
      return;
    }

    // Quantized to half a rendered pixel. A percentage carried to three
    // decimals changes on every display refresh, and each write invalidates
    // style for the whole bar, which was the entire main-thread paint load
    // during playback. Half a pixel is below what the eye can resolve on a
    // playhead moving twenty pixels a second.
    const trackWidth = trackWidthRef.current;
    const stepPercent =
      trackWidth > 0 ? 50 / trackWidth : PLAYHEAD_MIN_STEP_PERCENT;
    const ratio = clamp(
      readPlayheadTime() / clockRef.current.visualDuration,
      0,
      1,
    );
    const stepped = Math.round((ratio * 100) / stepPercent) * stepPercent;
    const position = `${stepped.toFixed(3)}%`;

    if (position === writtenPositionRef.current) {
      return;
    }

    writtenPositionRef.current = position;
    playhead.style.transform = `translateX(${position})`;
  };

  useLayoutEffect(() => {
    anchorRef.current = {
      mediaTime: currentTime,
      performanceTime: performance.now(),
    };
  }, [currentTime, isDocumentVisible, isPlaying]);

  useLayoutEffect(() => {
    clockRef.current = { duration, isPlaying, scrubTime, visualDuration };
    // Read here, where layout has already run. The tick that writes the
    // playhead must never measure, or it forces a layout per frame.
    trackWidthRef.current = playheadRef.current?.offsetWidth ?? 0;
    writePlayheadPosition();
  });

  useEffect(() => {
    if (!isPlaying || !isDocumentVisible) {
      return;
    }

    let animationFrameHandle: number | undefined;
    const tick = () => {
      writePlayheadPosition();

      const now = performance.now();

      if (now - publishedAtRef.current >= TIMELINE_PUBLISH_INTERVAL_MS) {
        publishedAtRef.current = now;
        setPublishedTime(readPlayheadTime());
      }

      animationFrameHandle = window.requestAnimationFrame(tick);
    };

    publishedAtRef.current = Number.NEGATIVE_INFINITY;
    animationFrameHandle = window.requestAnimationFrame(tick);

    return () => {
      if (animationFrameHandle !== undefined) {
        window.cancelAnimationFrame(animationFrameHandle);
      }
    };
  }, [isDocumentVisible, isPlaying]);

  return {
    playheadRef,
    playheadTime: isPlaying ? publishedTime : currentTime,
    readPlayheadTime,
  };
}

function useDocumentVisible() {
  const [isDocumentVisible, setIsDocumentVisible] = useState(
    () => document.visibilityState !== "hidden",
  );

  useEffect(() => {
    const onVisibilityChange = () => {
      setIsDocumentVisible(document.visibilityState !== "hidden");
    };

    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return isDocumentVisible;
}

interface TimelineSeekGestureOptions {
  readonly currentTime: number;
  readonly disabled: boolean;
  readonly duration: number | null;
  readonly onScrub: (time: number) => void;
  readonly onSeek: (time: number) => void;
}

const TIMELINE_SCRUB_SETTLE_EPSILON_SECONDS = 0.05;

/**
 * Splits a timeline drag into the two things a player answers differently:
 * every position the pointer passes through is a scrub, and the position it is
 * released on is a seek. The knob follows the pointer until the player's own
 * time catches up with where the drag ended.
 */
function useTimelineSeekGesture({
  currentTime,
  disabled,
  duration,
  onScrub,
  onSeek,
}: TimelineSeekGestureOptions) {
  const [scrubTime, setScrubTime] = useState<number | null>(null);
  const scrubTimeRef = useRef<number | null>(null);
  /**
   * The gesture outlives the scrub position. The settle effect clears that
   * position as soon as the player reports it reached the drag target, which
   * during a drag happens while the pointer is still down, so a release keyed
   * on the position never fires and the producer is never told the drag ended.
   */
  const gestureActiveRef = useRef(false);

  const moveTo = (nextTime: number) => {
    if (disabled || duration === null) {
      return null;
    }

    const clampedTime = clamp(nextTime, 0, duration);

    scrubTimeRef.current = clampedTime;
    setScrubTime(clampedTime);
    return clampedTime;
  };

  const releaseSeek = () => {
    if (!gestureActiveRef.current || disabled || duration === null) {
      return;
    }

    gestureActiveRef.current = false;
    onSeek(clamp(scrubTimeRef.current ?? currentTime, 0, duration));
  };

  useEffect(() => {
    if (scrubTime === null) {
      return;
    }

    if (
      Math.abs(currentTime - scrubTime) <= TIMELINE_SCRUB_SETTLE_EPSILON_SECONDS
    ) {
      scrubTimeRef.current = null;
      setScrubTime(null);
    }
  }, [currentTime, scrubTime]);

  useEffect(() => {
    if (!disabled && duration !== null) {
      return;
    }

    gestureActiveRef.current = false;
    scrubTimeRef.current = null;
    setScrubTime(null);
  }, [disabled, duration]);

  return {
    flushSeek: releaseSeek,
    onScrubChange(nextTime: number) {
      const clampedTime = moveTo(nextTime);

      if (clampedTime !== null) {
        onScrub(clampedTime);
      }
    },
    onScrubEnd: releaseSeek,
    onScrubStart(nextTime: number) {
      gestureActiveRef.current = true;
      moveTo(nextTime);
    },
    scrubTime,
  };
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

type TimelineRowStyle = CSSProperties & {
  readonly "--timeline-row": string;
};

interface StyledTimelineRange {
  readonly key: string;
  readonly style: TimelineRangeStyle;
}

interface TimelineLane {
  readonly key: string;
  readonly label: string;
  readonly segments: readonly StyledTimelineRange[];
  readonly value: string;
  readonly variant: string;
}

interface TimelineAxisTick {
  readonly anchor: "end" | "middle" | "start";
  readonly label: string;
  readonly left: string;
}

const EMPTY_SEGMENTS: readonly StyledTimelineRange[] = [];

const LANE_ROW_STYLES: readonly TimelineRowStyle[] = [0, 1, 2, 3, 4].map(
  (index) =>
    ({ "--timeline-row": String(index + LANE_ROW_OFFSET) }) as TimelineRowStyle,
);

function createAxisTicks(duration: number | null): TimelineAxisTick[] {
  if (duration === null) {
    return [];
  }

  return AXIS_TICK_FRACTIONS.map((fraction) => ({
    anchor:
      fraction === 0
        ? ("start" as const)
        : fraction === 1
          ? ("end" as const)
          : ("middle" as const),
    label: formatAxisTime(fraction * duration, duration),
    left: `${fraction * 100}%`,
  }));
}

function formatAxisTime(time: number, duration: number) {
  return `${time.toFixed(duration < SHORT_MEDIA_SECONDS ? 1 : 0)}s`;
}

/** Says how much of the media a lane's segments reach across, so a lane whose
 *  bands are too narrow to read still reports what it covers. */
function formatRangeExtent(
  ranges: readonly TimelineRange[],
  emptyLabel: string,
) {
  if (ranges.length === 0) {
    return emptyLabel;
  }

  let startTime = Number.POSITIVE_INFINITY;
  let endTime = Number.NEGATIVE_INFINITY;

  for (const range of ranges) {
    startTime = Math.min(startTime, range.startTime);
    endTime = Math.max(endTime, range.endTime);
  }

  return formatTimeRange(startTime, endTime);
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

/**
 * Positions are quantised well below one device pixel. Two readings of the same
 * edge differ in the last bits of a float often enough that an unrounded
 * percentage rewrites a band, and repaints it, while nothing has moved.
 */
function toPercent(time: number, duration: number) {
  return `${(clamp(time / duration, 0, 1) * 100).toFixed(3)}%`;
}

function useTimelineRangeStyle(
  duration: number,
  startTime: number | null,
  endTime: number | null,
) {
  return useMemo(
    () => createRangeStyle({ duration, endTime, startTime }),
    [duration, endTime, startTime],
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
