import { describe, expect, it } from "vitest";
import {
  DetectionBufferStatus,
  MediaRendererPlaybackState,
  MediaSessionActivityKind,
  MediaSessionActivityStatus,
  MediaSessionStatus,
  type MediaRendererState,
  type MediaSessionActivity,
  type MediaSessionState,
} from "supervision";

import type { LiveReadouts } from "../hooks/live-readouts";
import type { UploadInferenceState } from "../session/demo-session-types";
import { advanceOverlayGate, IDLE_OVERLAY_GATE } from "./overlay-gate";
import {
  formatLiveCook,
  readLiveStatePresentation,
} from "./live-readout-format";
import { formatPreparedWindow, formatRequestedRange } from "./TimelineView";
import {
  BACKGROUND_ACTIVITY_KINDS,
  createViewportOverlay,
  selectViewportSessionState,
} from "./viewport-overlay";

const idleReadouts: LiveReadouts = {
  activeDetectionFrameTime: null,
  currentTime: 4,
  detectionBuffer: null,
  duration: 70,
  playbackRate: 1,
  playbackState: MediaRendererPlaybackState.Playing,
  presentedRate: 1,
  renderPreparation: null,
  seeking: false,
  sourceFrameRate: 30,
};

const mediaState = { errorMessage: null, status: "ready" };

const renderer = {
  playbackState: MediaRendererPlaybackState.Playing,
} as unknown as MediaRendererState;

function activity(
  overrides: Partial<MediaSessionActivity> &
    Pick<MediaSessionActivity, "kind" | "label">,
): MediaSessionActivity {
  return {
    blockingPlayback: false,
    blockingPresentation: false,
    status: MediaSessionActivityStatus.Running,
    ...overrides,
  };
}

function sessionState(
  activities: readonly MediaSessionActivity[],
  rendererState: MediaRendererState | null,
): MediaSessionState {
  return {
    activities,
    errorMessage: null,
    media: {},
    normalization: null,
    playbackBlocked: activities.some((entry) => entry.blockingPlayback),
    presentationBlocked: activities.some((entry) => entry.blockingPresentation),
    renderPreparation: null,
    renderer: rendererState,
    status: rendererState
      ? MediaSessionStatus.Processing
      : MediaSessionStatus.Loading,
  } as unknown as MediaSessionState;
}

function overlayFor(
  activities: readonly MediaSessionActivity[],
  rendererState: MediaRendererState | null,
) {
  return createViewportOverlay(
    selectViewportSessionState(sessionState(activities, rendererState)),
    null,
    mediaState,
  );
}

const overlayCases = [
  {
    activities: [
      activity({
        blockingPlayback: true,
        blockingPresentation: true,
        kind: MediaSessionActivityKind.MediaOpening,
        label: "Opening media",
      }),
    ],
    kind: MediaSessionActivityKind.MediaOpening,
    label: "Opening media",
    renderer: null,
  },
  {
    /* Normalizing runs before there is a renderer, so the session reports both
     * of these for the whole of it. */
    activities: [
      activity({
        blockingPlayback: true,
        blockingPresentation: true,
        kind: MediaSessionActivityKind.MediaOpening,
        label: "Opening media",
      }),
      activity({
        kind: MediaSessionActivityKind.MediaNormalizing,
        label: "Normalizing media",
        progress: 0.42,
      }),
    ],
    kind: MediaSessionActivityKind.MediaNormalizing,
    label: "Normalizing media",
    renderer: null,
  },
  {
    activities: [
      activity({
        blockingPlayback: true,
        blockingPresentation: true,
        errorMessage: "Renderer failed",
        kind: MediaSessionActivityKind.Error,
        label: "Renderer error",
        status: MediaSessionActivityStatus.Error,
      }),
    ],
    kind: MediaSessionActivityKind.Error,
    label: "Renderer error",
    renderer,
  },
] as const;

/**
 * The picture does not wait for these, so the overlay stays out of the way and
 * the control bar carries them. Each case is the readouts the bar is holding
 * while the library reports that activity.
 */
const controlBarCases = [
  {
    kind: MediaSessionActivityKind.PlaybackBuffering,
    read: () =>
      readLiveStatePresentation({
        ...idleReadouts,
        playbackState: MediaRendererPlaybackState.Buffering,
      }).label,
    reported: "Buffering",
    surface: "the State chip",
  },
  {
    kind: MediaSessionActivityKind.DetectionsBuffering,
    read: () =>
      readLiveStatePresentation({
        ...idleReadouts,
        detectionBuffer: {
          bufferEndTime: 4,
          bufferStartTime: 0,
          requestedEndTime: 14,
          requestedStartTime: 0,
          status: DetectionBufferStatus.Loading,
        },
        playbackState: MediaRendererPlaybackState.Buffering,
      } as unknown as LiveReadouts).label,
    reported: "Buffering",
    surface: "the State chip",
  },
  {
    kind: MediaSessionActivityKind.DetectionsLoading,
    read: () =>
      formatRequestedRange({
        ...idleReadouts,
        detectionBuffer: {
          bufferEndTime: 4,
          bufferStartTime: 0,
          requestedEndTime: 14,
          requestedStartTime: 0,
          status: DetectionBufferStatus.Loading,
        },
      } as unknown as LiveReadouts),
    reported: "0.00s-14.00s",
    surface: "the Requested lane",
  },
  {
    kind: MediaSessionActivityKind.RenderPreparing,
    read: () =>
      formatLiveCook({
        ...idleReadouts,
        renderPreparation: {
          artifacts: [
            {
              inFlightCount: 2,
              kind: "maskFrame",
              maxInFlightCount: 4,
              pendingCount: 16,
              preparedCount: 40,
            },
          ],
        },
      } as unknown as LiveReadouts),
    reported: "2/4 · 16q",
    surface: "the Cook chip",
  },
] as const;

describe("session activity reporting", () => {
  it("has a surface for every activity the library can report", () => {
    const reported = new Set<string>([
      ...overlayCases.map((entry) => entry.kind),
      ...controlBarCases.map((entry) => entry.kind),
    ]);

    expect([...Object.values(MediaSessionActivityKind)].sort()).toEqual(
      [...reported].sort(),
    );
  });

  it.each(overlayCases)("names $kind in the viewport overlay", (entry) => {
    const overlay = overlayFor(entry.activities, entry.renderer);

    expect(overlay?.label).toBe(entry.label);
  });

  it("shows how far along a normalization is", () => {
    const normalizing = overlayCases.find(
      (entry) => entry.kind === MediaSessionActivityKind.MediaNormalizing,
    )!;

    expect(
      overlayFor(normalizing.activities, normalizing.renderer)?.progress,
    ).toBe(0.42);
  });

  it.each(controlBarCases)("reports $kind on $surface", (entry) => {
    expect(entry.read()).toBe(entry.reported);
  });

  it("keeps background activities out of the overlay", () => {
    for (const kind of BACKGROUND_ACTIVITY_KINDS) {
      const overlay = overlayFor(
        [
          activity({
            blockingPlayback: true,
            blockingPresentation: true,
            kind,
            label: kind,
          }),
        ],
        renderer,
      );

      expect(overlay).toBeNull();
    }
  });

  it("draws no Requested band once everything asked for has arrived", () => {
    expect(
      formatRequestedRange({
        ...idleReadouts,
        detectionBuffer: {
          bufferEndTime: 14,
          bufferStartTime: 0,
          requestedEndTime: 14,
          requestedStartTime: 0,
          status: DetectionBufferStatus.Ready,
        },
      } as unknown as LiveReadouts),
    ).toBe("same as hot");
  });

  it("names a seek the playback state cannot show", () => {
    const seekingRenderer = {
      currentTime: 47.13,
      playbackState: MediaRendererPlaybackState.Paused,
      seeking: true,
    } as unknown as MediaRendererState;

    const overlay = createViewportOverlay(
      selectViewportSessionState(sessionState([], seekingRenderer)),
      null,
      mediaState,
    );

    expect(overlay?.label).toBe("Finding the frame");
    expect(overlay?.detail).toContain("47.130");
  });

  it("stays quiet once the seek has landed", () => {
    const landed = {
      currentTime: 47.13,
      playbackState: MediaRendererPlaybackState.Paused,
      seeking: false,
    } as unknown as MediaRendererState;

    expect(
      createViewportOverlay(
        selectViewportSessionState(sessionState([], landed)),
        null,
        mediaState,
      ),
    ).toBeNull();
  });

  it.each([
    { seekMs: 100, shown: false },
    { seekMs: 900, shown: true },
  ])("shows a $seekMs" + "ms seek: $shown", ({ seekMs, shown }) => {
    const seekingRenderer = (seeking: boolean) =>
      ({
        currentTime: 47.13,
        playbackState: MediaRendererPlaybackState.Paused,
        seeking,
      }) as unknown as MediaRendererState;
    const hasOverlayAt = (nowMs: number) =>
      createViewportOverlay(
        selectViewportSessionState(
          sessionState([], seekingRenderer(nowMs < seekMs)),
        ),
        null,
        mediaState,
      ) !== null;

    let gate = IDLE_OVERLAY_GATE;
    let everVisible = false;

    for (let nowMs = 0; nowMs <= seekMs + 100; nowMs += 10) {
      const result = advanceOverlayGate(
        gate,
        { hasOverlay: hasOverlayAt(nowMs), isError: false },
        nowMs,
      );

      gate = result.state;
      everVisible ||= result.visible;
    }

    expect(everVisible).toBe(shown);
  });

  it("counts inference frames in the viewport overlay", () => {
    const overlay = createViewportOverlay(
      selectViewportSessionState(sessionState([], renderer)),
      {
        completedFrames: 42,
        status: "running",
        statusLabel: "SAM3 frames streaming into cold storage",
        totalFrames: 168,
      } as unknown as UploadInferenceState,
      mediaState,
    );

    expect(overlay?.label).toBe("SAM3 frames streaming into cold storage");
    expect(overlay?.detail).toBe("42/168 frames");
    expect(overlay?.progress).toBe(0.25);
  });

  it("reports an unavailable prepared window rather than a blank one", () => {
    expect(formatPreparedWindow(idleReadouts)).toBe("unavailable");
  });
});
