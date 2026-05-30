import { MediaRendererPlaybackState } from "supervision-js";

export function PlaybackControls({
  playbackState,
  disabled,
  onTogglePlayback,
}: {
  readonly playbackState: MediaRendererPlaybackState | null;
  readonly disabled: boolean;
  readonly onTogglePlayback: () => void;
}) {
  const isPlaybackActive =
    playbackState === MediaRendererPlaybackState.Playing ||
    playbackState === MediaRendererPlaybackState.Buffering;
  const isBuffering = playbackState === MediaRendererPlaybackState.Buffering;
  const label = isPlaybackActive ? "Pause" : "Play";

  return (
    <button
      aria-label={label}
      className="playback-controls"
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
  );
}
