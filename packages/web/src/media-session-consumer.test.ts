import { describe, expect, it, vi } from "vitest";

import {
  createContainer,
  createMockSample,
  mediaMock,
  pixiMock,
  resetMocks,
} from "../../../test/media-renderer-harness";

describe("media session consumer workflows", () => {
  it("creates a session, appends detections, seeks, updates styles, and destroys cleanly", async () => {
    resetMocks();
    mediaMock.samples = [createMockSample(0, 0), createMockSample(0.5, 0)];
    const {
      annotationRenderers,
      BaseBoxStyle,
      createMediaSession,
      DetectionFrameSelectionMode,
      MediaSessionStatus,
    } = await import("./index");
    const session = await createMediaSession({
      container: createContainer(),
      detections: {
        appendable: {
          datasetId: "consumer-session",
        },
        sync: {
          frameRate: 2,
          selectionMode: DetectionFrameSelectionMode.NearestFrameIndex,
        },
      },
      media: "sample.mp4",
      renderer: {
        autoPlay: false,
        loop: false,
      },
    });

    await expect(
      session.appendDetectionFrames([
        {
          detections: [
            {
              className: "player",
              confidence: 0.93,
              id: "player-1",
              rect: { height: 40, width: 30, x: 25, y: 40 },
            },
          ],
          endTime: 0.5,
          frameIndex: 0,
          mediaTime: 0,
        },
        {
          detections: [
            {
              className: "ball",
              confidence: 0.88,
              id: "ball-1",
              rect: { height: 12, width: 12, x: 106, y: 126 },
            },
          ],
          endTime: 1,
          frameIndex: 1,
          mediaTime: 0.5,
        },
      ]),
    ).resolves.toMatchObject({
      datasetId: "consumer-session",
      detectionCount: 2,
      frameCount: 2,
    });

    await session.seek(0.5);

    expect(session.getState()).toMatchObject({
      playbackBlocked: false,
      renderer: {
        activeDetectionCount: 1,
        activeDetectionFrameIndex: 1,
        currentTime: 0.5,
      },
    });

    session.setPresentation({
      renderers: [
        annotationRenderers.box({
          style: new BaseBoxStyle({
            stroke: {
              alpha: 0.75,
              color: 0xff00ff,
              width: 6,
            },
          }),
        }),
      ],
    });

    const boxGraphics = pixiMock.graphicsInstances[0];

    expect(boxGraphics.rect).toHaveBeenLastCalledWith(100, 120, 12, 12);
    expect(boxGraphics.stroke).toHaveBeenLastCalledWith({
      alpha: 0.75,
      color: 0xff00ff,
      width: 12,
    });
    expect(session.getDetectionSummary()).toMatchObject({
      datasetId: "consumer-session",
      detectionCount: 2,
      frameCount: 2,
    });

    session.destroy();

    expect(session.getState()).toMatchObject({
      status: MediaSessionStatus.Destroyed,
    });
    expect(pixiMock.appDestroy).toHaveBeenCalledOnce();
    expect(mediaMock.dispose).toHaveBeenCalledOnce();
  });

  it("forwards the mask halo renderer style from session presentation", async () => {
    resetMocks();
    mediaMock.samples = [createMockSample(0, 0)];
    // Node lacks createImageBitmap; stubbing it lets the prepared pipeline
    // take the PngIdMask path the halo depends on.
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ close: vi.fn(), height: 2, width: 2 })),
    );

    const { annotationRenderers, createMediaSession, DetectionMaskEncoding } =
      await import("./index");
    const haloResolve = vi.fn(() => ({
      alpha: 0.6,
      color: 0x8b5cf6,
      spread: 12,
    }));
    const session = await createMediaSession({
      container: createContainer(),
      detections: {
        frames: [
          {
            detections: [
              {
                className: "player",
                mask: {
                  counts: "021",
                  encoding: DetectionMaskEncoding.CompressedRle,
                  height: 2,
                  width: 2,
                },
                rect: { height: 30, width: 20, x: 20, y: 30 },
              },
            ],
            frameIndex: 0,
            mediaTime: 0,
          },
        ],
      },
      media: "sample.mp4",
      presentation: {
        renderers: [
          annotationRenderers.maskHalo({ style: { resolve: haloResolve } }),
        ],
      },
    });

    // The session must forward the resolved halo style into the renderer;
    // dropping it silently disabled the halo for every session consumer.
    await vi.waitFor(() => {
      expect(haloResolve).toHaveBeenCalled();
    });

    await vi.waitFor(() => {
      const haloMesh = pixiMock.meshInstances.find(
        (mesh) =>
          mesh.visible && (mesh as { filters?: unknown }).filters !== undefined,
      );

      expect(haloMesh).toBeDefined();
    });

    session.destroy();
    // Restore the node default so later tests take the RGBA fallback again.
    vi.stubGlobal("createImageBitmap", undefined);
  });

  it("delivers detection picks through session interaction callbacks", async () => {
    resetMocks();
    mediaMock.samples = [createMockSample(0, 0)];
    const { createMediaSession, DetectionPickTarget, MediaInteractionMode } =
      await import("./index");
    const onHover = vi.fn();
    const onSelect = vi.fn();
    const session = await createMediaSession({
      container: createContainer(),
      detections: {
        frames: [
          {
            detections: [
              {
                className: "player",
                id: "player-1",
                rect: { height: 30, width: 20, x: 20, y: 30 },
              },
            ],
            frameIndex: 0,
            mediaTime: 0,
          },
        ],
      },
      media: "sample.mp4",
      renderer: {
        autoPlay: false,
        interaction: {
          mode: MediaInteractionMode.Always,
          onHover,
          onSelect,
        },
      },
    });
    const interactionContainer = pixiMock.containerInstances.find(
      (container) => container.eventMode === "static",
    );

    expect(interactionContainer).toBeDefined();

    const pointerMove = interactionContainer?.on.mock.calls.find(
      ([eventName]) => eventName === "pointermove",
    )?.[1] as ((event: unknown) => void) | undefined;
    const pointerTap = interactionContainer?.on.mock.calls.find(
      ([eventName]) => eventName === "pointertap",
    )?.[1] as ((event: unknown) => void) | undefined;
    const pointerEvent = {
      getLocalPosition(container: unknown) {
        expect(container).toBe(interactionContainer);
        return { x: 15, y: 20 };
      },
    };

    pointerMove?.(pointerEvent);
    pointerTap?.(pointerEvent);

    expect(onHover).toHaveBeenLastCalledWith(
      expect.objectContaining({
        detection: expect.objectContaining({ id: "player-1" }),
        detectionIndex: 0,
        target: DetectionPickTarget.Label,
      }),
    );
    expect(onSelect).toHaveBeenLastCalledWith(
      expect.objectContaining({
        detection: expect.objectContaining({ id: "player-1" }),
        detectionIndex: 0,
        target: DetectionPickTarget.Label,
      }),
    );

    session.destroy();
  });

  it("keeps multiple media sessions independent on one page", async () => {
    resetMocks();
    mediaMock.samples = [createMockSample(0, 0), createMockSample(0.5, 0)];
    const { createMediaSession, DetectionFrameSelectionMode } =
      await import("./index");
    const firstSession = await createMediaSession({
      container: createContainer(),
      detections: {
        appendable: { datasetId: "first-session" },
        sync: {
          frameRate: 2,
          selectionMode: DetectionFrameSelectionMode.NearestFrameIndex,
        },
      },
      media: "first.mp4",
      renderer: { autoPlay: false },
    });
    const secondSession = await createMediaSession({
      container: createContainer(),
      detections: {
        appendable: { datasetId: "second-session" },
        sync: {
          frameRate: 2,
          selectionMode: DetectionFrameSelectionMode.NearestFrameIndex,
        },
      },
      media: "second.mp4",
      renderer: { autoPlay: false },
    });

    await firstSession.appendDetectionFrames([
      {
        detections: [
          {
            className: "player",
            id: "first-player",
            rect: { height: 30, width: 20, x: 20, y: 35 },
          },
        ],
        frameIndex: 1,
        mediaTime: 0.5,
      },
    ]);

    await firstSession.seek(0.5);
    await secondSession.seek(0.5);

    expect(firstSession.getState()).toMatchObject({
      renderer: {
        activeDetectionCount: 1,
        activeDetectionFrameIndex: 1,
        currentTime: 0.5,
      },
    });
    expect(secondSession.getState()).toMatchObject({
      renderer: {
        activeDetectionCount: 0,
        currentTime: 0.5,
      },
    });

    firstSession.destroy();

    expect(secondSession.getState()).toMatchObject({
      renderer: {
        currentTime: 0.5,
      },
    });
    expect(pixiMock.appDestroy).toHaveBeenCalledOnce();

    secondSession.destroy();

    expect(pixiMock.appDestroy).toHaveBeenCalledTimes(2);
    expect(mediaMock.dispose).toHaveBeenCalledTimes(2);
  });

  it("supports repeated create and destroy cycles without leaking session state", async () => {
    resetMocks();
    mediaMock.samples = [createMockSample(0, 0)];
    const { createMediaSession, MediaSessionStatus } = await import("./index");
    const container = createContainer();

    for (let index = 0; index < 25; index += 1) {
      const session = await createMediaSession({
        container,
        detections: {
          appendable: { datasetId: `cycle-${index}` },
        },
        media: `cycle-${index}.mp4`,
        renderer: { autoPlay: false },
      });

      await session.appendDetectionFrames([
        {
          detections: [{ id: `detection-${index}` }],
          frameIndex: index,
          mediaTime: 0,
        },
      ]);

      expect(session.getDetectionSummary()).toMatchObject({
        datasetId: `cycle-${index}`,
        detectionCount: 1,
        frameCount: 1,
      });

      session.destroy();

      expect(session.getState()).toMatchObject({
        status: MediaSessionStatus.Destroyed,
      });
    }

    expect(pixiMock.appDestroy).toHaveBeenCalledTimes(25);
    expect(mediaMock.dispose).toHaveBeenCalledTimes(25);
  });

  it("ignores late inference results after seek and rejects them after destroy", async () => {
    resetMocks();
    mediaMock.samples = [
      createMockSample(0, 0),
      createMockSample(0.5, 0),
      createMockSample(10, 0),
    ];
    const { createMediaSession, DetectionFrameSelectionMode } =
      await import("./index");
    const session = await createMediaSession({
      container: createContainer(),
      detections: {
        appendable: { datasetId: "late-results" },
        sync: {
          frameRate: 2,
          selectionMode: DetectionFrameSelectionMode.NearestFrameIndex,
        },
      },
      media: "sample.mp4",
      renderer: { autoPlay: false },
    });

    await session.appendDetectionFrames([
      {
        detections: [
          {
            id: "active",
            rect: { height: 20, width: 10, x: 10, y: 15 },
          },
        ],
        endTime: 1,
        frameIndex: 1,
        mediaTime: 0.5,
      },
    ]);
    await session.seek(0.5);

    expect(session.getState().renderer).toMatchObject({
      activeDetectionCount: 1,
      activeDetectionFrameIndex: 1,
      currentTime: 0.5,
    });

    await session.appendDetectionFrames([
      {
        detections: [
          {
            id: "late-future",
            rect: { height: 20, width: 10, x: 55, y: 60 },
          },
        ],
        endTime: 11,
        frameIndex: 20,
        mediaTime: 10,
      },
    ]);
    await session.seek(0.5);

    expect(session.getState().renderer).toMatchObject({
      activeDetectionCount: 1,
      activeDetectionFrameIndex: 1,
      currentTime: 0.5,
    });

    session.destroy();

    await expect(
      session.appendDetectionFrames([
        {
          detections: [{ id: "too-late" }],
          frameIndex: 2,
          mediaTime: 1,
        },
      ]),
    ).rejects.toThrow("Media session has been destroyed.");
  });
});
