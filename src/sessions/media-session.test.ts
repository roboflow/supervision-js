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
  it("creates a renderer and owned writable detection source", async () => {
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
