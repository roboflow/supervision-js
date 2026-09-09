import { memo } from "react";
import {
  cyclePlaybackRate,
  formatPlaybackRate,
  isPlaybackRateSustained,
} from "../session/playback-rate";

type TransportAction = "pause" | "play" | "replay";

export const Transport = memo(function Transport({
  atClipEnd,
  disabled,
  isBuffering,
  isPlaying,
  onSetPlaybackRate,
  onStepFrame,
  onTogglePlayback,
  playbackRate,
  presentedRate,
  waitLabel,
}: {
  readonly atClipEnd: boolean;
  readonly disabled: boolean;
  readonly isBuffering: boolean;
  readonly isPlaying: boolean;
  readonly onSetPlaybackRate: (rate: number) => void;
  readonly onStepFrame: (direction: 1 | -1) => void;
  readonly onTogglePlayback: () => void;
  readonly playbackRate: number;
  readonly presentedRate: number | null;
  /** The wait the viewport notice is currently naming, or null while no notice
   *  is on screen. */
  readonly waitLabel: string | null;
}) {
  const action: TransportAction = isPlaying
    ? "pause"
    : atClipEnd
      ? "replay"
      : "play";
  const label = TRANSPORT_LABELS[action];
  const sustained = isPlaybackRateSustained(playbackRate, presentedRate);
  const speedLabel = formatPlaybackRate(playbackRate);
  const speedTitle =
    sustained || presentedRate === null
      ? `Speed ${speedLabel} (J slower, K stop, L faster)`
      : `Speed ${speedLabel}, showing ${presentedRate.toFixed(1)}x. This source cannot decode that fast.`;

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
        aria-label={
          isBuffering
            ? `${label}, ${(waitLabel ?? "buffering").toLowerCase()}`
            : label
        }
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
          <svg
            className="transport__glyph transport__glyph--busy"
            viewBox="0 0 16 16"
          >
            <circle
              cx="8"
              cy="8"
              fill="none"
              opacity="0.35"
              r="5.7"
              stroke="currentColor"
              strokeWidth="1.8"
            />
            <path
              d="M8 2.3A5.7 5.7 0 0 1 13.7 8"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="1.8"
            />
          </svg>
        </span>
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
      <button
        aria-label={speedTitle}
        className="transport__step transport__speed"
        data-sustained={sustained ? undefined : "false"}
        disabled={disabled}
        onClick={() => onSetPlaybackRate(cyclePlaybackRate(playbackRate))}
        title={speedTitle}
        type="button"
      >
        <span aria-hidden="true" className="transport__speed-dot" />
        <span className="transport__speed-value">{speedLabel}</span>
      </button>
    </div>
  );
});

const TRANSPORT_LABELS: Record<TransportAction, string> = {
  pause: "Pause",
  play: "Play",
  replay: "Replay",
};
