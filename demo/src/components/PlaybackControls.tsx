import { memo } from "react";
import { MediaRendererPlaybackState } from "supervision";

export const PlaybackControls = memo(function PlaybackControls({
  playbackState,
  disabled,
  onStepFrame,
  onTogglePlayback,
}: {
  readonly playbackState: MediaRendererPlaybackState | null;
  readonly disabled: boolean;
  readonly onStepFrame: (direction: 1 | -1) => void;
  readonly onTogglePlayback: () => void;
}) {
  const isPlaybackActive =
    playbackState === MediaRendererPlaybackState.Playing ||
    playbackState === MediaRendererPlaybackState.Buffering;
  const isBuffering = playbackState === MediaRendererPlaybackState.Buffering;
  const label = isPlaybackActive ? "Pause" : "Play";

  return (
    <div
      className="playback-controls"
      aria-label="Playback controls"
      role="group"
    >
      <button
        aria-label="Previous frame"
        className="playback-controls__step"
        disabled={disabled}
        onClick={() => onStepFrame(-1)}
        type="button"
      >
        -1
      </button>
      <button
        aria-label={label}
        className="playback-controls__toggle"
        disabled={disabled}
        onClick={onTogglePlayback}
        type="button"
      >
        <span
          aria-hidden="true"
          className={
            isPlaybackActive
              ? "playback-controls__pause"
              : "playback-controls__play"
          }
        />
        <span className="playback-controls__label">
          {isBuffering ? "Buffering" : label}
        </span>
      </button>
      <button
        aria-label="Next frame"
        className="playback-controls__step"
        disabled={disabled}
        onClick={() => onStepFrame(1)}
        type="button"
      >
        +1
      </button>
    </div>
  );
});
