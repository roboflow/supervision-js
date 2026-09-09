import { describe, expect, it } from "vitest";
import { MediaSessionActivityKind } from "supervision";

import { selectViewportSessionState } from "./viewport-overlay";

function sessionWith(
  activities: readonly {
    readonly blockingPlayback: boolean;
    readonly kind: MediaSessionActivityKind;
  }[],
) {
  return {
    activities,
  } as unknown as Parameters<typeof selectViewportSessionState>[0];
}

describe("selectViewportSessionState", () => {
  it("leaves work that runs behind a moving picture off the viewport", () => {
    const state = selectViewportSessionState(
      sessionWith([
        { blockingPlayback: true, kind: MediaSessionActivityKind.MediaOpening },
        {
          blockingPlayback: false,
          kind: MediaSessionActivityKind.DetectionsLoading,
        },
        {
          blockingPlayback: false,
          kind: MediaSessionActivityKind.RenderPreparing,
        },
      ]),
    );

    expect(state?.activities.map((activity) => activity.kind)).toStrictEqual([
      MediaSessionActivityKind.MediaOpening,
    ]);
  });

  /**
   * The same subsystem is background work while the picture moves and the
   * viewer's wait once it has stopped the picture, and only the second one owes
   * the viewer an explanation.
   */
  it("shows that work once it is what stopped the picture", () => {
    const state = selectViewportSessionState(
      sessionWith([
        {
          blockingPlayback: true,
          kind: MediaSessionActivityKind.RenderPreparing,
        },
        {
          blockingPlayback: true,
          kind: MediaSessionActivityKind.DetectionsBuffering,
        },
      ]),
    );

    expect(state?.activities.map((activity) => activity.kind)).toStrictEqual([
      MediaSessionActivityKind.RenderPreparing,
      MediaSessionActivityKind.DetectionsBuffering,
    ]);
  });
});
