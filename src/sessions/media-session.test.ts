import { describe, expect, it, vi } from "vitest";

import type {
  ColdDetectionFrameStore,
  ColdDetectionFrameStoreWriteSummary,
} from "#types/detection-timeline";
import type { DetectionFrame } from "#types/detections";
import {
  MediaSessionActivityKind,
  MediaSessionStatus,
} from "#types/media-session";

import {
  createContainer,
  mediaMock,
  pixiMock,
  resetMocks,
} from "../../test/media-renderer-harness";

const frames: DetectionFrame[] = [
  {
    detections: [{ id: "ball" }],
    endTime: 1 / 30,
    frameIndex: 0,
    mediaTime: 0,
  },
];

const summary: ColdDetectionFrameStoreWriteSummary = {
  chunkCount: 1,
  chunkDurationSeconds: 1,
  datasetId: "session",
  detectionCount: 1,
  endTime: 1 / 30,
  frameCount: 1,
  startTime: 0,
};

describe("media session", () => {
  it("continues to support the writable detection source alias", async () => {
    resetMocks();
    const { createMediaSession } = await import("../index");
    const store = createStore();

    const session = await createMediaSession({
      container: createContainer(),
      detections: {
        writable: {
          chunkDurationSeconds: 1,
          datasetId: "session",
          store,
        },
      },
      media: "sample.mp4",
      renderer: { autoPlay: false },
    });

    await expect(session.appendDetectionFrames(frames)).resolves.toEqual(
      summary,
    );
    expect(store.appendFrames).toHaveBeenCalledWith({
      chunkDurationSeconds: 1,
      datasetId: "session",
      frames,
    });
    expect(session.getDetectionSummary()).toEqual(summary);
    expect(mediaMock.urlSourceConstructor).toHaveBeenCalledWith("sample.mp4");

    session.destroy();

    expect(pixiMock.appDestroy).toHaveBeenCalledOnce();
    expect(store.destroy).toHaveBeenCalledOnce();
  });

  it("can own an in-memory appendable detection source by default", async () => {
    resetMocks();
    const { createMediaSession } = await import("../index");

    const session = await createMediaSession({
      container: createContainer(),
      detections: {
        appendable: {
          datasetId: "memory-session",
        },
      },
      media: "sample.mp4",
      renderer: { autoPlay: false },
    });

    const writeSummary = await session.appendDetectionFrames(frames);

    expect(writeSummary).toMatchObject({
      datasetId: "memory-session",
      detectionCount: 1,
      frameCount: 1,
    });
    expect(await session.detectionSource?.loadFrames(0, 1)).toEqual(frames);

    session.destroy();
  });

  it("rejects ambiguous appendable and writable detection inputs", async () => {
    resetMocks();
    const { createMediaSession } = await import("../index");

    await expect(
      createMediaSession({
        container: createContainer(),
        detections: {
          appendable: { datasetId: "appendable" },
          writable: { datasetId: "writable" },
        },
        media: "sample.mp4",
        renderer: { autoPlay: false },
      }),
    ).rejects.toThrow(
      "Provide only one media session appendable detection option.",
    );
  });

  it("emits aggregate state and exposes it from the session", async () => {
    resetMocks();
    const { createMediaSession } = await import("../index");
    const onState = vi.fn();

    const session = await createMediaSession({
      container: createContainer(),
      media: "sample.mp4",
      onState,
      renderer: { autoPlay: false },
    });

    expect(onState).toHaveBeenCalledWith(
      expect.objectContaining({
        activities: [
          expect.objectContaining({
            kind: MediaSessionActivityKind.MediaOpening,
          }),
        ],
        renderer: null,
        status: MediaSessionStatus.Loading,
      }),
    );
    expect(session.getState()).toMatchObject({
      activities: [],
      renderer: expect.objectContaining({
        currentTime: 0,
      }),
      status: MediaSessionStatus.Ready,
    });

    session.destroy();

    expect(session.getState()).toMatchObject({
      status: MediaSessionStatus.Destroyed,
    });
    expect(onState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: MediaSessionStatus.Destroyed,
      }),
    );
  });

  it("lets consumers subscribe to aggregate state after creation", async () => {
    resetMocks();
    const { createMediaSession } = await import("../index");
    const listener = vi.fn();

    const session = await createMediaSession({
      container: createContainer(),
      media: "sample.mp4",
      renderer: { autoPlay: false },
    });

    const unsubscribe = session.subscribe(listener);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: MediaSessionStatus.Ready,
      }),
    );

    session.destroy();

    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: MediaSessionStatus.Destroyed,
      }),
    );

    unsubscribe();
  });

  it("stops sending session state after unsubscribe", async () => {
    resetMocks();
    const { createMediaSession } = await import("../index");
    const listener = vi.fn();

    const session = await createMediaSession({
      container: createContainer(),
      media: "sample.mp4",
      renderer: { autoPlay: false },
    });

    const unsubscribe = session.subscribe(listener);

    listener.mockClear();
    unsubscribe();
    session.destroy();

    expect(listener).not.toHaveBeenCalled();
  });

  it("revokes direct Blob object URLs when destroyed", async () => {
    resetMocks();
    const { createMediaSession } = await import("../index");
    const createObjectURL = vi.fn(() => "blob:direct-media");
    const revokeObjectURL = vi.fn();
    const originalURL = globalThis.URL;

    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });

    try {
      const session = await createMediaSession({
        container: createContainer(),
        media: new Blob(["media"], { type: "video/webm" }),
        normalize: false,
        renderer: { autoPlay: false },
      });

      expect(createObjectURL).toHaveBeenCalledOnce();
      expect(mediaMock.urlSourceConstructor).toHaveBeenCalledWith(
        "blob:direct-media",
      );

      session.destroy();

      expect(revokeObjectURL).toHaveBeenCalledWith("blob:direct-media");
    } finally {
      vi.stubGlobal("URL", originalURL);
    }
  });

  it("can destroy and recreate a session in the same container", async () => {
    resetMocks();
    const { createMediaSession, MediaSessionStatus } = await import("../index");
    const container = createContainer();

    const firstSession = await createMediaSession({
      container,
      media: "first.mp4",
      renderer: { autoPlay: false },
    });

    firstSession.destroy();

    const secondSession = await createMediaSession({
      container,
      media: "second.mp4",
      renderer: { autoPlay: false },
    });

    expect(firstSession.getState()).toMatchObject({
      status: MediaSessionStatus.Destroyed,
    });
    expect(secondSession.getState()).toMatchObject({
      status: MediaSessionStatus.Ready,
    });
    expect(mediaMock.urlSourceConstructor).toHaveBeenNthCalledWith(
      1,
      "first.mp4",
    );
    expect(mediaMock.urlSourceConstructor).toHaveBeenNthCalledWith(
      2,
      "second.mp4",
    );
    expect(pixiMock.appDestroy).toHaveBeenCalledOnce();
    expect(mediaMock.dispose).toHaveBeenCalledOnce();

    secondSession.destroy();

    expect(pixiMock.appDestroy).toHaveBeenCalledTimes(2);
    expect(mediaMock.dispose).toHaveBeenCalledTimes(2);
  });

  it("makes destroy idempotent and keeps destroyed state stable", async () => {
    resetMocks();
    const { createMediaSession, MediaSessionStatus } = await import("../index");
    const listener = vi.fn();
    const session = await createMediaSession({
      container: createContainer(),
      media: "sample.mp4",
      renderer: { autoPlay: false },
    });

    session.subscribe(listener);
    listener.mockClear();

    session.destroy();
    session.destroy();

    expect(session.getState()).toMatchObject({
      status: MediaSessionStatus.Destroyed,
    });
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: MediaSessionStatus.Destroyed }),
    );
    expect(pixiMock.appDestroy).toHaveBeenCalledOnce();
    expect(mediaMock.dispose).toHaveBeenCalledOnce();
  });

  it("rejects appends and immediately reports destroyed state after destroy", async () => {
    resetMocks();
    const { createMediaSession, MediaSessionStatus } = await import("../index");
    const session = await createMediaSession({
      container: createContainer(),
      detections: {
        appendable: {
          datasetId: "destroyed-session",
        },
      },
      media: "sample.mp4",
      renderer: { autoPlay: false },
    });

    session.destroy();

    await expect(session.appendDetectionFrames(frames)).rejects.toThrow(
      "Media session has been destroyed.",
    );

    const listener = vi.fn();
    const unsubscribe = session.subscribe(listener);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: MediaSessionStatus.Destroyed }),
    );

    unsubscribe();
  });

  it("enters error state on failed media opening and recovers for the next session", async () => {
    resetMocks();
    const { createMediaSession, MediaSessionStatus } = await import("../index");
    const onState = vi.fn();

    mediaMock.getPrimaryVideoTrack.mockResolvedValueOnce(
      undefined as unknown as Record<string, unknown>,
    );

    const failedSession = await createMediaSession({
      container: createContainer(),
      media: "broken.mp4",
      onState,
      renderer: { autoPlay: false },
    });

    expect(onState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        errorMessage: "No video track found in media source.",
        status: MediaSessionStatus.Error,
      }),
    );
    expect(failedSession.getState()).toMatchObject({
      errorMessage: "No video track found in media source.",
      status: MediaSessionStatus.Error,
    });

    const recoveredSession = await createMediaSession({
      container: createContainer(),
      media: "working.mp4",
      renderer: { autoPlay: false },
    });

    expect(recoveredSession.getState()).toMatchObject({
      errorMessage: null,
      status: MediaSessionStatus.Ready,
    });

    failedSession.destroy();
    recoveredSession.destroy();
  });
});

function createStore(): ColdDetectionFrameStore {
  return {
    appendFrames: vi.fn(async () => summary),
    clearDataset: vi.fn(async () => undefined),
    destroy: vi.fn(),
    loadFrames: vi.fn(async () => frames),
    putFrames: vi.fn(async () => summary),
  };
}
