import {
  MediaSessionMode,
  MediaSessionStatus,
  MediaSourceStatus,
} from "supervision-js-core";
import { describe, expect, it } from "vitest";

import { createMediaSessionStateSnapshot } from "./media-session-state";
import { MediaSessionError } from "../types/media-session";

const baseInput = {
  activeDetectionFrame: null,
  activePacketId: null,
  capabilities: {
    live: false,
    pausable: true,
    seekable: true,
    stoppable: true,
  },
  destroyed: false,
  ended: false,
  error: null,
  lastDiagnostics: null,
  mode: MediaSessionMode.File,
  opened: true,
  playing: false,
  presentedFrames: 0,
  preparedFrames: 0,
  processing: false,
  rendererBackend: "fake",
  started: true,
  stopped: false,
  timeline: { duration: 1, frameRate: 30, height: 10, width: 10 },
} as const;

describe("createMediaSessionStateSnapshot", () => {
  it("reports explicit source readiness and stable source failure detail", () => {
    const state = createMediaSessionStateSnapshot({
      ...baseInput,
      error: new MediaSessionError("source-open-failed", "file unavailable"),
      opened: false,
    });

    expect(state).toMatchObject({
      errorMessage: "file unavailable",
      media: {
        error: {
          code: "source-open-failed",
          message: "file unavailable",
          stage: "source-open",
        },
        sourceStatus: MediaSourceStatus.Error,
      },
      status: MediaSessionStatus.Error,
    });
  });

  it("keeps processor failures distinct from source readiness", () => {
    const state = createMediaSessionStateSnapshot({
      ...baseInput,
      error: new MediaSessionError("processor-failed", "model failed"),
    });

    expect(state.media.sourceStatus).toBe(MediaSourceStatus.Ready);
    expect(state.media.error?.stage).toBe("processor");
    expect(state.status).toBe(MediaSessionStatus.Error);
  });

  it("reports destroyed source state after lifecycle teardown", () => {
    const state = createMediaSessionStateSnapshot({
      ...baseInput,
      destroyed: true,
      playing: false,
    });

    expect(state.media.sourceStatus).toBe(MediaSourceStatus.Destroyed);
    expect(state.status).toBe(MediaSessionStatus.Destroyed);
  });
});
