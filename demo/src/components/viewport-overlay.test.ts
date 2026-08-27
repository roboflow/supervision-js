import { describe, expect, it } from "vitest";
import { MediaSessionActivityKind } from "supervision";

import {
  BACKGROUND_ACTIVITY_KINDS,
  selectViewportSessionState,
} from "./viewport-overlay";

function sessionWith(kinds: readonly MediaSessionActivityKind[]) {
  return {
    activities: kinds.map((kind) => ({ kind })),
  } as unknown as Parameters<typeof selectViewportSessionState>[0];
}

describe("BACKGROUND_ACTIVITY_KINDS", () => {
  it("keeps a stopped picture out of the background", () => {
    // A picture that has stopped while the next bytes arrive is the viewer
    // waiting, and on a remote source it stops for hundreds of milliseconds at
    // a time with nothing else on screen to say so.
    expect(
      BACKGROUND_ACTIVITY_KINDS.has(MediaSessionActivityKind.PlaybackBuffering),
    ).toBe(false);
  });

  it("leaves the work the picture never waits for in the background", () => {
    for (const kind of [
      MediaSessionActivityKind.DetectionsBuffering,
      MediaSessionActivityKind.DetectionsLoading,
      MediaSessionActivityKind.RenderPreparing,
    ]) {
      expect(BACKGROUND_ACTIVITY_KINDS.has(kind)).toBe(true);
    }
  });

  it("passes a buffering picture through to the viewport", () => {
    const state = selectViewportSessionState(
      sessionWith([
        MediaSessionActivityKind.PlaybackBuffering,
        MediaSessionActivityKind.RenderPreparing,
      ]),
    );

    expect(state?.activities.map((activity) => activity.kind)).toStrictEqual([
      MediaSessionActivityKind.PlaybackBuffering,
    ]);
  });
});
