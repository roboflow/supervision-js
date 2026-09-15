import { PLAYBACK_RATE } from "supervision/web-video-engine";

/** The speeds the player offers, slowest first. */
export const playbackRateLadder = [0.25, 0.5, 1, 2, 4, 8] as const;

export const defaultPlaybackRate = 1;

/** What a J, K, or L press asks of the player. */
export interface ShuttleCommand {
  readonly playback: "pause" | "play" | null;
  readonly rate: number;
}

export function formatPlaybackRate(rate: number) {
  return `${rate}x`;
}

export function stepPlaybackRate(rate: number, direction: 1 | -1) {
  const rung = Math.min(
    Math.max(nearestRung(rate) + direction, 0),
    playbackRateLadder.length - 1,
  );

  return playbackRateLadder[rung];
}

/** Advances one rung and wraps, so the pill reaches every speed by clicking. */
export function cyclePlaybackRate(rate: number) {
  return playbackRateLadder[
    (nearestRung(rate) + 1) % playbackRateLadder.length
  ];
}

/**
 * J-K-L over a forward-only engine. L is the fast half of the shuttle and J the
 * slow half; neither fakes the reverse playback the engine refuses. Both start a
 * stopped player at the speed it already holds, so the first press means "go"
 * and only the repeats move along the ladder. K is the full stop: paused, and
 * back to 1x for the next press.
 */
export function resolveShuttleCommand(
  key: string,
  player: { readonly isPlaying: boolean; readonly rate: number },
): ShuttleCommand | null {
  switch (key.toLowerCase()) {
    case "k":
      return { playback: "pause", rate: defaultPlaybackRate };
    case "l":
      return resolveShuttleStep(player, 1);
    case "j":
      return resolveShuttleStep(player, -1);
    default:
      return null;
  }
}

/**
 * Whether the picture is keeping the promise the commanded rate made. Unknown
 * reads as kept: an unmeasured rate is no evidence of a shortfall.
 *
 * Below 1x the measurement is not evidence either. The presented rate is
 * painted media distance over a ~600ms window, so it carries a whole frame of
 * quantisation error; at a quarter speed on a low-fps source that error is
 * wider than the shortfall margin, and a healthy pipeline reads as failing.
 * Slower than 1x is therefore left unjudged, and 1x up is measured.
 */
export function isPlaybackRateSustained(
  commandedRate: number,
  presentedRate: number | null,
) {
  if (presentedRate === null || commandedRate < defaultPlaybackRate) {
    return true;
  }

  return presentedRate >= commandedRate * PLAYBACK_RATE.SUSTAINED_SHORTFALL;
}

function resolveShuttleStep(
  player: { readonly isPlaying: boolean; readonly rate: number },
  direction: 1 | -1,
): ShuttleCommand {
  return player.isPlaying
    ? { playback: null, rate: stepPlaybackRate(player.rate, direction) }
    : { playback: "play", rate: player.rate };
}

function nearestRung(rate: number) {
  let rung = 0;

  for (let index = 1; index < playbackRateLadder.length; index += 1) {
    const closer =
      Math.abs(playbackRateLadder[index] - rate) <
      Math.abs(playbackRateLadder[rung] - rate);

    if (closer) {
      rung = index;
    }
  }

  return rung;
}
