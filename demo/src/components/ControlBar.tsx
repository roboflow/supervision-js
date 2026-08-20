import { memo } from "react";
import {
  MediaRendererPlaybackState,
  type DetectionBufferState,
  type RenderPreparationDiagnostics,
} from "supervision";
import { formatExactTime, formatInteger, formatTime } from "../format";
import { selectPreparedWindowArtifact } from "../render-preparation";
import {
  formatPlaybackRate,
  isPlaybackRateSustained,
} from "../session/playback-rate";
import type { TimelineRange } from "../session/demo-session-types";
import { DiagnosticLabel } from "./DiagnosticLabel";
import { readPreparedWindow } from "./prepared-window";
import { TimelineView } from "./TimelineView";
import { Transport } from "./Transport";

interface PlaybackStatePresentation {
  readonly label: string;
  readonly tone: "error" | "idle" | "live" | "waiting";
}

/**
 * The states the transport publishes that the play button cannot draw. Playing
 * and paused are absent on purpose: the button is already showing them, so the
 * chip spends its space on the rate the picture is actually keeping instead.
 */
const NAMED_PLAYBACK_STATES: Partial<
  Record<MediaRendererPlaybackState, PlaybackStatePresentation>
> = {
  [MediaRendererPlaybackState.Buffering]: {
    label: "Buffering",
    tone: "waiting",
  },
  [MediaRendererPlaybackState.Destroyed]: { label: "Destroyed", tone: "error" },
  [MediaRendererPlaybackState.Error]: { label: "Error", tone: "error" },
  [MediaRendererPlaybackState.Loading]: { label: "Loading", tone: "waiting" },
  [MediaRendererPlaybackState.Ready]: { label: "Ready", tone: "idle" },
};

const STATE_TOOLTIP =
  "What the transport is doing, and while it plays, the rate the picture is really keeping against the rate you asked for. Amber means the source cannot decode that fast and the picture is running slower than the speed shown.";

/** Used to read "the playhead is on the last frame" until the source reports
 *  its own frame rate. */
const FALLBACK_FRAME_PITCH_SECONDS = 1 / 60;

export const ControlBar = memo(function ControlBar({
  activeDetectionFrameTime,
  canUseRenderer,
  currentTime,
  detectionBuffer,
  duration,
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
  renderPreparationDiagnostics,
  sourceFrameRate,
}: {
  readonly activeDetectionFrameTime: number | null;
  readonly canUseRenderer: boolean;
  readonly currentTime: number | null;
  readonly detectionBuffer: DetectionBufferState | null;
  readonly duration: number | null;
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
  readonly renderPreparationDiagnostics: RenderPreparationDiagnostics | null;
  readonly sourceFrameRate: number | null;
}) {
  const preparedWindow = readPreparedWindow(
    selectPreparedWindowArtifact(renderPreparationDiagnostics),
    sourceFrameRate,
  );
  const isBuffering = playbackState === MediaRendererPlaybackState.Buffering;
  const isPlaying = playbackState === MediaRendererPlaybackState.Playing;
  const atClipEnd =
    !isPlaying &&
    !isBuffering &&
    currentTime !== null &&
    duration !== null &&
    duration > 0 &&
    duration - currentTime <=
      (preparedWindow?.framePitchSeconds ?? FALLBACK_FRAME_PITCH_SECONDS);
  const statePresentation = resolveStatePresentation({
    atClipEnd,
    isPlaying,
    playbackRate,
    playbackState,
    presentedRate,
  });

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
          <span className="control-bar__timecode-now">
            {formatExactTime(currentTime)}
          </span>
          <span className="control-bar__timecode-total">
            / {formatTime(duration)}
          </span>
        </p>
      </div>
      <div className="control-bar__ledger">
        <LedgerCell
          label="State"
          tone={statePresentation.tone}
          tooltip={STATE_TOOLTIP}
          value={statePresentation.label}
        />
        <LedgerCell
          label="Detection"
          tooltip="The media time of the prediction frame currently on screen. It lags the playhead by up to one frame, and a gap wider than that means the drawn boxes belong to an older frame than the picture."
          value={formatExactTime(activeDetectionFrameTime)}
        />
        <LedgerCell
          label="Hot buffer"
          tooltip="Prediction frames held in memory around the playhead, and the boxes and masks they carry between them. This is what the hot predictions lane spans."
          value={formatBuffer(detectionBuffer)}
        />
        <LedgerCell
          label="Cook"
          tooltip="Mask rasterising right now: workers busy out of workers available, then frames queued behind them. Queued frames climbing while the prepared run shrinks is the picture outrunning the cook."
          value={formatCook(renderPreparationDiagnostics)}
        />
      </div>
      <TimelineView
        activeDetectionFrameTime={activeDetectionFrameTime}
        currentTime={currentTime ?? 0}
        detectionBuffer={detectionBuffer}
        disabled={!canUseRenderer}
        duration={duration}
        onScrub={onScrub}
        onSeek={onSeek}
        playbackState={playbackState}
        preparedWindow={preparedWindow}
        processedRanges={processedRanges}
        processingRanges={processingRanges}
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
});

function LedgerCell({
  label,
  tone = "idle",
  tooltip,
  value,
}: {
  readonly label: string;
  readonly tone?: PlaybackStatePresentation["tone"];
  readonly tooltip: string;
  readonly value: string;
}) {
  return (
    <span className={`control-bar__cell control-bar__cell--${tone}`}>
      <DiagnosticLabel label={label} tooltip={tooltip} />
      <span className="control-bar__cell-value">
        <span className="control-bar__cell-dot" aria-hidden="true" />
        {value}
      </span>
    </span>
  );
}

/**
 * A state worth naming takes the chip; otherwise it carries the one fact the
 * play button cannot, which is whether the picture is really running at the
 * speed it was asked for.
 */
function resolveStatePresentation({
  atClipEnd,
  isPlaying,
  playbackRate,
  playbackState,
  presentedRate,
}: {
  readonly atClipEnd: boolean;
  readonly isPlaying: boolean;
  readonly playbackRate: number;
  readonly playbackState: MediaRendererPlaybackState | null;
  readonly presentedRate: number | null;
}): PlaybackStatePresentation {
  if (playbackState === null) {
    return { label: "No renderer", tone: "idle" };
  }

  const named = NAMED_PLAYBACK_STATES[playbackState];

  if (named) {
    return named;
  }

  if (atClipEnd) {
    return { label: "Ended", tone: "idle" };
  }

  if (
    presentedRate !== null &&
    !isPlaybackRateSustained(playbackRate, presentedRate)
  ) {
    return {
      label: `${formatRate(presentedRate)} of ${formatRate(playbackRate)}`,
      tone: "waiting",
    };
  }

  if (!isPlaying) {
    return { label: "Paused", tone: "idle" };
  }

  /* Nothing measured yet is not a verdict. The rate that was asked for is still
   * worth naming, but without the word that would claim it is being kept. */
  if (presentedRate === null) {
    return { label: `${formatPlaybackRate(playbackRate)} asked`, tone: "idle" };
  }

  /* A kept rate is named rather than measured, so the chip states a verdict
   * that holds instead of a figure that rewrites itself several times a
   * second. */
  return {
    label: `${formatPlaybackRate(playbackRate)} sustained`,
    tone: "live",
  };
}

function formatRate(rate: number | null) {
  return rate === null ? "?" : `${rate.toFixed(1)}x`;
}

function formatBuffer(detectionBuffer: DetectionBufferState | null) {
  if (detectionBuffer === null) {
    return "-";
  }

  return `${formatInteger(detectionBuffer.frameCount)}f · ${formatInteger(
    detectionBuffer.detectionCount,
  )}d`;
}

function formatCook(diagnostics: RenderPreparationDiagnostics | null) {
  const artifact = selectPreparedWindowArtifact(diagnostics);

  if (artifact === null) {
    return "-";
  }

  return `${formatInteger(artifact.inFlightCount ?? 0)}/${formatInteger(
    artifact.maxInFlightCount ?? 0,
  )} · ${formatInteger(artifact.pendingCount)}q`;
}
