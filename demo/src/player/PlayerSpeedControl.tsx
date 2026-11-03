import { memo, useRef, useState } from "react";

import { Readout } from "../components/Readout";
import {
  formatPlaybackRate,
  isPlaybackRateSustained,
  playbackRateLadder,
} from "../session/playback-rate";
import {
  PLAYER_SPEED_RANGE,
  PLAYER_SPEED_STEP,
  parsePlayerSpeed,
} from "./player-speed";

/**
 * Every rung of the ladder as one press, and any speed in between typed. The
 * measured rate sits under them, because a commanded speed is a request and
 * what reached the screen is the answer: a source that cannot decode that fast
 * shows the speed it really kept, in amber.
 */
export const PlayerSpeedControl = memo(function PlayerSpeedControl({
  disabled,
  isPlaying,
  onSetPlaybackRate,
  playbackRate,
  presentedRate,
}: {
  readonly disabled: boolean;
  readonly isPlaying: boolean;
  readonly onSetPlaybackRate: (rate: number) => void;
  readonly playbackRate: number;
  readonly presentedRate: number | null;
}) {
  // Null while the field shows the running speed; text while it is being typed.
  // Mirrored in a ref because Enter and Escape both end in a blur, and the blur
  // handler would otherwise read the text from before the key was pressed.
  const [draft, setDraftState] = useState<string | null>(null);
  const draftRef = useRef<string | null>(null);
  const setDraft = (text: string | null) => {
    draftRef.current = text;
    setDraftState(text);
  };
  const sustained = isPlaybackRateSustained(playbackRate, presentedRate);
  const measured = isPlaying && presentedRate !== null;

  const commit = () => {
    const text = draftRef.current;

    setDraft(null);

    const rate = text === null ? null : parsePlayerSpeed(text);

    if (rate !== null) {
      onSetPlaybackRate(rate);
    }
  };

  return (
    <section aria-label="Playback speed" className="source-controls">
      <header className="inspector-card__header">
        <h2>Speed</h2>
      </header>
      <div className="inspector-tabs player-speed__presets" role="group">
        {playbackRateLadder.map((rate) => (
          <button
            aria-pressed={rate === playbackRate}
            disabled={disabled}
            key={rate}
            onClick={() => onSetPlaybackRate(rate)}
            type="button"
          >
            {formatPlaybackRate(rate)}
          </button>
        ))}
      </div>
      <label className="source-field">
        <span>
          Any speed from {formatPlaybackRate(PLAYER_SPEED_RANGE.min)} to{" "}
          {formatPlaybackRate(PLAYER_SPEED_RANGE.max)}
        </span>
        <input
          aria-label={`Custom speed, ${PLAYER_SPEED_RANGE.min}x to ${PLAYER_SPEED_RANGE.max}x`}
          disabled={disabled}
          inputMode="decimal"
          max={PLAYER_SPEED_RANGE.max}
          min={PLAYER_SPEED_RANGE.min}
          onBlur={commit}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            // Either key hands the keys back to the player, so Space plays
            // rather than typing into the field.
            if (event.key === "Escape") {
              setDraft(null);
              event.currentTarget.blur();
            } else if (event.key === "Enter") {
              event.currentTarget.blur();
            }
          }}
          step={PLAYER_SPEED_STEP}
          title="Enter applies it, Escape keeps the running speed."
          type="number"
          value={draft ?? String(playbackRate)}
        />
      </label>
      <Readout
        className={
          measured && !sustained
            ? "player-speed__measured player-speed__measured--short"
            : "player-speed__measured"
        }
        label="Showing"
        value={measured ? `${presentedRate.toFixed(1)}x` : "-"}
      />
    </section>
  );
});
