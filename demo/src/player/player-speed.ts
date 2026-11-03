import { PLAYBACK_RATE } from "supervision/web-video-engine";

/** The custom speed field moves in twentieths: fine enough for 1.05x, coarse
 *  enough that a typed value never lands between two steps. */
export const PLAYER_SPEED_STEP = 0.05;

/** The forward range the web video engine accepts, which is the whole range
 *  the player can offer. Anything outside it is refused by the engine. */
export const PLAYER_SPEED_RANGE = {
  max: PLAYBACK_RATE.MAX,
  min: PLAYBACK_RATE.MIN,
} as const;

/**
 * Pulls a speed onto the step and inside the engine's range, so a value the
 * engine would throw on becomes the nearest one it accepts.
 */
export function clampPlayerSpeed(rate: number) {
  const stepped = Math.round(rate / PLAYER_SPEED_STEP) * PLAYER_SPEED_STEP;
  const bounded = Math.min(
    Math.max(stepped, PLAYER_SPEED_RANGE.min),
    PLAYER_SPEED_RANGE.max,
  );

  return Number(bounded.toFixed(2));
}

/**
 * Reads a typed speed. Speeds are written with a trailing "x" everywhere on the
 * page, so one is accepted here too. Returns null for text that names no
 * positive speed, which leaves the current speed alone.
 */
export function parsePlayerSpeed(text: string): number | null {
  const trimmed = text.trim().replace(/x$/i, "").trim();

  if (trimmed === "") {
    return null;
  }

  const value = Number(trimmed);

  return Number.isFinite(value) && value > 0 ? clampPlayerSpeed(value) : null;
}
