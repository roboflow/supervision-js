import { describe, expect, it, vi } from "vitest";

import type {
  ColdDetectionFrameStore,
  ColdDetectionFrameStoreWriteSummary,
} from "supervision-js-core";
import type { DetectionFrame } from "supervision-js-core";
import { DetectionMaskEncoding } from "supervision-js-core";
import {
  MediaSessionActivityKind,
  MediaSessionStatus,
} from "#types/media-session";

import {
  createContainer,
  mediaMock,
  pixiMock,
  resetMocks,
} from "../../../../test/media-renderer-harness";

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
  it("owns video navigation, playback rate, and current-frame refresh", async () => {
    resetMocks();
    const { createMediaSession } = await import("../index");

    const session = await createMediaSession({
      container: createContainer(),
      media: "sample.mp4",
      renderer: { autoPlay: false },
    });

    session.setPlaybackRate(1.5);
    expect(session.getState().renderer).toMatchObject({ playbackRate: 1.5 });

    await session.stepForward();
    expect(session.getState().renderer).toMatchObject({ currentTime: 0.04 });

    await session.stepBackward();
    expect(session.getState().renderer).toMatchObject({ currentTime: 0 });

    await expect(session.refresh()).resolves.toBeUndefined();
    session.destroy();
  });

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

  it("projects initial detection frames into media space", async () => {
    resetMocks();
    const { createMediaSession } = await import("../index");

    const session = await createMediaSession({
      container: createContainer(),
      detections: {
        frames: [
          {
            coordinateSpace: { height: 360, width: 640 },
            detections: [
              {
                id: "half-space",
                rect: { height: 36, width: 64, x: 32, y: 18 },
              },
            ],
            endTime: 1,
            frameIndex: 0,
            mediaTime: 0,
          },
        ],
      },
      media: "sample.mp4",
      renderer: { autoPlay: false },
    });

    expect(session.renderer.getActiveDetectionFrame()).toMatchObject({
      coordinateSpace: { height: 720, width: 1280 },
      detections: [{ rect: { height: 72, width: 128, x: 64, y: 36 } }],
    });

    session.destroy();
  });

  it("projects a caller-owned detection source and leaves masks alone", async () => {
    resetMocks();
    const { createMediaSession } = await import("../index");

    const mask = {
      counts: "abc",
      encoding: DetectionMaskEncoding.CompressedRle,
      height: 90,
      width: 160,
    } as const;
    const session = await createMediaSession({
      container: createContainer(),
      detections: {
        source: {
          async loadFrames() {
            return [
              {
                coordinateSpace: { height: 360, width: 640 },
                detections: [
                  {
                    id: "scaled",
                    mask,
                    polygon: {
                      points: [
                        { x: 32, y: 18 },
                        { x: 64, y: 36 },
                        { x: 96, y: 54 },
                      ],
                    },
                  },
                ],
                endTime: 0.5,
                frameIndex: 0,
                mediaTime: 0,
              },
              {
                detections: [
                  {
                    id: "already-media-space",
                    polygon: {
                      points: [
                        { x: 8, y: 4 },
                        { x: 16, y: 8 },
                        { x: 24, y: 12 },
                      ],
                    },
                  },
                ],
                endTime: 1,
                frameIndex: 1,
                mediaTime: 0.5,
              },
            ];
          },
        },
      },
      media: "sample.mp4",
      renderer: { autoPlay: false },
    });

    await session.refresh();

    expect(session.renderer.getActiveDetectionFrame()).toMatchObject({
      detections: [
        {
          id: "scaled",
          // Masks carry their own dimensions and must not be scaled again.
          mask,
          polygon: {
            points: [
              { x: 64, y: 36 },
              { x: 128, y: 72 },
              { x: 192, y: 108 },
            ],
          },
        },
      ],
    });

    session.destroy();
  });

  it("projects composite children from their own coordinate spaces", async () => {
    resetMocks();
    const { createMediaSession } = await import("../index");

    const mask = {
      counts: "abc",
      encoding: DetectionMaskEncoding.CompressedRle,
      height: 90,
      width: 160,
    } as const;
    const session = await createMediaSession({
      container: createContainer(),
      detections: {
        sources: [
          {
            frames: [
              {
                coordinateSpace: { height: 360, width: 640 },
                detections: [
                  {
                    id: "half",
                    mask,
                    rect: { height: 36, width: 64, x: 320, y: 180 },
                  },
                ],
                endTime: 1,
                mediaTime: 0,
              },
            ],
            id: "half-space",
          },
          {
            frames: [
              {
                coordinateSpace: { height: 180, width: 320 },
                detections: [
                  {
                    id: "quarter",
                    rect: { height: 9, width: 16, x: 80, y: 45 },
                  },
                ],
                endTime: 1,
                mediaTime: 0,
              },
            ],
            id: "quarter-space",
          },
          {
            frames: [
              {
                detections: [
                  {
                    id: "media",
                    rect: { height: 36, width: 64, x: 320, y: 180 },
                  },
                ],
                endTime: 1,
                mediaTime: 0,
              },
            ],
            id: "media-space",
          },
        ],
      },
      media: "sample.mp4",
      renderer: { autoPlay: false },
    });

    await session.refresh();

    expect(session.renderer.getActiveDetectionFrame()).toMatchObject({
      detections: [
        {
          id: "half",
          // Masks carry their own dimensions and must not be scaled again.
          mask,
          rect: { height: 72, width: 128, x: 640, y: 360 },
        },
        { id: "quarter", rect: { height: 36, width: 64, x: 320, y: 180 } },
        { id: "media", rect: { height: 36, width: 64, x: 320, y: 180 } },
      ],
    });

    session.destroy();
  });

  it("leaves a detection source without coordinate metadata untouched", async () => {
    resetMocks();
    const { createMediaSession } = await import("../index");

    const session = await createMediaSession({
      container: createContainer(),
      detections: {
        source: {
          async loadFrames() {
            return [
              {
                detections: [
                  {
                    id: "already-media-space",
                    polygon: {
                      points: [
                        { x: 8, y: 4 },
                        { x: 16, y: 8 },
                        { x: 24, y: 12 },
                      ],
                    },
                  },
                ],
                endTime: 1,
                frameIndex: 0,
                mediaTime: 0,
              },
            ];
          },
        },
      },
      media: "sample.mp4",
      renderer: { autoPlay: false },
    });

    await session.refresh();

    expect(session.renderer.getActiveDetectionFrame()).toMatchObject({
      detections: [
        {
          id: "already-media-space",
          polygon: {
            points: [
              { x: 8, y: 4 },
              { x: 16, y: 8 },
              { x: 24, y: 12 },
            ],
          },
        },
      ],
    });

    session.destroy();
  });

  it("projects appended detections from their declared coordinate space", async () => {
    resetMocks();
    const { createMediaSession } = await import("../index");

    const session = await createMediaSession({
      container: createContainer(),
      detections: { appendable: { datasetId: "projected" } },
      media: "sample.mp4",
      renderer: { autoPlay: false },
    });

    const mask = {
      counts: "abc",
      encoding: DetectionMaskEncoding.CompressedRle,
      height: 90,
      width: 160,
    } as const;

    await session.appendDetectionFrames([
      {
        // Half the session's 1280x720 media space.
        coordinateSpace: { height: 360, width: 640 },
        detections: [
          {
            id: "scaled",
            keypoints: { edges: [], points: [{ x: 10, y: 20 }] },
            mask,
            polygon: {
              points: [
                { x: 0, y: 0 },
                { x: 64, y: 0 },
                { x: 64, y: 36 },
              ],
            },
            polyline: {
              points: [
                { x: 4, y: 8 },
                { x: 8, y: 16 },
              ],
            },
            rect: { height: 36, width: 64, x: 320, y: 180 },
          },
        ],
        endTime: 0.5,
        frameIndex: 0,
        mediaTime: 0,
      },
      {
        detections: [
          {
            id: "already-media-space",
            rect: { height: 36, width: 64, x: 320, y: 180 },
          },
        ],
        endTime: 1,
        frameIndex: 1,
        mediaTime: 0.5,
      },
    ]);

    const stored = await session.detectionSource?.loadFrames(0, 1);

    expect(stored?.[0]).toMatchObject({
      coordinateSpace: { height: 720, width: 1280 },
      detections: [
        {
          keypoints: { points: [{ x: 20, y: 40 }] },
          // Masks carry their own dimensions and must not be scaled again.
          mask,
          polygon: {
            points: [
              { x: 0, y: 0 },
              { x: 128, y: 0 },
              { x: 128, y: 72 },
            ],
          },
          polyline: {
            points: [
              { x: 8, y: 16 },
              { x: 16, y: 32 },
            ],
          },
          rect: { height: 72, width: 128, x: 640, y: 360 },
        },
      ],
    });
    expect(stored?.[1]).toMatchObject({
      detections: [{ rect: { height: 36, width: 64, x: 320, y: 180 } }],
    });
    expect(stored?.[1]?.coordinateSpace).toBeUndefined();

    session.destroy();
  });

  it("holds the newest live detection frame until the next one arrives", async () => {
    resetMocks();
    const { createMediaSession } = await import("../index");

    const session = await createMediaSession({
      container: createContainer(),
      detections: {
        appendable: { datasetId: "live", live: { holdSeconds: 10 } },
      },
      media: "sample.mp4",
      renderer: { autoPlay: false },
    });

    await session.appendLiveDetectionFrame({
      detections: [{ id: "first" }],
      frameIndex: 0,
      mediaTime: 0,
    });
    await session.appendLiveDetectionFrame({
      detections: [{ id: "second" }],
      frameIndex: 1,
      mediaTime: 0.2,
    });

    expect(await session.detectionSource?.loadFrames(0, 20)).toEqual([
      {
        detections: [{ id: "first" }],
        endTime: 0.2,
        frameIndex: 0,
        mediaTime: 0,
      },
      {
        detections: [{ id: "second" }],
        endTime: 10.2,
        frameIndex: 1,
        mediaTime: 0.2,
      },
    ]);

    session.destroy();
  });

  it("finalizes detection coverage at the reported media duration", async () => {
    resetMocks();
    const { createMediaSession } = await import("../index");

    const session = await createMediaSession({
      container: createContainer(),
      detections: { appendable: { datasetId: "finalized" } },
      media: "sample.mp4",
      renderer: { autoPlay: false },
    });

    await session.appendDetectionFrames([
      {
        detections: [{ id: "last" }],
        endTime: 0.9,
        frameIndex: 0,
        mediaTime: 0.8,
      },
    ]);

    await expect(session.finalizeDetectionCoverage()).resolves.toMatchObject({
      endTime: 1,
    });
    expect(await session.detectionSource?.loadFrames(0, 1)).toEqual([
      {
        detections: [{ id: "last" }],
        endTime: 1,
        frameIndex: 0,
        mediaTime: 0.8,
      },
    ]);

    // Idempotent: a second call has nothing left to close.
    await expect(session.finalizeDetectionCoverage()).resolves.toMatchObject({
      endTime: 1,
    });

    session.destroy();
  });

  it("redraws when finalizing coverage changes the displayed instant", async () => {
    resetMocks();
    const { createMediaSession } = await import("../index");

    const session = await createMediaSession({
      container: createContainer(),
      detections: { appendable: { datasetId: "finalized-refresh" } },
      media: "sample.mp4",
      renderer: { autoPlay: false },
    });

    await session.appendDetectionFrames([
      { detections: [{ id: "open" }], frameIndex: 0, mediaTime: 0 },
    ]);

    const refresh = vi
      .spyOn(session.renderer, "refresh")
      .mockResolvedValue(undefined);

    // Finalizing closes the frame the displayed instant is showing, so it is a
    // write like any other and has to redraw.
    await session.finalizeDetectionCoverage();

    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));

    refresh.mockRestore();
    session.destroy();
  });

  it("coalesces refreshes for detections that cover the displayed time", async () => {
    resetMocks();
    const { createMediaSession } = await import("../index");

    const session = await createMediaSession({
      container: createContainer(),
      detections: { appendable: { datasetId: "refresh" } },
      media: "sample.mp4",
      renderer: { autoPlay: false },
    });
    let resolveRefresh: (() => void) | undefined;
    const refresh = vi
      .spyOn(session.renderer, "refresh")
      .mockImplementation(
        () => new Promise<void>((resolve) => (resolveRefresh = resolve)),
      );

    await session.appendDetectionFrames([
      { detections: [{ id: "a" }], endTime: 0.5, frameIndex: 0, mediaTime: 0 },
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);

    // Requests arriving while a redraw is in flight collapse into one.
    await session.appendDetectionFrames([
      { detections: [{ id: "b" }], endTime: 0.5, frameIndex: 1, mediaTime: 0 },
    ]);
    await session.appendDetectionFrames([
      { detections: [{ id: "c" }], endTime: 0.5, frameIndex: 2, mediaTime: 0 },
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);

    resolveRefresh?.();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    resolveRefresh?.();

    // Detections elsewhere on the timeline never force a render.
    await session.appendDetectionFrames([
      {
        detections: [{ id: "far" }],
        endTime: 51,
        frameIndex: 9,
        mediaTime: 50,
      },
    ]);
    expect(refresh).toHaveBeenCalledTimes(2);

    refresh.mockRestore();
    session.destroy();
  });

  it("redraws for an accepted live frame that covers the displayed time", async () => {
    resetMocks();
    const { createMediaSession } = await import("../index");

    const session = await createMediaSession({
      container: createContainer(),
      detections: { appendable: { datasetId: "live-refresh" } },
      media: "sample.mp4",
      renderer: { autoPlay: false },
    });
    const refresh = vi
      .spyOn(session.renderer, "refresh")
      .mockResolvedValue(undefined);

    await session.appendLiveDetectionFrame({
      detections: [{ id: "live" }],
      frameIndex: 0,
      mediaTime: 0,
    });

    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));

    refresh.mockRestore();
    session.destroy();
  });

  it("does not redraw for a live frame that starts after the displayed time", async () => {
    resetMocks();
    const { createMediaSession } = await import("../index");

    const session = await createMediaSession({
      container: createContainer(),
      detections: { appendable: { datasetId: "future-live-refresh" } },
      media: "sample.mp4",
      renderer: { autoPlay: false },
    });
    const refresh = vi
      .spyOn(session.renderer, "refresh")
      .mockResolvedValue(undefined);

    // The renderer is presenting time zero, so a result held open from five
    // seconds ahead cannot be the frame selected for it.
    await session.appendLiveDetectionFrame({
      detections: [{ id: "future" }],
      frameIndex: 0,
      mediaTime: 5,
    });

    expect(refresh).not.toHaveBeenCalled();

    refresh.mockRestore();
    session.destroy();
  });

  it("redraws for an open-ended frame appended behind the displayed time", async () => {
    resetMocks();
    const { createMediaSession } = await import("../index");

    const session = await createMediaSession({
      container: createContainer(),
      detections: { appendable: { datasetId: "open-ended-refresh" } },
      media: "sample.mp4",
      renderer: { autoPlay: false },
    });

    await session.stepForward();

    const refresh = vi
      .spyOn(session.renderer, "refresh")
      .mockResolvedValue(undefined);

    // A frame written without an `endTime` stays selected until a later frame
    // supersedes it, so one appended behind the presented frame is what the
    // renderer will now show.
    await session.appendDetectionFrames([
      { detections: [{ id: "open" }], frameIndex: 0, mediaTime: 0 },
    ]);

    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));

    refresh.mockRestore();
    session.destroy();
  });

  it("does not redraw for a closed frame that ended before the displayed time", async () => {
    resetMocks();
    const { createMediaSession } = await import("../index");

    const session = await createMediaSession({
      container: createContainer(),
      detections: { appendable: { datasetId: "closed-refresh" } },
      media: "sample.mp4",
      renderer: { autoPlay: false },
    });

    await session.stepForward();

    const refresh = vi
      .spyOn(session.renderer, "refresh")
      .mockResolvedValue(undefined);

    // The same frame with an explicit end is never selected at the presented
    // time, so it must not force a render.
    await session.appendDetectionFrames([
      {
        detections: [{ id: "closed" }],
        endTime: 0.01,
        frameIndex: 0,
        mediaTime: 0,
      },
    ]);

    expect(refresh).not.toHaveBeenCalled();

    refresh.mockRestore();
    session.destroy();
  });

  it("does not redraw for a stale live result the source dropped", async () => {
    resetMocks();
    const { createMediaSession } = await import("../index");

    const session = await createMediaSession({
      container: createContainer(),
      detections: { appendable: { datasetId: "stale-live-refresh" } },
      media: "sample.mp4",
      renderer: { autoPlay: false },
    });

    await session.appendLiveDetectionFrame({
      detections: [{ id: "current" }],
      frameIndex: 1,
      mediaTime: 2,
    });

    const refresh = vi
      .spyOn(session.renderer, "refresh")
      .mockResolvedValue(undefined);

    await session.appendLiveDetectionFrame({
      detections: [{ id: "stale" }],
      frameIndex: 0,
      mediaTime: 1,
    });

    expect(refresh).not.toHaveBeenCalled();

    refresh.mockRestore();
    session.destroy();
  });

  it("does not redraw for live coverage that already expired before the displayed time", async () => {
    resetMocks();
    const { createMediaSession } = await import("../index");

    const session = await createMediaSession({
      container: createContainer(),
      detections: {
        appendable: {
          datasetId: "expired-live-refresh",
          live: { holdSeconds: 0.01 },
        },
      },
      media: "sample.mp4",
      renderer: { autoPlay: false },
    });

    await session.stepForward();

    const refresh = vi
      .spyOn(session.renderer, "refresh")
      .mockResolvedValue(undefined);

    // The hold expires well before the presented frame, so this result is not
    // what is on screen and must not force a render.
    await session.appendLiveDetectionFrame({
      detections: [{ id: "expired" }],
      frameIndex: 0,
      mediaTime: 0,
    });

    expect(refresh).not.toHaveBeenCalled();

    refresh.mockRestore();
    session.destroy();
  });

  it("leaves every redraw to the host when auto refresh is disabled", async () => {
    resetMocks();
    const { createMediaSession } = await import("../index");

    const session = await createMediaSession({
      container: createContainer(),
      detections: {
        appendable: { datasetId: "manual-refresh" },
        autoRefresh: false,
      },
      media: "sample.mp4",
      renderer: { autoPlay: false },
    });
    const refresh = vi
      .spyOn(session.renderer, "refresh")
      .mockResolvedValue(undefined);

    await session.appendDetectionFrames([
      { detections: [{ id: "a" }], endTime: 0.5, frameIndex: 0, mediaTime: 0 },
    ]);

    expect(refresh).not.toHaveBeenCalled();

    await session.refresh();
    expect(refresh).toHaveBeenCalledTimes(1);

    refresh.mockRestore();
    session.destroy();
  });

  it("routes append, replace, and clear calls to named appendable sources", async () => {
    resetMocks();
    const { createMediaSession } = await import("../index");

    const session = await createMediaSession({
      container: createContainer(),
      detections: {
        sources: [
          {
            appendable: { datasetId: "predictions" },
            id: "predictions",
          },
          {
            appendable: { datasetId: "drawing" },
            id: "drawing",
            order: 10,
          },
        ],
      },
      media: "sample.mp4",
      renderer: { autoPlay: false },
    });

    await expect(
      session.appendDetectionFrames(
        [
          {
            detections: [{ className: "prediction", id: "p0" }],
            endTime: 1,
            mediaTime: 0,
          },
        ],
        { sourceId: "predictions" },
      ),
    ).resolves.toMatchObject({
      datasetId: "predictions",
      detectionCount: 1,
    });
    await session.appendDetectionFrames(
      [
        {
          detections: [{ className: "drawing", id: "d0" }],
          endTime: 1,
          mediaTime: 0,
        },
      ],
      { sourceId: "drawing" },
    );

    expect(await session.detectionSource?.loadFrames(0, 1)).toEqual([
      expect.objectContaining({
        detections: [
          expect.objectContaining({
            className: "prediction",
            sourceId: "predictions",
          }),
          expect.objectContaining({
            className: "drawing",
            sourceId: "drawing",
          }),
        ],
      }),
    ]);

    await session.replaceDetectionFrames(
      [
        {
          detections: [{ className: "replaced", id: "d1" }],
          endTime: 1,
          mediaTime: 0,
        },
      ],
      { sourceId: "drawing" },
    );
    await session.clearDetectionFrames({ sourceId: "predictions" });

    expect(await session.detectionSource?.loadFrames(0, 1)).toEqual([
      expect.objectContaining({
        detections: [
          expect.objectContaining({
            className: "replaced",
            sourceDetectionIndex: 0,
            sourceId: "drawing",
          }),
        ],
      }),
    ]);

    session.destroy();
  });

  it("requires sourceId when writing to multiple appendable sources", async () => {
    resetMocks();
    const { createMediaSession } = await import("../index");

    const session = await createMediaSession({
      container: createContainer(),
      detections: {
        sources: [
          {
            appendable: { datasetId: "one" },
            id: "one",
          },
          {
            appendable: { datasetId: "two" },
            id: "two",
          },
        ],
      },
      media: "sample.mp4",
      renderer: { autoPlay: false },
    });

    await expect(session.appendDetectionFrames(frames)).rejects.toThrow(
      "sourceId is required when a media session owns multiple appendable detection sources.",
    );
    await expect(
      session.appendDetectionFrames(frames, { sourceId: "missing" }),
    ).rejects.toThrow("Unknown appendable detection source: missing.");

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

  it("rejects multi-source detections combined with legacy single-source inputs", async () => {
    resetMocks();
    const { createMediaSession } = await import("../index");

    await expect(
      createMediaSession({
        container: createContainer(),
        detections: {
          frames,
          sources: [{ frames: [], id: "extra" }],
        },
        media: "sample.mp4",
        renderer: { autoPlay: false },
      }),
    ).rejects.toThrow(
      "Provide either detections.sources or one legacy detection input.",
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
        errorMessage:
          "The media source's tracks read and none of them carries video.",
        status: MediaSessionStatus.Error,
      }),
    );
    expect(failedSession.getState()).toMatchObject({
      errorMessage:
        "The media source's tracks read and none of them carries video.",
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
