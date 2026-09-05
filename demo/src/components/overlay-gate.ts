/** An overlay that appears and vanishes inside a fifth of a second reads as a glitch. */
export const OVERLAY_APPEAR_DELAY_MS = 200;

/**
 * A hold released for a frame or two and taken again is one wait, not two. A
 * pulled source consults its gate at every frame, so a stutter arrives as a
 * train of short holds with a single presented frame between them: 42ms at
 * 24fps, and up to three of those once the state has crossed React. Past that
 * the picture has been moving long enough for the wait to have ended.
 */
export const OVERLAY_GAP_FORGIVENESS_MS = 120;

/**
 * Scrubbing produces a run of brief waits back to back. Without a floor on how
 * long a shown overlay stays, that run strobes.
 */
export const OVERLAY_MINIMUM_DWELL_MS = 400;

/**
 * Past this the viewer stops reading the wait as a hitch and starts wondering
 * what is happening, so the overlay names what it is waiting for.
 */
export const OVERLAY_EXPLAIN_DELAY_MS = 600;

export interface OverlayGateState {
  /** When the overlay's reason last went away, so a gap can be measured. */
  readonly clearedSinceMs: number | null;
  readonly pendingSinceMs: number | null;
  readonly shownSinceMs: number | null;
}

export interface OverlayGateResult {
  readonly explained: boolean;
  readonly state: OverlayGateState;
  readonly visible: boolean;
  /** When the gate changes on its own with no new input, in ms from now. */
  readonly wakeInMs: number | null;
}

export const IDLE_OVERLAY_GATE: OverlayGateState = {
  clearedSinceMs: null,
  pendingSinceMs: null,
  shownSinceMs: null,
};

/**
 * Errors are not waits, so they skip the appear delay. The dwell still applies.
 *
 * `isSuppressed` is the viewer taking the picture over, which is not a wait
 * ending: there is nothing left to protect from strobing, so the dwell is given
 * up rather than sat out over a picture that is tracking their hand.
 */
export function advanceOverlayGate(
  state: OverlayGateState,
  {
    hasOverlay,
    isError,
    isSuppressed = false,
  }: { hasOverlay: boolean; isError: boolean; isSuppressed?: boolean },
  nowMs: number,
): OverlayGateResult {
  if (isError) {
    return {
      explained: true,
      state: {
        clearedSinceMs: null,
        pendingSinceMs: null,
        shownSinceMs: nowMs,
      },
      visible: true,
      wakeInMs: null,
    };
  }

  if (isSuppressed) {
    return {
      explained: false,
      state: IDLE_OVERLAY_GATE,
      visible: false,
      wakeInMs: null,
    };
  }

  if (hasOverlay) {
    const pendingSinceMs = resumablePendingSinceMs(state, nowMs) ?? nowMs;

    if (state.shownSinceMs !== null) {
      return shownResult(state.shownSinceMs, pendingSinceMs, nowMs);
    }

    const waitedMs = nowMs - pendingSinceMs;

    if (waitedMs < OVERLAY_APPEAR_DELAY_MS) {
      return {
        explained: false,
        state: { clearedSinceMs: null, pendingSinceMs, shownSinceMs: null },
        visible: false,
        wakeInMs: OVERLAY_APPEAR_DELAY_MS - waitedMs,
      };
    }

    return shownResult(nowMs, pendingSinceMs, nowMs);
  }

  const clearedSinceMs = state.clearedSinceMs ?? nowMs;

  if (state.shownSinceMs === null) {
    return {
      explained: false,
      state:
        state.pendingSinceMs === null
          ? IDLE_OVERLAY_GATE
          : {
              clearedSinceMs,
              pendingSinceMs: state.pendingSinceMs,
              shownSinceMs: null,
            },
      visible: false,
      wakeInMs: null,
    };
  }

  const dwelledMs = nowMs - state.shownSinceMs;

  if (dwelledMs < OVERLAY_MINIMUM_DWELL_MS) {
    return {
      explained: dwelledMs >= OVERLAY_EXPLAIN_DELAY_MS,
      state: {
        clearedSinceMs,
        pendingSinceMs: state.pendingSinceMs,
        shownSinceMs: state.shownSinceMs,
      },
      visible: true,
      wakeInMs: OVERLAY_MINIMUM_DWELL_MS - dwelledMs,
    };
  }

  return {
    explained: false,
    state: IDLE_OVERLAY_GATE,
    visible: false,
    wakeInMs: null,
  };
}

function resumablePendingSinceMs(state: OverlayGateState, nowMs: number) {
  if (
    state.clearedSinceMs !== null &&
    nowMs - state.clearedSinceMs >= OVERLAY_GAP_FORGIVENESS_MS
  ) {
    return null;
  }

  return state.pendingSinceMs;
}

function shownResult(
  shownSinceMs: number,
  pendingSinceMs: number,
  nowMs: number,
): OverlayGateResult {
  const pendingMs = nowMs - pendingSinceMs;

  return {
    explained: pendingMs >= OVERLAY_EXPLAIN_DELAY_MS,
    state: { clearedSinceMs: null, pendingSinceMs, shownSinceMs },
    visible: true,
    wakeInMs:
      pendingMs < OVERLAY_EXPLAIN_DELAY_MS
        ? OVERLAY_EXPLAIN_DELAY_MS - pendingMs
        : null,
  };
}
