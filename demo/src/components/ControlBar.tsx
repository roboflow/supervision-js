import { memo } from "react";
import {
  MediaRendererPlaybackState,
  type DetectionBufferState,
  type RenderPreparationDiagnostics,
} from "supervision";
import { formatExactTime, formatTime } from "../format";
import { selectPreparedWindowArtifact } from "../render-preparation";
import type { TimelineRange } from "../session/demo-session-types";
import { Readout } from "./Readout";
import { TimelineView } from "./TimelineView";
import { Transport } from "./Transport";

interface PlaybackStatePresentation {
  readonly label: string;
  readonly tone: "error" | "idle" | "live" | "waiting";
}

const PLAYBACK_STATES: Record<
  MediaRendererPlaybackState,
  PlaybackStatePresentation
> = {
  [MediaRendererPlaybackState.Buffering]: {
    label: "Buffering",
    tone: "waiting",
  },
  [MediaRendererPlaybackState.Destroyed]: { label: "Destroyed", tone: "error" },
  [MediaRendererPlaybackState.Error]: { label: "Error", tone: "error" },
  [MediaRendererPlaybackState.Loading]: { label: "Loading", tone: "waiting" },
  [MediaRendererPlaybackState.Paused]: { label: "Paused", tone: "idle" },
  [MediaRendererPlaybackState.Playing]: { label: "Playing", tone: "live" },
  [MediaRendererPlaybackState.Ready]: { label: "Ready", tone: "idle" },
};

const UNKNOWN_PLAYBACK_STATE: PlaybackStatePresentation = {
  label: "Unknown",
  tone: "idle",
};

/** Used to read "the playhead is on the last frame" until the prepared window
 *  reports the media's real frame pitch. */
const FALLBACK_FRAME_PITCH_SECONDS = 1 / 60;

export const ControlBar = memo(function ControlBar({
  activeDetectionFrameTime,
  canUseRenderer,
  currentTime,
  detectionBuffer,
  duration,
  onScrub,
  onSeek,
  onStepFrame,
  onTogglePlayback,
  playbackState,
  processedRanges,
  processingRanges,
  renderPreparationDiagnostics,
}: {
  readonly activeDetectionFrameTime: number | null;
  readonly canUseRenderer: boolean;
  readonly currentTime: number | null;
  readonly detectionBuffer: DetectionBufferState | null;
  readonly duration: number | null;
  readonly onScrub: (time: number) => void;
  readonly onSeek: (time: number) => void;
  readonly onStepFrame: (direction: 1 | -1) => void;
  readonly onTogglePlayback: () => void;
  readonly playbackState: MediaRendererPlaybackState | null;
  readonly processedRanges: readonly TimelineRange[];
  readonly processingRanges: readonly TimelineRange[];
  readonly renderPreparationDiagnostics: RenderPreparationDiagnostics | null;
}) {
  const preparedWindowArtifact = selectPreparedWindowArtifact(
    renderPreparationDiagnostics,
  );
  const preparedAheadSeconds =
    preparedWindowArtifact?.preparedAheadSeconds ?? null;
  const preparedAheadFrames =
    preparedWindowArtifact?.preparedAheadFrameCount ?? null;
  const playbackStatePresentation =
    playbackState === null
      ? UNKNOWN_PLAYBACK_STATE
      : PLAYBACK_STATES[playbackState];
  const isBuffering = playbackState === MediaRendererPlaybackState.Buffering;
  const isPlaying = playbackState === MediaRendererPlaybackState.Playing;
  const atClipEnd =
    !isPlaying &&
    !isBuffering &&
    currentTime !== null &&
    duration !== null &&
    duration > 0 &&
    duration - currentTime <=
      resolveFramePitchSeconds(preparedAheadSeconds, preparedAheadFrames);

  return (
    <section className="control-bar" aria-label="Playback controls">
      <div className="control-bar__transport">
        <Transport
          atClipEnd={atClipEnd}
          disabled={!canUseRenderer}
          isBuffering={isBuffering}
          isPlaying={isPlaying}
          onStepFrame={onStepFrame}
          onTogglePlayback={onTogglePlayback}
        />
        <p className="control-bar__timecode">
          <span className="control-bar__timecode-now">
            {formatExactTime(currentTime)}
          </span>
          <span className="control-bar__timecode-total">
            / {formatTime(duration)}
          </span>
        </p>
        <div className="control-bar__ledger">
          <span
            className={`control-bar__state control-bar__state--${playbackStatePresentation.tone}`}
          >
            <span className="control-bar__state-dot" aria-hidden="true" />
            {playbackStatePresentation.label}
          </span>
          <Readout
            className="control-bar__cell control-bar__cell--detection"
            label="Detection"
            value={formatExactTime(activeDetectionFrameTime)}
          />
        </div>
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
        processedRanges={processedRanges}
        processingRanges={processingRanges}
        preparedAheadFrames={preparedAheadFrames}
        preparedAheadSeconds={preparedAheadSeconds}
      />
      <p className="control-bar__hints">
        <span>
          <kbd>Space</kbd> play
        </span>
        <span>
          <kbd>←</kbd>
          <kbd>→</kbd> frame
        </span>
        <span>
          <kbd>⇧←</kbd>
          <kbd>⇧→</kbd> 1s
        </span>
        <span>
          <kbd>Home</kbd>
          <kbd>End</kbd> clip ends
        </span>
      </p>
    </section>
  );
});

function resolveFramePitchSeconds(
  preparedAheadSeconds: number | null,
  preparedAheadFrames: number | null,
) {
  if (
    preparedAheadSeconds === null ||
    preparedAheadFrames === null ||
    preparedAheadFrames <= 0 ||
    preparedAheadSeconds <= 0
  ) {
    return FALLBACK_FRAME_PITCH_SECONDS;
  }

  return preparedAheadSeconds / preparedAheadFrames;
}
