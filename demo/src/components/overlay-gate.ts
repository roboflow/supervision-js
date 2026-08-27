/** An overlay that appears and vanishes inside a quarter second reads as a glitch. */
export const OVERLAY_APPEAR_DELAY_MS = 250;

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
  pendingSinceMs: null,
  shownSinceMs: null,
};

/** Errors are not waits, so they skip the appear delay. The dwell still applies. */
export function advanceOverlayGate(
  state: OverlayGateState,
  { hasOverlay, isError }: { hasOverlay: boolean; isError: boolean },
  nowMs: number,
): OverlayGateResult {
  if (isError) {
    return {
      explained: true,
      state: { pendingSinceMs: null, shownSinceMs: nowMs },
      visible: true,
      wakeInMs: null,
    };
  }

  if (hasOverlay) {
    const pendingSinceMs = state.pendingSinceMs ?? nowMs;

    if (state.shownSinceMs !== null) {
      return shownResult(state.shownSinceMs, pendingSinceMs, nowMs);
    }

    const waitedMs = nowMs - pendingSinceMs;

    if (waitedMs < OVERLAY_APPEAR_DELAY_MS) {
      return {
        explained: false,
        state: { pendingSinceMs, shownSinceMs: null },
        visible: false,
        wakeInMs: OVERLAY_APPEAR_DELAY_MS - waitedMs,
      };
    }

    return shownResult(nowMs, pendingSinceMs, nowMs);
  }

  if (state.shownSinceMs === null) {
    return {
      explained: false,
      state: IDLE_OVERLAY_GATE,
      visible: false,
      wakeInMs: null,
    };
  }

  const dwelledMs = nowMs - state.shownSinceMs;

  if (dwelledMs < OVERLAY_MINIMUM_DWELL_MS) {
    return {
      explained: dwelledMs >= OVERLAY_EXPLAIN_DELAY_MS,
      state: { pendingSinceMs: null, shownSinceMs: state.shownSinceMs },
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

function shownResult(
  shownSinceMs: number,
  pendingSinceMs: number,
  nowMs: number,
): OverlayGateResult {
  const pendingMs = nowMs - pendingSinceMs;

  return {
    explained: pendingMs >= OVERLAY_EXPLAIN_DELAY_MS,
    state: { pendingSinceMs, shownSinceMs },
    visible: true,
    wakeInMs:
      pendingMs < OVERLAY_EXPLAIN_DELAY_MS
        ? OVERLAY_EXPLAIN_DELAY_MS - pendingMs
        : null,
  };
}
