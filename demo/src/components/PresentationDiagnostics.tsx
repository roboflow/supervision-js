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
    sample.lastPresented === null ? null : sample.lastPresented.mediaTimeS;

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
        <Readout
          label="Frame"
          value={
            sample.lastPresented === null
              ? UNAVAILABLE
              : `#${formatInteger(sample.lastPresented.frameIndex)} | paint ${formatInteger(
                  sample.lastPresented.paintSeq,
                )}`
          }
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

export function PresentedFrameTimeline({
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
        {ticks.map((tick) => (
          <span
            className={`presented-timeline__tick presented-timeline__tick--${tick.quality}`}
            key={tick.paintSeq}
            style={
              {
                "--timeline-left": toPercent(tick.mediaTimeS, duration),
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

/**
 * Whether a poll found the same picture it drew last time. Each sample is
 * assembled fresh, so identity says nothing and the values have to be read.
 *
 * Every record the frames lane draws arrives counted, so the count answers for
 * the lane behind it.
 */
export function presentationSampleUnchanged(
  previous: PresentationDiagnosticsSample,
  next: PresentationDiagnosticsSample,
): boolean {
  return (
    previous.presentedCount === next.presentedCount &&
    previous.presentedPerSecond === next.presentedPerSecond &&
    previous.renderCount === next.renderCount &&
    sameFrame(previous.lastPresented, next.lastPresented) &&
    sameBands(previous.readinessBands, next.readinessBands)
  );
}

function sameFrame(
  previous: PresentedFrameRecord | null,
  next: PresentedFrameRecord | null,
) {
  if (previous === null || next === null) {
    return previous === next;
  }

  return (
    previous.paintSeq === next.paintSeq &&
    previous.frameIndex === next.frameIndex &&
    previous.mediaTimeS === next.mediaTimeS &&
    previous.quality === next.quality
  );
}

function sameBands(
  previous: readonly ReadinessBand[] | null,
  next: readonly ReadinessBand[] | null,
) {
  if (previous === null || next === null) {
    return previous === next;
  }

  return (
    previous.length === next.length &&
    previous.every(
      (band, index) =>
        band.startTime === next[index].startTime &&
        band.endTime === next[index].endTime,
    )
  );
}

function usePolledSample(readSample: () => PresentationDiagnosticsSample) {
  const [sample, setSample] = useState(() => readSample());

  useEffect(() => {
    const handle = window.setInterval(() => {
      setSample((current) => {
        const next = readSample();

        return presentationSampleUnchanged(current, next) ? current : next;
      });
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
