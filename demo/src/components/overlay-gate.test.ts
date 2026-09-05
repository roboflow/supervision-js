import { describe, expect, it } from "vitest";

import {
  advanceOverlayGate,
  IDLE_OVERLAY_GATE,
  OVERLAY_APPEAR_DELAY_MS,
  OVERLAY_EXPLAIN_DELAY_MS,
  OVERLAY_GAP_FORGIVENESS_MS,
  OVERLAY_MINIMUM_DWELL_MS,
  type OverlayGateState,
} from "./overlay-gate";

function hold(durationMs: number) {
  return run([
    ...Array.from({ length: Math.ceil(durationMs / 10) }, (_, tick) => ({
      atMs: tick * 10,
      hasOverlay: true,
    })),
    { atMs: durationMs, hasOverlay: true },
  ]);
}

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

  /**
   * The two waits the appear delay sits between, measured on the deployed
   * preview and on the same build served from localhost: 210ms is the longest
   * a committed seek took with the frame already in hand, and 306ms is the
   * shortest one that went to the network. Both are waits the viewer sits
   * through, and only a hitch shorter than the delay stays unnamed.
   */
  it("names a seek that had the frame and one that went to the network", () => {
    expect(hold(190).some((result) => result.visible)).toBe(false);
    expect(hold(210).some((result) => result.visible)).toBe(true);
    expect(hold(306).some((result) => result.visible)).toBe(true);
  });

  /**
   * A pulled source is gated at every frame, so one stutter arrives as a train
   * of short holds with a presented frame between them. Counted separately,
   * none of them ever reaches the appear delay and a stall of any length stays
   * unnamed.
   */
  it("counts a train of holds broken by a presented frame as one wait", () => {
    const train = run([
      { atMs: 0, hasOverlay: true },
      { atMs: 50, hasOverlay: false },
      { atMs: 90, hasOverlay: true },
      { atMs: 140, hasOverlay: false },
      { atMs: 180, hasOverlay: true },
      { atMs: 230, hasOverlay: false },
      { atMs: 270, hasOverlay: true },
    ]);

    expect(train.at(-1)?.visible).toBe(true);
  });

  it("names a train and one unbroken hold of the same length alike", () => {
    const trainAt = (atMs: number) =>
      run([
        { atMs: 0, hasOverlay: true },
        { atMs: 50, hasOverlay: false },
        { atMs: 90, hasOverlay: true },
        { atMs: 140, hasOverlay: false },
        { atMs: 180, hasOverlay: true },
        { atMs, hasOverlay: true },
      ]).at(-1)?.visible;

    expect({
      afterDelay: trainAt(OVERLAY_APPEAR_DELAY_MS),
      beforeDelay: trainAt(OVERLAY_APPEAR_DELAY_MS - 1),
    }).toStrictEqual({
      afterDelay: hold(OVERLAY_APPEAR_DELAY_MS).at(-1)?.visible,
      beforeDelay: hold(OVERLAY_APPEAR_DELAY_MS - 1).at(-1)?.visible,
    });
  });

  it("starts a new wait once the picture has moved past the forgiveness window", () => {
    const resumed = run([
      { atMs: 0, hasOverlay: true },
      { atMs: 150, hasOverlay: false },
      { atMs: 150 + OVERLAY_GAP_FORGIVENESS_MS, hasOverlay: true },
      { atMs: 199 + OVERLAY_GAP_FORGIVENESS_MS, hasOverlay: true },
    ]);

    expect(resumed.at(-1)?.visible).toBe(false);
  });

  it("asks to be woken when the gate would change with no new input", () => {
    const [pending] = run([{ atMs: 0, hasOverlay: true }]);

    expect(pending.wakeInMs).toBe(OVERLAY_APPEAR_DELAY_MS);
  });
});
