import { memo, useEffect, useRef, type CSSProperties } from "react";
import type { DiagnosticsSnapshot } from "supervision-js-video-engine";

/**
 * The engine's coverage timeline, lane for lane: GOP heat, what each cache tier
 * holds, where the next sweep would decode, the discovered keyframes, the
 * engine's playhead and the frame it last put out.
 *
 * The two cache lanes are residency, not paints. Playback deliberately writes
 * only the coarse tier, so the exact lane stays still through a watched span
 * even though every frame handed out was a full decode.
 *
 * Every lane and both markers derive from one snapshot, so they cannot disagree
 * about where "now" is. Only the playhead moves at display cadence: it
 * extrapolates the snapshot clock while playing and mutates the line through a
 * ref, so the SVG never re-renders per frame.
 */

const VIEW_WIDTH = 1000;
const LANE_HEIGHT = 14;
const LANE_GAP = 5;
const AXIS_HEIGHT = 18;
const LANE_COUNT = 5;
const VIEW_HEIGHT = AXIS_HEIGHT + LANE_COUNT * (LANE_HEIGHT + LANE_GAP);

const LANE_HEAT = 0;
const LANE_EXACT = 1;
const LANE_PREVIEW = 2;
const LANE_PREFETCH = 3;
const LANE_KEYFRAME = 4;

const MILLISECONDS_PER_SECOND = 1000;

/** A short GOP reads cool, a long one hot, so the eye lands on the regions every
 *  off-anchor scrub pays for without reading a number. */
const HEAT_COOL_SECONDS = 1;
const HEAT_HOT_SECONDS = 6;

/** Keyframes needed before the gaps between them describe the source's GOPs
 *  rather than how far the lazy index happens to have walked. */
const GOP_MIN_SAMPLE = 8;

const AXIS_FRACTIONS = [0, 0.25, 0.5, 0.75, 1] as const;

type HeatStyle = CSSProperties & { readonly "--engine-heat": string };

interface GopGap {
  readonly endMs: number;
  readonly lengthSeconds: number;
  readonly startMs: number;
}

export const EngineDiagnosticsTimeline = memo(
  function EngineDiagnosticsTimeline({
    snapshot,
  }: {
    readonly snapshot: DiagnosticsSnapshot;
  }) {
    const playheadRef = useRef<HTMLSpanElement | null>(null);
    const clockRef = useRef<{
      atMs: number;
      playheadMs: number;
      playing: boolean;
    } | null>(null);
    const durationMs =
      (snapshot.track?.durationS ?? 0) * MILLISECONDS_PER_SECOND;

    useEffect(() => {
      if (snapshot.playheadMs === null) {
        return;
      }

      clockRef.current = {
        atMs: performance.now(),
        playheadMs: snapshot.playheadMs,
        playing: snapshot.status === "PLAYING",
      };
    }, [snapshot]);

    useEffect(() => {
      if (durationMs <= 0) {
        return undefined;
      }

      let frame = 0;
      let drawnX: string | null = null;
      const tick = () => {
        const line = playheadRef.current;
        const clock = clockRef.current;

        if (line && clock) {
          const elapsedMs = clock.playing ? performance.now() - clock.atMs : 0;
          // Writing anything on a node inside the SVG re-marks the whole
          // subtree, transforms included, so the marker is an HTML element over
          // the chart and moves on a custom property the compositor can take.
          const x = `${clamp01((clock.playheadMs + elapsedMs) / durationMs) * 100}%`;

          if (x !== drawnX) {
            drawnX = x;
            line.style.setProperty("--engine-timeline-playhead", x);
          }
        }

        frame = requestAnimationFrame(tick);
      };

      frame = requestAnimationFrame(tick);

      return () => {
        cancelAnimationFrame(frame);
      };
    }, [durationMs]);

    if (durationMs <= 0) {
      return <p className="engine-timeline__unavailable">timeline n/a</p>;
    }

    const toX = (ms: number) => clamp01(ms / durationMs) * VIEW_WIDTH;
    const scheduler = snapshot.scheduler;
    // A cached frame answers a scrub anywhere within its tolerance, on BOTH
    // sides, so its mark is the tolerance across and centred on the frame.
    const spanWidth = (toleranceMs: number) =>
      Math.max(2, ((2 * toleranceMs) / durationMs) * VIEW_WIDTH);
    const exactHalfMs = scheduler?.exactToleranceMs ?? 0;
    const previewHalfMs = scheduler?.previewToleranceMs ?? 0;
    const exactWidth = scheduler ? spanWidth(exactHalfMs) : 2;
    const previewWidth = scheduler ? spanWidth(previewHalfMs) : 2;
    const keyframesMs = scheduler?.keyframesMs ?? [];
    // Until enough keyframes are known, the gaps between the few discovered ones
    // are an artefact of the walk, and every one of them paints as a long GOP.
    const gopGaps =
      keyframesMs.length >= GOP_MIN_SAMPLE
        ? buildGopGaps(keyframesMs, durationMs)
        : [];
    // In frames presentation the engine paints nothing: this marker is the last
    // frame it handed to the host, and whether the host composited it is a
    // question only the host can answer.
    const screenLabel =
      snapshot.presentation === "frames" ? "handed out" : "on screen";

    return (
      <div className="engine-timeline">
        <div className="engine-timeline__stage">
          <svg
            aria-label="Video engine cache, prefetch and GOP heat timeline"
            className="engine-timeline__svg"
            preserveAspectRatio="none"
            role="img"
            viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
          >
            {Array.from({ length: LANE_COUNT }, (_, lane) => (
              <rect
                className="engine-timeline__lane"
                height={LANE_HEIGHT}
                key={`lane-${lane}`}
                width={VIEW_WIDTH}
                x={0}
                y={laneY(lane)}
              />
            ))}

            {gopGaps.map((gap) => (
              <rect
                className="engine-timeline__heat"
                height={LANE_HEIGHT}
                key={`heat-${gap.startMs}`}
                style={
                  { "--engine-heat": heatColor(gap.lengthSeconds) } as HeatStyle
                }
                width={Math.max(1, toX(gap.endMs) - toX(gap.startMs))}
                x={toX(gap.startMs)}
                y={laneY(LANE_HEAT)}
              />
            ))}

            {scheduler?.cache.exactTimestampsMs.map((ms) => (
              <rect
                className="engine-timeline__exact"
                height={LANE_HEIGHT}
                key={`exact-${ms}`}
                width={exactWidth}
                x={toX(ms - exactHalfMs)}
                y={laneY(LANE_EXACT)}
              />
            ))}

            {scheduler?.cache.previewTimestampsMs.map((ms) => (
              <rect
                className="engine-timeline__preview"
                height={LANE_HEIGHT}
                key={`preview-${ms}`}
                width={previewWidth}
                x={toX(ms - previewHalfMs)}
                y={laneY(LANE_PREVIEW)}
              />
            ))}

            {/* Where the next sweep WOULD decode: one tick per planned target,
            recomputed on every broadcast, so a hole in the plan shows as a gap
            rather than hiding under a solid band. */}
            {scheduler?.prefetch?.targetsMs.map((ms) => (
              <rect
                className="engine-timeline__prefetch"
                height={LANE_HEIGHT}
                key={`prefetch-${ms}`}
                width={2}
                x={toX(ms)}
                y={laneY(LANE_PREFETCH)}
              />
            ))}

            {keyframesMs.map((ms) => (
              <line
                className="engine-timeline__keyframe"
                key={`keyframe-${ms}`}
                x1={toX(ms)}
                x2={toX(ms)}
                y1={laneY(LANE_KEYFRAME)}
                y2={laneY(LANE_KEYFRAME) + LANE_HEIGHT}
              />
            ))}

            {AXIS_FRACTIONS.map((fraction) => (
              <text
                className="engine-timeline__axis"
                key={`axis-${fraction}`}
                textAnchor={
                  fraction === 0 ? "start" : fraction === 1 ? "end" : "middle"
                }
                x={fraction * VIEW_WIDTH}
                y={12}
              >
                {`${((fraction * durationMs) / MILLISECONDS_PER_SECOND).toFixed(0)}s`}
              </text>
            ))}

            {/* The frame the engine last put out, coloured by its quality; its
            distance from the playhead is the live landing error. */}
            {snapshot.screen ? (
              <line
                className={`engine-timeline__screen engine-timeline__screen--${snapshot.screen.quality}`}
                x1={toX(snapshot.screen.mediaTimeMs)}
                x2={toX(snapshot.screen.mediaTimeMs)}
                y1={AXIS_HEIGHT - 2}
                y2={VIEW_HEIGHT}
              />
            ) : null}
          </svg>
          <span className="engine-timeline__playhead-track" ref={playheadRef}>
            <span
              className="engine-timeline__playhead"
              style={{ top: `${((AXIS_HEIGHT - 2) / VIEW_HEIGHT) * 100}%` }}
            />
          </span>
        </div>
        <div className="engine-timeline__legend">
          <LegendSwatch modifier="short-gop" label="short GOP" />
          <LegendSwatch modifier="long-gop" label="long GOP" />
          <LegendSwatch modifier="exact" label="exact cache" />
          <LegendSwatch modifier="preview" label="preview cache" />
          <LegendSwatch modifier="prefetch" label="next sweep (planned)" />
          <LegendSwatch modifier="keyframe" label="keyframe (discovered)" />
          <LegendSwatch modifier="playhead" label="playhead (engine clock)" />
          <LegendSwatch modifier="crisp" label={`${screenLabel} (crisp)`} />
          <LegendSwatch modifier="coarse" label={`${screenLabel} (coarse)`} />
        </div>
      </div>
    );
  },
);

function LegendSwatch({
  label,
  modifier,
}: {
  readonly label: string;
  readonly modifier: string;
}) {
  return (
    <span className="engine-timeline__legend-item">
      <span
        aria-hidden="true"
        className={`engine-timeline__legend-swatch engine-timeline__legend-swatch--${modifier}`}
      />
      {label}
    </span>
  );
}

/** Pairs consecutive keyframes into gaps, extending the last keyframe to the end
 *  of the source so the trailing GOP is shown. */
function buildGopGaps(
  keyframesMs: readonly number[],
  durationMs: number,
): readonly GopGap[] {
  const gaps: GopGap[] = [];

  for (let index = 0; index < keyframesMs.length; index += 1) {
    const startMs = keyframesMs[index];
    const endMs =
      index + 1 < keyframesMs.length ? keyframesMs[index + 1] : durationMs;

    if (endMs <= startMs) {
      continue;
    }

    gaps.push({
      endMs,
      lengthSeconds: (endMs - startMs) / MILLISECONDS_PER_SECOND,
      startMs,
    });
  }

  return gaps;
}

/** Maps a GOP length to a hue from green (cool) through amber to rose (hot),
 *  clamped so all-intra and pathological GOPs both saturate. */
function heatColor(gopSeconds: number) {
  const t = clamp01(
    (gopSeconds - HEAT_COOL_SECONDS) / (HEAT_HOT_SECONDS - HEAT_COOL_SECONDS),
  );

  return `hsl(${(140 - t * 140).toFixed(0)} 70% 45%)`;
}

function laneY(lane: number) {
  return AXIS_HEIGHT + lane * (LANE_HEIGHT + LANE_GAP);
}

function clamp01(value: number) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
