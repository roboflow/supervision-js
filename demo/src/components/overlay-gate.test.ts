import { describe, expect, it } from "vitest";

import {
  advanceOverlayGate,
  IDLE_OVERLAY_GATE,
  OVERLAY_APPEAR_DELAY_MS,
  OVERLAY_EXPLAIN_DELAY_MS,
  OVERLAY_MINIMUM_DWELL_MS,
  type OverlayGateState,
} from "./overlay-gate";

function run(
  timeline: readonly { atMs: number; hasOverlay: boolean; isError?: boolean }[],
) {
  let state: OverlayGateState = IDLE_OVERLAY_GATE;

  return timeline.map(({ atMs, hasOverlay, isError = false }) => {
    const result = advanceOverlayGate(state, { hasOverlay, isError }, atMs);
    state = result.state;

    return result;
  });
}

describe("advanceOverlayGate", () => {
  it("shows nothing for a wait that resolves before the appear delay", () => {
    const [start, midway, resolved] = run([
      { atMs: 0, hasOverlay: true },
      { atMs: OVERLAY_APPEAR_DELAY_MS - 1, hasOverlay: true },
      { atMs: OVERLAY_APPEAR_DELAY_MS, hasOverlay: false },
    ]);

    expect(start.visible).toBe(false);
    expect(midway.visible).toBe(false);
    expect(resolved.visible).toBe(false);
  });

  it("shows the overlay once the wait outlasts the appear delay", () => {
    const [, shown] = run([
      { atMs: 0, hasOverlay: true },
      { atMs: OVERLAY_APPEAR_DELAY_MS, hasOverlay: true },
    ]);

    expect(shown.visible).toBe(true);
    expect(shown.explained).toBe(false);
  });

  it("names the wait once it outlasts the explain delay", () => {
    const [, , explained] = run([
      { atMs: 0, hasOverlay: true },
      { atMs: OVERLAY_APPEAR_DELAY_MS, hasOverlay: true },
      { atMs: OVERLAY_EXPLAIN_DELAY_MS, hasOverlay: true },
    ]);

    expect(explained.visible).toBe(true);
    expect(explained.explained).toBe(true);
  });

  it("holds a shown overlay for the dwell so a run of short waits cannot strobe", () => {
    const [, , duringDwell, afterDwell] = run([
      { atMs: 0, hasOverlay: true },
      { atMs: OVERLAY_APPEAR_DELAY_MS, hasOverlay: true },
      { atMs: OVERLAY_APPEAR_DELAY_MS + 10, hasOverlay: false },
      {
        atMs: OVERLAY_APPEAR_DELAY_MS + OVERLAY_MINIMUM_DWELL_MS,
        hasOverlay: false,
      },
    ]);

    expect(duringDwell.visible).toBe(true);
    expect(afterDwell.visible).toBe(false);
  });

  it("surfaces an error with no delay and lets it clear with no dwell", () => {
    const [errored, cleared] = run([
      { atMs: 0, hasOverlay: true, isError: true },
      { atMs: 1, hasOverlay: false },
    ]);

    expect(errored.visible).toBe(true);
    expect(errored.explained).toBe(true);
    expect(cleared.visible).toBe(true);
  });

  it("asks to be woken when the gate would change with no new input", () => {
    const [pending] = run([{ atMs: 0, hasOverlay: true }]);

    expect(pending.wakeInMs).toBe(OVERLAY_APPEAR_DELAY_MS);
  });
});
