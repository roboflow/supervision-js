import { memo } from "react";

type TransportAction = "pause" | "play" | "replay";

export const Transport = memo(function Transport({
  atClipEnd,
  disabled,
  isBuffering,
  isPlaying,
  onStepFrame,
  onTogglePlayback,
}: {
  readonly atClipEnd: boolean;
  readonly disabled: boolean;
  readonly isBuffering: boolean;
  readonly isPlaying: boolean;
  readonly onStepFrame: (direction: 1 | -1) => void;
  readonly onTogglePlayback: () => void;
}) {
  const action: TransportAction = isPlaying
    ? "pause"
    : atClipEnd
      ? "replay"
      : "play";
  const label = TRANSPORT_LABELS[action];

  return (
    <div className="transport" aria-label="Transport" role="group">
      <button
        aria-label="Previous frame"
        className="transport__step"
        disabled={disabled}
        onClick={() => onStepFrame(-1)}
        title="Previous frame (Left arrow)"
        type="button"
      >
        -1
      </button>
      <button
        aria-label={isBuffering ? `${label}, buffering` : label}
        className="transport__play"
        data-action={action}
        data-buffering={isBuffering ? "" : undefined}
        disabled={disabled}
        onClick={onTogglePlayback}
        title={`${label} (Space)`}
        type="button"
      >
        <span aria-hidden="true" className="transport__glyphs">
          <svg
            className="transport__glyph transport__glyph--play"
            viewBox="0 0 16 16"
          >
            <path d="M4 2.5 12 8 4 13.5Z" fill="currentColor" />
          </svg>
          <svg
            className="transport__glyph transport__glyph--pause"
            viewBox="0 0 16 16"
          >
            <rect
              fill="currentColor"
              height="11"
              rx="1.1"
              width="2.6"
              x="4.5"
              y="2.5"
            />
            <rect
              fill="currentColor"
              height="11"
              rx="1.1"
              width="2.6"
              x="8.9"
              y="2.5"
            />
          </svg>
          <svg
            className="transport__glyph transport__glyph--replay"
            viewBox="0 0 16 16"
          >
            <path
              d="M12.9 8A4.9 4.9 0 1 1 8 3.1"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="1.7"
            />
            <path d="M8 0.9 11.1 3.1 8 5.3Z" fill="currentColor" />
          </svg>
        </span>
        <span aria-hidden="true" className="transport__ring" />
      </button>
      <button
        aria-label="Next frame"
        className="transport__step"
        disabled={disabled}
        onClick={() => onStepFrame(1)}
        title="Next frame (Right arrow)"
        type="button"
      >
        +1
      </button>
    </div>
  );
});

const TRANSPORT_LABELS: Record<TransportAction, string> = {
  pause: "Pause",
  play: "Play",
  replay: "Replay",
};
