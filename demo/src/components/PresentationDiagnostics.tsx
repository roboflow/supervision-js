import {
  memo,
  useEffect,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { PresentationDiagnosticsSample } from "../diagnostics/presentation-diagnostics";
import type { PresentedFrameRecord } from "../diagnostics/presented-frame-tap";
import type { ReadinessBand } from "../diagnostics/renderer-readiness";
import { formatExactTime, formatInteger } from "../format";
import type { TimelineRange } from "../session/demo-session-types";
import { Readout } from "./Readout";

const POLL_INTERVAL_MS = 250;
const MILLISECONDS_PER_SECOND = 1000;
const UNAVAILABLE = "n/a";

type TimelineMarkerStyle = CSSProperties & {
  readonly "--timeline-left": string;
};

type TimelineRangeStyle = TimelineMarkerStyle & {
  readonly "--timeline-width": string;
};

export const PresentationDiagnostics = memo(function PresentationDiagnostics({
  detectionRanges,
  duration,
  readSample,
}: {
  readonly detectionRanges: readonly TimelineRange[];
  readonly duration: number | null;
  readonly readSample: () => PresentationDiagnosticsSample;
}) {
  const sample = usePolledSample(readSample);
  const playheadTime =
    sample.lastPresented === null
      ? null
      : sample.lastPresented.mediaTimeMs / MILLISECONDS_PER_SECOND;

  return (
    <section className="status-group" aria-label="Presented frames">
      <h2 className="status-group__title">Presented Frames</h2>
      <div className="status-group__items">
        <Readout
          label="Presented"
          value={formatInteger(sample.presentedCount)}
        />
        <Readout
          label="Rendered"
          value={
            sample.renderCount === null
              ? UNAVAILABLE
              : formatInteger(sample.renderCount)
          }
        />
        <Readout
          label="Presented/s"
          value={
            sample.presentedPerSecond === null
              ? UNAVAILABLE
              : sample.presentedPerSecond.toFixed(1)
          }
        />
        <Readout
          label="Playhead"
          value={
            playheadTime === null ? UNAVAILABLE : formatExactTime(playheadTime)
          }
        />
        <Readout
          label="Quality"
          value={sample.lastPresented?.quality ?? UNAVAILABLE}
        />
      </div>
      <PresentedFrameTimeline
        detectionRanges={detectionRanges}
        duration={duration}
        playheadTime={playheadTime}
        readinessBands={sample.readinessBands}
        ticks={sample.ticks}
      />
      <div className="presented-timeline__legend">
        <span className="presented-timeline__legend-item presented-timeline__legend-item--exact">
          exact
        </span>
        <span className="presented-timeline__legend-item presented-timeline__legend-item--preview">
          preview
        </span>
      </div>
    </section>
  );
});

function PresentedFrameTimeline({
  detectionRanges,
  duration,
  playheadTime,
  readinessBands,
  ticks,
}: {
  readonly detectionRanges: readonly TimelineRange[];
  readonly duration: number | null;
  readonly playheadTime: number | null;
  readonly readinessBands: readonly ReadinessBand[] | null;
  readonly ticks: readonly PresentedFrameRecord[];
}) {
  if (duration === null || duration <= 0) {
    return (
      <p className="presented-timeline__unavailable">
        media duration {UNAVAILABLE}
      </p>
    );
  }

  const playheadLeft =
    playheadTime === null ? null : toPercent(playheadTime, duration);

  return (
    <div className="presented-timeline" aria-hidden="true">
      <TimelineLane label="Frames" playheadLeft={playheadLeft}>
        {ticks.map((tick, index) => (
          <span
            className={`presented-timeline__tick presented-timeline__tick--${tick.quality}`}
            key={`${index}-${tick.wallTimeMs}`}
            style={
              {
                "--timeline-left": toPercent(
                  tick.mediaTimeMs / MILLISECONDS_PER_SECOND,
                  duration,
                ),
              } as TimelineMarkerStyle
            }
          />
        ))}
      </TimelineLane>
      <TimelineLane label="Detections" playheadLeft={playheadLeft}>
        {detectionRanges.map((range) => (
          <span
            className="presented-timeline__band presented-timeline__band--detections"
            key={`${range.startTime}-${range.endTime}`}
            style={createBandStyle(range.startTime, range.endTime, duration)}
          />
        ))}
      </TimelineLane>
      <TimelineLane label="Prepared" playheadLeft={playheadLeft}>
        {readinessBands === null ? (
          <span className="presented-timeline__unavailable">unavailable</span>
        ) : (
          readinessBands.map((band) => (
            <span
              className="presented-timeline__band presented-timeline__band--prepared"
              key={`${band.startTime}-${band.endTime}`}
              style={createBandStyle(band.startTime, band.endTime, duration)}
            />
          ))
        )}
      </TimelineLane>
    </div>
  );
}

function TimelineLane({
  children,
  label,
  playheadLeft,
}: {
  readonly children: ReactNode;
  readonly label: string;
  readonly playheadLeft: string | null;
}) {
  return (
    <div className="presented-timeline__row">
      <span className="presented-timeline__label">{label}</span>
      <div className="presented-timeline__lane">
        {children}
        {playheadLeft === null ? null : (
          <span
            className="presented-timeline__playhead"
            style={{ "--timeline-left": playheadLeft } as TimelineMarkerStyle}
          />
        )}
      </div>
    </div>
  );
}

function usePolledSample(readSample: () => PresentationDiagnosticsSample) {
  const [sample, setSample] = useState(() => readSample());

  useEffect(() => {
    const handle = window.setInterval(() => {
      setSample(readSample());
    }, POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(handle);
    };
  }, [readSample]);

  return sample;
}

function createBandStyle(
  startTime: number,
  endTime: number,
  duration: number,
): TimelineRangeStyle {
  const start = clamp(startTime, 0, duration);
  const end = clamp(Math.max(start, endTime), 0, duration);

  return {
    "--timeline-left": toPercent(start, duration),
    "--timeline-width": toPercent(end - start, duration),
  } as TimelineRangeStyle;
}

function toPercent(time: number, duration: number) {
  return `${clamp(time / duration, 0, 1) * 100}%`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
