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
  const isPlaying = playbackState === MediaRendererPlaybackState.Playing;
  const label = isPlaying ? "Pause" : "Play";

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
          isPlaying ? "playback-controls__pause" : "playback-controls__play"
        }
      />
      <span className="playback-controls__label">{label}</span>
    </button>
  );
}
