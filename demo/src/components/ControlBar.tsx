import { memo, useRef, useState } from "react";
import { MediaRendererPlaybackState } from "supervision";
import type {
  FrameTimelineData,
  SourceResidencyDiagnostics,
} from "supervision-js-video-engine";
import { formatTime } from "../format";
import {
  useLiveReadoutWriter,
  type LiveReadouts,
} from "../hooks/live-readouts";
import type { TimelineRange } from "../session/demo-session-types";
import { isPlaybackRateSustained } from "../session/playback-rate";
import { DiagnosticLabel } from "./DiagnosticLabel";
import {
  formatLiveCook,
  formatLiveDetectionTime,
  formatLiveHotBuffer,
  formatLiveTimecode,
  isLiveAtClipEnd,
  readLiveStatePresentation,
  type PlaybackStatePresentation,
} from "./live-readout-format";
import { LiveReadoutText } from "./LiveReadoutText";
import { TimelineView } from "./TimelineView";
import { Transport } from "./Transport";

const STATE_TOOLTIP =
  "What the transport is doing, and while it plays, the rate the picture is really keeping against the rate you asked for. Amber means the source cannot decode that fast and the picture is running slower than the speed shown.";

interface ControlBarProps {
  readonly canUseRenderer: boolean;
  readonly duration: number | null;
  readonly frameTimeline: FrameTimelineData | null;
  readonly onScrub: (time: number) => void;
  readonly onSeek: (time: number) => void;
  readonly onSetPlaybackRate: (rate: number) => void;
  readonly onStepFrame: (direction: 1 | -1) => void;
  readonly onTogglePlayback: () => void;
  readonly playbackRate: number;
  readonly playbackState: MediaRendererPlaybackState | null;
  readonly presentedRate: number | null;
  readonly processedRanges: readonly TimelineRange[];
  readonly processingRanges: readonly TimelineRange[];
  readonly sourceResidency: SourceResidencyDiagnostics | null;
}

export const ControlBar = memo(function ControlBar({
  canUseRenderer,
  duration,
  frameTimeline,
  onScrub,
  onSeek,
  onSetPlaybackRate,
  onStepFrame,
  onTogglePlayback,
  playbackRate,
  playbackState,
  presentedRate,
  processedRanges,
  processingRanges,
  sourceResidency,
}: ControlBarProps) {
  countControlBarRender();

  const isBuffering = playbackState === MediaRendererPlaybackState.Buffering;
  const isPlaying = playbackState === MediaRendererPlaybackState.Playing;
  const atClipEnd = useLiveClipEnd(!isPlaying && !isBuffering);

  return (
    <section className="control-bar" aria-label="Playback controls">
      <div className="control-bar__transport">
        <Transport
          atClipEnd={atClipEnd}
          disabled={!canUseRenderer}
          isBuffering={isBuffering}
          isPlaying={isPlaying}
          onSetPlaybackRate={onSetPlaybackRate}
          onStepFrame={onStepFrame}
          onTogglePlayback={onTogglePlayback}
          playbackRate={playbackRate}
          presentedRate={presentedRate}
        />
        <p className="control-bar__timecode">
          <LiveReadoutText
            className="control-bar__timecode-now"
            format={formatLiveTimecode}
          />
          <span className="control-bar__timecode-total">
            / {formatTime(duration)}
          </span>
        </p>
      </div>
      <div className="control-bar__ledger">
        <StateCell />
        <LedgerCell
          format={formatLiveDetectionTime}
          label="Detection"
          tooltip="The media time of the prediction frame currently on screen. It lags the playhead by up to one frame, and a gap wider than that means the drawn boxes belong to an older frame than the picture."
        />
        <LedgerCell
          format={formatLiveHotBuffer}
          label="Hot buffer"
          tooltip="Prediction frames held in memory around the playhead, and the boxes and masks they carry between them. This is what the hot predictions lane spans."
        />
        <LedgerCell
          format={formatLiveCook}
          label="Cook"
          tooltip="Mask rasterising right now: workers busy out of workers available, then frames queued behind them. Queued frames climbing while the prepared run shrinks is the picture outrunning the cook."
        />
      </div>
      <TimelineView
        disabled={!canUseRenderer}
        duration={duration}
        frameTimeline={frameTimeline}
        onScrub={onScrub}
        onSeek={onSeek}
        processedRanges={processedRanges}
        processingRanges={processingRanges}
        sourceResidency={sourceResidency}
      />
      <p className="control-bar__hints">
        <span>
          <kbd>Space</kbd> play
        </span>
        <span>
          <kbd>,</kbd>
          <kbd>.</kbd> frame
        </span>
        <span>
          <kbd>←</kbd>
          <kbd>→</kbd> 1s
        </span>
        <span>
          <kbd>⇧←</kbd>
          <kbd>⇧→</kbd> 10s
        </span>
        <span>
          <kbd>&lt;</kbd>
          <kbd>&gt;</kbd> speed
        </span>
        <span>
          <kbd>J</kbd>
          <kbd>K</kbd>
          <kbd>L</kbd> shuttle
        </span>
        <span>
          <kbd>Home</kbd>
          <kbd>End</kbd> clip ends
        </span>
      </p>
    </section>
  );
}, areControlBarPropsEqual);

/**
 * `presentedRate` is a live measurement: a fresh float lands on the bar
 * several times a second, and all it decides is whether the speed pill is
 * marked unsustained and which tenth its tooltip quotes. Two rates that answer
 * those the same way draw the same bar, and every other figure on it is
 * written into its own text node by a live readout writer without a commit.
 */
export function areControlBarPropsEqual(
  previous: ControlBarProps,
  next: ControlBarProps,
) {
  const keys = Object.keys(next) as readonly (keyof ControlBarProps)[];

  return (
    keys.length === Object.keys(previous).length &&
    keys.every(
      (key) => key === "presentedRate" || Object.is(previous[key], next[key]),
    ) &&
    readSpeedShortfall(next.playbackRate, previous.presentedRate) ===
      readSpeedShortfall(next.playbackRate, next.presentedRate)
  );
}

/** The tenth the speed pill quotes while the picture cannot keep the commanded
 *  rate, and null while it keeps it. */
function readSpeedShortfall(
  playbackRate: number,
  presentedRate: number | null,
) {
  return presentedRate === null ||
    isPlaybackRateSustained(playbackRate, presentedRate)
    ? null
    : presentedRate.toFixed(1);
}

function countControlBarRender() {
  if (!import.meta.env.DEV) {
    return;
  }

  const scope = globalThis as { __demoControlBarRenders?: number };

  scope.__demoControlBarRenders = (scope.__demoControlBarRenders ?? 0) + 1;
}

/**
 * The play button turning into a replay button is a React commit, so it is
 * taken from the live readouts only while the transport is stopped: a playing
 * clip cannot be at its end, and reading it per frame would commit the whole
 * bar on every frame that answered "no".
 */
function useLiveClipEnd(stopped: boolean) {
  const [atClipEnd, setAtClipEnd] = useState(false);

  useLiveReadoutWriter((readouts) => {
    setAtClipEnd(stopped && isLiveAtClipEnd(readouts));
  });

  return atClipEnd;
}

function LedgerCell({
  format,
  label,
  tooltip,
}: {
  readonly format: (readouts: LiveReadouts) => string;
  readonly label: string;
  readonly tooltip: string;
}) {
  return (
    <span className="control-bar__cell control-bar__cell--idle">
      <DiagnosticLabel label={label} tooltip={tooltip} />
      <span className="control-bar__cell-value">
        <span className="control-bar__cell-dot" aria-hidden="true" />
        <LiveReadoutText format={format} />
      </span>
    </span>
  );
}

/** The one cell whose tone moves with its value, so the class is written
 *  alongside the text rather than committed. */
function StateCell() {
  const cellRef = useRef<HTMLSpanElement>(null);
  const writtenToneRef = useRef<PlaybackStatePresentation["tone"] | null>(null);

  useLiveReadoutWriter((readouts) => {
    const cell = cellRef.current;
    const { tone } = readLiveStatePresentation(readouts);

    if (cell === null || tone === writtenToneRef.current) {
      return;
    }

    writtenToneRef.current = tone;
    cell.className = `control-bar__cell control-bar__cell--${tone}`;
  });

  return (
    <span className="control-bar__cell control-bar__cell--idle" ref={cellRef}>
      <DiagnosticLabel label="State" tooltip={STATE_TOOLTIP} />
      <span className="control-bar__cell-value">
        <span className="control-bar__cell-dot" aria-hidden="true" />
        <LiveReadoutText format={formatLiveStateLabel} />
      </span>
    </span>
  );
}

function formatLiveStateLabel(readouts: LiveReadouts) {
  return readLiveStatePresentation(readouts).label;
}
