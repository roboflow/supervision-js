import type {
  ChangeEvent,
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  RefObject,
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
import { MediaRendererPlaybackState } from "supervision";
import { formatTime, formatTimeRange, toSourceTimeRange } from "../format";
import { DemoEvalHook } from "../eval-hooks";
import {
  readLiveReadouts,
  useLiveReadoutWriter,
  type LiveReadouts,
} from "../hooks/live-readouts";
import type { TimelineRange } from "../session/demo-session-types";
import { DiagnosticLabel } from "./DiagnosticLabel";
import { readLivePreparedWindow } from "./live-readout-format";
import { LiveReadoutText } from "./LiveReadoutText";
import { TimelineScrubInput } from "./TimelineScrubInput";

const AXIS_TICK_FRACTIONS = [0, 0.25, 0.5, 0.75, 1] as const;
const SHORT_MEDIA_SECONDS = 10;

/** Lanes start below the axis label row and the scrub strip. */
const LANE_ROW_OFFSET = 3;

export function TimelineView({
  disabled,
  duration,
  onScrub,
  onSeek,
  processedRanges = [],
  processingRanges = [],
}: {
  readonly disabled: boolean;
  readonly duration: number | null;
  readonly onScrub: (time: number) => void;
  readonly onSeek: (time: number) => void;
  readonly processedRanges?: readonly TimelineRange[];
  readonly processingRanges?: readonly TimelineRange[];
}) {
  const mediaDuration = duration !== null && duration > 0 ? duration : null;
  const {
    flushSeek,
    onScrubChange,
    onScrubEnd,
    onScrubStart,
    pendingSeekTime,
    scrubTime,
  } = useTimelineSeekGesture({
    disabled,
    duration: mediaDuration,
    onScrub,
    onSeek,
  });
  const rangeFloor = useMemo(
    () => Math.max(1, getMaxRangeEnd(processedRanges, processingRanges)),
    [processedRanges, processingRanges],
  );
  const rangeFloorRef = useRef(rangeFloor);
  const readVisualDuration = useCallback(
    (readouts: LiveReadouts) =>
      mediaDuration ?? readSpannedDuration(readouts, rangeFloorRef.current),
    [mediaDuration],
  );

  useEffect(() => {
    rangeFloorRef.current = rangeFloor;
  }, [rangeFloor]);

  const trackWidthRef = useRef(0);
  const { playheadRef, readPlayheadTime, writePlayhead } = useTimelinePlayhead({
    duration: mediaDuration,
    pendingSeekTime,
    readVisualDuration,
    scrubTime,
    trackWidthRef,
  });
  const processedRangeStyles = useMemo(
    () => createSegmentStyles(processedRanges, mediaDuration),
    [mediaDuration, processedRanges],
  );
  const processingRangeStyles = useMemo(
    () => createSegmentStyles(processingRanges, mediaDuration),
    [mediaDuration, processingRanges],
  );
  const axisTicks = createAxisTicks(mediaDuration);
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
        // Centred on the offset, like the label above it and like the playhead
        // marker, whose own rule centres a 2px bar. Anchoring this one by its
        // left edge left it sitting beside the playhead at the same time.
        hoverLineRef.current.style.transform = `translateX(${offset}px) translateX(-50%)`;
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

  const frameMarkRef = useRef<HTMLSpanElement>(null);
  const bandRefs = useTimelineBands();
  const scrubInputRef = useRef<HTMLInputElement>(null);

  useLiveReadoutWriter((readouts) => {
    writePlayhead(readouts, readVisualDuration(readouts));
    writeScrubInputValue(
      scrubInputRef.current,
      readouts,
      resolveTimelineTime(scrubTime, pendingSeekTime, null),
    );
  });

  useLiveReadoutWriter((readouts) => {
    const visualDuration = readVisualDuration(readouts);
    const stepPercent = readPixelStepPercent(trackWidthRef.current);

    writeMarker(
      frameMarkRef.current,
      readouts.activeDetectionFrameTime,
      visualDuration,
      stepPercent,
    );
    writeTimelineBands(bandRefs, readouts, visualDuration, stepPercent);
  }, "geometry");

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
        <span className="timeline-view__frame-mark" ref={frameMarkRef}>
          <span className="timeline-view__marker timeline-view__marker--active-frame" />
        </span>
        <span className="timeline-view__hover-line" ref={hoverLineRef} />
      </div>
      <TimelineScrubInput
        disabled={disabled || mediaDuration === null}
        inputRef={scrubInputRef}
        max={mediaDuration ?? rangeFloor}
        onBlur={handleInputFlush}
        onChange={handleSeek}
        onKeyUp={handleInputFlush}
        onPointerDown={handleInputPointerDown}
        onPointerEnter={handleHoverEnter}
        onPointerLeave={handleHoverLeave}
        onPointerMove={handleHoverMove}
        onPointerUp={handleInputPointerUp}
      />
      {LIVE_LANES.map((lane, index) => (
        <Fragment key={lane.key}>
          <span
            className="timeline-view__lane-head"
            style={LANE_ROW_STYLES[index]}
          >
            <DiagnosticLabel label={lane.label} tooltip={lane.tooltip} />
            <LiveReadoutText
              className="timeline-view__lane-value"
              format={lane.format}
            />
          </span>
          <div
            aria-hidden="true"
            className="timeline-view__lane"
            style={LANE_ROW_STYLES[index]}
          >
            {lane.bands.map((band) => (
              <span
                className={`timeline-view__segment timeline-view__segment--${band.variant}`}
                key={band.key}
                ref={bandRefs[band.key]}
              />
            ))}
          </div>
        </Fragment>
      ))}
      <span className="timeline-view__lane-head" style={LANE_ROW_STYLES[3]}>
        <DiagnosticLabel label="Detections" tooltip={PROCESSED_TOOLTIP} />
        <span className="timeline-view__lane-value">
          {formatRangeExtent(processedRanges, "none")}
        </span>
      </span>
      <div
        aria-hidden="true"
        className="timeline-view__lane"
        style={LANE_ROW_STYLES[3]}
      >
        {processedRangeStyles.map(({ key, style }) => (
          <span
            className="timeline-view__segment timeline-view__segment--processed"
            key={key}
            style={style}
          />
        ))}
      </div>
      <span className="timeline-view__lane-head" style={LANE_ROW_STYLES[4]}>
        <DiagnosticLabel label="Inference" tooltip={PROCESSING_TOOLTIP} />
        <span className="timeline-view__lane-value">
          {formatRangeExtent(processingRanges, "idle")}
        </span>
      </span>
      <div
        aria-hidden="true"
        className="timeline-view__lane"
        style={LANE_ROW_STYLES[4]}
      >
        {processingRangeStyles.map(({ key, style }) => (
          <span
            className="timeline-view__segment timeline-view__segment--processing"
            key={key}
            style={style}
          />
        ))}
      </div>
      <span
        aria-hidden="true"
        className="timeline-view__playhead"
        data-eval={DemoEvalHook.TimelinePlayhead}
        ref={playheadRef}
      >
        <span className="timeline-view__marker timeline-view__marker--playhead" />
        <span className="timeline-view__knob" />
      </span>
    </div>
  );
}

const PROCESSED_TOOLTIP =
  "The stretches that have predictions at all. A bundled clip ships with the whole clip predicted; an uploaded one fills in as the inference server answers.";
const PROCESSING_TOOLTIP =
  "The stretches queued at the inference server right now, still waiting on their predictions. Only an uploaded clip runs inference, so a bundled clip sits idle here.";

type TimelineBandKey =
  "buffer" | "prepared-cooked" | "prepared-target" | "requested";

interface TimelineLiveLane {
  readonly bands: readonly {
    readonly key: TimelineBandKey;
    readonly variant: string;
  }[];
  readonly format: (readouts: LiveReadouts) => string;
  readonly key: string;
  readonly label: string;
  readonly tooltip: string;
}

/**
 * The three lanes whose bands and values move with the picture. Their band
 * elements are always mounted and always written imperatively, so a band
 * appearing or vanishing costs the same frame as one that only moved.
 */
const LIVE_LANES: readonly TimelineLiveLane[] = [
  {
    bands: [{ key: "buffer", variant: "buffer" }],
    format: formatHotBufferRange,
    key: "buffer",
    label: "Hot predictions",
    tooltip:
      "The stretch of the clip whose predictions are already in memory and can be drawn with no further fetch. It rolls along with the playhead, and on a looping clip it wraps past the end into the replay.",
  },
  {
    bands: [{ key: "requested", variant: "requested" }],
    format: formatRequestedRange,
    key: "requested",
    label: "Requested",
    tooltip:
      "The stretch the buffer last asked the prediction source for. It reads “same as hot” once everything asked for has arrived, so a band of its own means a fetch is still outstanding.",
  },
  {
    bands: [
      { key: "prepared-target", variant: "target" },
      { key: "prepared-cooked", variant: "ready" },
    ],
    format: formatPreparedWindow,
    key: "prepared",
    label: "Prepared",
    tooltip:
      "Frames whose masks are already drawn into a texture and waiting, counted forward from the playhead to the first frame that is not. The hollow bar is how far the cook is aiming; it aims much further ahead while playing than while paused, which is why this shrinks the moment you pause.",
  },
];

type TimelineBandRefs = Record<
  TimelineBandKey,
  RefObject<HTMLSpanElement | null>
>;

function useTimelineBands(): TimelineBandRefs {
  const buffer = useRef<HTMLSpanElement>(null);
  const requested = useRef<HTMLSpanElement>(null);
  const cooked = useRef<HTMLSpanElement>(null);
  const target = useRef<HTMLSpanElement>(null);

  return useMemo(
    () => ({
      buffer,
      "prepared-cooked": cooked,
      "prepared-target": target,
      requested,
    }),
    [],
  );
}

function readHotBufferRange(readouts: LiveReadouts) {
  return toSourceTimeRange(
    readouts.detectionBuffer?.bufferStartTime ?? null,
    readouts.detectionBuffer?.bufferEndTime ?? null,
    readouts.duration,
  );
}

function readRequestedRange(readouts: LiveReadouts) {
  return toSourceTimeRange(
    readouts.detectionBuffer?.requestedStartTime ?? null,
    readouts.detectionBuffer?.requestedEndTime ?? null,
    readouts.duration,
  );
}

/**
 * A requested stretch that matches the hot one says nothing a second band could
 * add, and drawing it would put an identical bar under the first.
 */
function hasOwnRequestedBand(readouts: LiveReadouts) {
  const hot = readHotBufferRange(readouts);
  const requested = readRequestedRange(readouts);

  return (
    requested.startTime !== null &&
    requested.endTime !== null &&
    !(
      hot.startTime === requested.startTime && hot.endTime === requested.endTime
    )
  );
}

function formatHotBufferRange(readouts: LiveReadouts) {
  const { endTime, startTime } = readHotBufferRange(readouts);

  return startTime === null || endTime === null
    ? "none"
    : formatTimeRange(startTime, endTime);
}

export function formatRequestedRange(readouts: LiveReadouts) {
  const { endTime, startTime } = readRequestedRange(readouts);

  if (startTime === null || endTime === null) {
    return "none";
  }

  return hasOwnRequestedBand(readouts)
    ? formatTimeRange(startTime, endTime)
    : "same as hot";
}

export function formatPreparedWindow(readouts: LiveReadouts) {
  const prepared = readLivePreparedWindow(readouts);

  return prepared === null
    ? "unavailable"
    : `${prepared.cookedFrameCount}/${prepared.targetFrameCount}f · +${formatTime(prepared.cookedSeconds)}`;
}

function writeTimelineBands(
  bands: TimelineBandRefs,
  readouts: LiveReadouts,
  visualDuration: number,
  stepPercent: number,
) {
  const hot = readHotBufferRange(readouts);
  const requested = readRequestedRange(readouts);
  const prepared = readLivePreparedWindow(readouts);
  const playheadTime = readouts.currentTime;

  writeBand(
    bands.buffer.current,
    hot.startTime,
    hot.endTime,
    visualDuration,
    stepPercent,
  );
  writeBand(
    bands.requested.current,
    hasOwnRequestedBand(readouts) ? requested.startTime : null,
    requested.endTime,
    visualDuration,
    stepPercent,
  );

  /* The hollow target sits under the solid cooked run, so the two read as one
   * bar filling rather than two lanes disagreeing. A cook that has finished
   * everything it aimed for draws only the run: the outline would sit exactly
   * under it, saying nothing. */
  const showTarget =
    prepared !== null && prepared.targetFrameCount > prepared.cookedFrameCount;

  writeBand(
    bands["prepared-target"].current,
    showTarget && playheadTime !== null ? playheadTime : null,
    showTarget && playheadTime !== null
      ? playheadTime + prepared.targetSeconds
      : null,
    visualDuration,
    stepPercent,
  );
  writeBand(
    bands["prepared-cooked"].current,
    prepared !== null ? playheadTime : null,
    prepared !== null && playheadTime !== null
      ? playheadTime + prepared.cookedSeconds
      : null,
    visualDuration,
    stepPercent,
  );
}

/**
 * Where the timeline should say the viewer is.
 *
 * A drag speaks for itself, and a committed seek speaks until its picture
 * arrives. The player's reported time is last because during a seek it still
 * describes the frame on screen, which is where the viewer was, not where they
 * are going.
 */
export function resolveTimelineTime(
  scrubTime: number | null,
  pendingSeekTime: number | null,
  currentTime: number | null,
) {
  return scrubTime ?? pendingSeekTime ?? currentTime;
}

interface TimelinePlayheadOptions {
  readonly duration: number | null;
  readonly pendingSeekTime: number | null;
  readonly readVisualDuration: (readouts: LiveReadouts) => number;
  readonly scrubTime: number | null;
  readonly trackWidthRef: RefObject<number>;
}

interface TimelinePlayheadClock {
  readonly duration: number | null;
  readonly scrubTime: number | null;
  readonly pendingSeekTime: number | null;
}

/** Playhead step when the track has no measured width yet. */
const PLAYHEAD_MIN_STEP_PERCENT = 0.05;

/**
 * The playhead is positioned from the player's own reported time on the frame
 * that reports it, and its position goes straight to the element as a
 * composited transform, so React never hears about it.
 */
function useTimelinePlayhead({
  duration,
  pendingSeekTime,
  readVisualDuration,
  scrubTime,
  trackWidthRef,
}: TimelinePlayheadOptions) {
  const playheadRef = useRef<HTMLSpanElement>(null);
  const clockRef = useRef<TimelinePlayheadClock>({
    duration,
    pendingSeekTime,
    scrubTime,
  });
  const writtenPositionRef = useRef<string | null>(null);

  const readPlayheadTime = () => {
    const clock = clockRef.current;

    const held = resolveTimelineTime(
      clock.scrubTime,
      clock.pendingSeekTime,
      null,
    );

    if (held !== null) {
      return held;
    }

    return clampTimelineTime(
      readLiveReadouts().currentTime ?? 0,
      clock.duration,
    );
  };

  const writePlayhead = (readouts: LiveReadouts, visualDuration: number) => {
    const playhead = playheadRef.current;

    if (playhead === null) {
      return;
    }

    // Quantized to half a rendered pixel. A percentage carried to three
    // decimals changes on every report, and each write invalidates style for
    // the whole bar, which was the entire main-thread paint load during
    // playback. Half a pixel is below what the eye can resolve on a playhead
    // moving twenty pixels a second.
    const stepPercent = readPixelStepPercent(trackWidthRef.current) / 2;
    const clock = clockRef.current;
    const time =
      resolveTimelineTime(clock.scrubTime, clock.pendingSeekTime, null) ??
      clampTimelineTime(readouts.currentTime ?? 0, clock.duration);
    const position = quantizePercent(time, visualDuration, stepPercent);

    if (position === writtenPositionRef.current) {
      return;
    }

    writtenPositionRef.current = position;
    playhead.style.transform = `translateX(${position})`;
  };

  useLayoutEffect(() => {
    clockRef.current = { duration, pendingSeekTime, scrubTime };
    // Read here, where layout has already run. The tick that writes the
    // playhead must never measure, or it forces a layout per frame.
    trackWidthRef.current = playheadRef.current?.offsetWidth ?? 0;

    const readouts = readLiveReadouts();

    writePlayhead(readouts, readVisualDuration(readouts));
  });

  return { playheadRef, readPlayheadTime, writePlayhead };
}

interface TimelineSeekGestureOptions {
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
  disabled,
  duration,
  onScrub,
  onSeek,
}: TimelineSeekGestureOptions) {
  const [scrubTime, setScrubTime] = useState<number | null>(null);
  const scrubTimeRef = useRef<number | null>(null);
  /**
   * Where a committed seek is going, held until the picture arrives. The
   * player's reported time still describes the frame on screen during the wait,
   * so falling back to it would walk the playhead back to where the viewer
   * started, which on a slow source is most of the wait.
   */
  const [pendingSeekTime, setPendingSeekTime] = useState<number | null>(null);
  const pendingSeekRef = useRef<number | null>(null);
  /**
   * The gesture outlives the scrub position. The settle writer clears that
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

    const target = clamp(
      scrubTimeRef.current ?? readLiveReadouts().currentTime ?? 0,
      0,
      duration,
    );

    pendingSeekRef.current = target;
    setPendingSeekTime(target);
    onSeek(target);
  };

  useLiveReadoutWriter((readouts) => {
    const landedOn = (target: number | null) =>
      target !== null &&
      readouts.currentTime !== null &&
      Math.abs(readouts.currentTime - target) <=
        TIMELINE_SCRUB_SETTLE_EPSILON_SECONDS;

    if (landedOn(scrubTimeRef.current)) {
      scrubTimeRef.current = null;
      setScrubTime(null);
    }

    if (landedOn(pendingSeekRef.current)) {
      pendingSeekRef.current = null;
      setPendingSeekTime(null);
    }
  });

  useEffect(() => {
    if (!disabled && duration !== null) {
      return;
    }

    gestureActiveRef.current = false;
    scrubTimeRef.current = null;
    setScrubTime(null);
    pendingSeekRef.current = null;
    setPendingSeekTime(null);
  }, [disabled, duration]);

  return {
    flushSeek: releaseSeek,
    onScrubChange(nextTime: number) {
      const clampedTime = moveTo(nextTime);

      if (clampedTime !== null) {
        // A keyboard step on the slider changes its value with no pointer down,
        // and the scrub below still holds the player for a gesture. Marking it
        // here is what lets the keyup release it; without this the player stays
        // held for a drag nobody is making.
        gestureActiveRef.current = true;
        onScrub(clampedTime);
      }
    },
    onScrubEnd: releaseSeek,
    pendingSeekTime,
    onScrubStart(nextTime: number) {
      gestureActiveRef.current = true;
      moveTo(nextTime);
    },
    scrubTime,
  };
}

/**
 * The input carries opacity 0: it is the interaction and accessibility surface,
 * never the visible playhead, which is drawn separately. Tracking playback to
 * the frame therefore bought nothing and repainted the whole bar, so while the
 * picture is moving the value is carried at one-second resolution, which is all
 * a keyboard step or a screen reader needs. Scrubbing and paused positions stay
 * exact.
 */
function writeScrubInputValue(
  input: HTMLInputElement | null,
  readouts: LiveReadouts,
  scrubTime: number | null,
) {
  if (input === null) {
    return;
  }

  const time = scrubTime ?? readouts.currentTime;

  if (time === null) {
    return;
  }

  const isPlaying =
    readouts.playbackState === MediaRendererPlaybackState.Playing;
  const next = String(
    isPlaying && scrubTime === null ? Math.floor(time) : time,
  );

  if (input.value !== next) {
    input.value = next;
  }
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

interface TimelineAxisTick {
  readonly anchor: "end" | "middle" | "start";
  readonly label: string;
  readonly left: string;
}

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
  duration: number | null,
): StyledTimelineRange[] {
  if (duration === null) {
    return [];
  }

  return ranges.flatMap((range, index) => {
    const style = createRangeStyle(range.startTime, range.endTime, duration);

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

function createRangeStyle(
  startTime: number | null,
  endTime: number | null,
  duration: number,
  stepPercent = REACT_RANGE_STEP_PERCENT,
): TimelineRangeStyle | null {
  if (startTime === null || endTime === null || duration <= 0) {
    return null;
  }

  const start = clamp(startTime, 0, duration);
  const end = clamp(Math.max(start, endTime), 0, duration);

  return {
    "--timeline-left": quantizePercent(start, duration, stepPercent),
    "--timeline-width": quantizePercent(end - start, duration, stepPercent),
  } as TimelineRangeStyle;
}

/** A band with nothing to say is emptied rather than unmounted: taking it out
 *  of the tree would move the writes onto React's schedule. */
function writeBand(
  band: HTMLSpanElement | null,
  startTime: number | null,
  endTime: number | null,
  duration: number,
  stepPercent: number,
) {
  if (band === null) {
    return;
  }

  const style = createRangeStyle(startTime, endTime, duration, stepPercent);

  writeCustomProperties(
    band,
    style === null ? "0%" : style["--timeline-left"],
    style === null ? "0%" : style["--timeline-width"],
  );
}

/** A mark with no frame behind it is hidden rather than unmounted, so React
 *  owns none of its churn. */
function writeMarker(
  marker: HTMLSpanElement | null,
  time: number | null,
  duration: number,
  stepPercent: number,
) {
  if (marker === null) {
    return;
  }

  const visibility = time === null ? "hidden" : "";

  if (marker.style.visibility !== visibility) {
    marker.style.visibility = visibility;
  }

  if (time === null) {
    return;
  }

  const left = quantizePercent(time, duration, stepPercent);

  if (marker.style.getPropertyValue("--timeline-left") !== left) {
    marker.style.setProperty("--timeline-left", left);
  }
}

function writeCustomProperties(
  element: HTMLElement,
  left: string,
  width: string,
) {
  if (element.style.getPropertyValue("--timeline-left") !== left) {
    element.style.setProperty("--timeline-left", left);
  }

  if (element.style.getPropertyValue("--timeline-width") !== width) {
    element.style.setProperty("--timeline-width", width);
  }
}

function getMaxRangeEnd(...rangeLists: readonly (readonly TimelineRange[])[]) {
  let maxEndTime = 0;

  for (const ranges of rangeLists) {
    for (const range of ranges) {
      maxEndTime = Math.max(maxEndTime, range.endTime);
    }
  }

  return maxEndTime;
}

/**
 * What the bar spans before the source reports a duration: everything the lanes
 * are being asked to draw, so a band never runs off the end of a bar that has
 * no end yet.
 */
function readSpannedDuration(readouts: LiveReadouts, rangeFloor: number) {
  const hot = readHotBufferRange(readouts);
  const requested = readRequestedRange(readouts);
  const prepared = readLivePreparedWindow(readouts);
  const currentTime = readouts.currentTime ?? 0;

  return Math.max(
    rangeFloor,
    currentTime,
    hot.endTime ?? 0,
    requested.endTime ?? 0,
    readouts.activeDetectionFrameTime ?? 0,
    currentTime + (prepared?.targetSeconds ?? 0),
  );
}

/** Position step for the bands React still draws, which move only when their
 *  ranges do and so never need a measured track. */
const REACT_RANGE_STEP_PERCENT = 0.05;

function readPixelStepPercent(trackWidth: number) {
  return trackWidth > 0 ? 100 / trackWidth : PLAYHEAD_MIN_STEP_PERCENT;
}

/**
 * Positions are quantised to a rendered pixel. Two readings of the same edge
 * differ in the last bits of a float often enough that an unrounded percentage
 * rewrites a band, and repaints it, while nothing has moved; and an edge that
 * has moved a third of a pixel has not moved anywhere a viewer can see.
 */
function quantizePercent(time: number, duration: number, stepPercent: number) {
  const percent = clamp(time / duration, 0, 1) * 100;

  return `${(Math.round(percent / stepPercent) * stepPercent).toFixed(3)}%`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
