import { describe, expect, it, vi } from "vitest";
import type {
  BoxCornerDrawInstruction,
  ClosedMarkerDrawInstruction,
} from "supervision-js-core";

import {
  createContainer,
  createMockSample,
  flushAnimationFrame,
  mediaMock,
  pixiMock,
  resetMocks,
} from "../../../test/media-renderer-harness";

describe("media session consumer workflows", () => {
  it("plays an appendable session whose predictions have not arrived", async () => {
    resetMocks();
    mediaMock.samples = [createMockSample(0, 0), createMockSample(0.04, 0)];
    const { createMediaSession, MediaRendererPlaybackState } =
      await import("./index");
    const session = await createMediaSession({
      container: createContainer(),
      detections: {
        appendable: { datasetId: "no-predictions-yet" },
      },
      media: "sample.mp4",
      renderer: {
        autoPlay: false,
        loop: false,
      },
    });

    await session.play();
    flushAnimationFrame(40);
    await vi.waitFor(() => {
      expect(mediaMock.samples[1].draw).toHaveBeenCalledOnce();
    });

    expect(session.getState()).toMatchObject({ playbackBlocked: false });
    expect(session.getState().renderer).toMatchObject({
      currentTime: 0.04,
      playbackState: MediaRendererPlaybackState.Playing,
    });

    session.destroy();
  });

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

  it("composes the ellipse renderer style with a direct region renderer", async () => {
    resetMocks();
    mediaMock.samples = [createMockSample(0, 0)];
    const { annotationRenderers, createMediaSession } = await import("./index");
    const ellipseResolve = vi.fn(() => ({
      center: { x: 30, y: 70 },
      endAngle: (235 * Math.PI) / 180,
      radiusX: 10,
      radiusY: 3.5,
      startAngle: (-45 * Math.PI) / 180,
      stroke: { alpha: 1, color: 0x8b5cf6, width: 2 },
    }));
    const session = await createMediaSession({
      container: createContainer(),
      detections: {
        frames: [
          {
            detections: [
              {
                className: "player",
                rect: { height: 40, width: 20, x: 20, y: 30 },
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
          annotationRenderers.ellipse({ style: { resolve: ellipseResolve } }),
          annotationRenderers.region({
            id: "player-badge",
            region: { kind: "bounds" },
            source: { asset: { src: "/badge.png" }, kind: "asset" },
            target: { className: "player" },
          }),
        ],
      },
    });

    // The session lowers the ellipse into its resolved style field while the
    // region keeps its direct descriptor. The renderer core must preserve both
    // when it normalizes the authoritative renderer list again.
    await vi.waitFor(() => {
      expect(ellipseResolve).toHaveBeenCalled();
    });

    await vi.waitFor(() => {
      const arcGraphics = pixiMock.graphicsInstances.find(
        (graphics) =>
          graphics.moveTo.mock.calls.length > 0 &&
          graphics.stroke.mock.calls.some(
            ([stroke]) => (stroke as { color?: number })?.color === 0x8b5cf6,
          ),
      );

      expect(arcGraphics).toBeDefined();
    });

    session.destroy();
  });

  it("forwards the mask halo renderer style from session presentation", async () => {
    resetMocks();
    mediaMock.samples = [createMockSample(0, 0)];
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
  });

  it("forwards the box-corners renderer style from session presentation", async () => {
    resetMocks();
    mediaMock.samples = [createMockSample(0, 0)];
    const { annotationRenderers, createMediaSession } = await import("./index");
    const resolve = vi.fn<() => BoxCornerDrawInstruction>(() => ({
      segments: [
        [
          { x: 10, y: 10 },
          { x: 20, y: 10 },
          { x: 20, y: 20 },
        ],
      ],
      stroke: { alpha: 1, color: 0x8b5cf6, width: 2 },
    }));
    const session = await createMediaSession({
      container: createContainer(),
      detections: {
        frames: [
          {
            detections: [
              {
                className: "player",
                rect: { height: 40, width: 20, x: 20, y: 30 },
              },
            ],
            frameIndex: 0,
            mediaTime: 0,
          },
        ],
      },
      media: "sample.mp4",
      presentation: {
        renderers: [annotationRenderers.boxCorners({ style: { resolve } })],
      },
    });

    await vi.waitFor(() => {
      expect(resolve).toHaveBeenCalled();
    });
    await vi.waitFor(() => {
      expect(
        pixiMock.graphicsInstances.some((graphics) =>
          graphics.stroke.mock.calls.some(
            ([stroke]) => (stroke as { color?: number })?.color === 0x8b5cf6,
          ),
        ),
      ).toBe(true);
    });

    session.destroy();
  });

  it("forwards the marker renderer style from session presentation", async () => {
    resetMocks();
    mediaMock.samples = [createMockSample(0, 0)];
    const {
      annotationRenderers,
      createMediaSession,
      MarkerShape,
      MarkerSizeSpace,
    } = await import("./index");
    const resolve = vi.fn<() => ClosedMarkerDrawInstruction>(() => ({
      center: { x: 30, y: 70 },
      fill: { alpha: 1, color: 0xff8800 },
      shape: MarkerShape.Circle,
      size: 18,
      sizeSpace: MarkerSizeSpace.Media,
      stroke: { alpha: 1, color: 0x8b5cf6, width: 2 },
    }));
    const session = await createMediaSession({
      container: createContainer(),
      detections: {
        frames: [
          {
            detections: [
              {
                className: "player",
                rect: { height: 40, width: 20, x: 20, y: 30 },
              },
            ],
            frameIndex: 0,
            mediaTime: 0,
          },
        ],
      },
      media: "sample.mp4",
      presentation: {
        renderers: [annotationRenderers.marker({ style: { resolve } })],
      },
    });

    await vi.waitFor(() => {
      expect(resolve).toHaveBeenCalled();
    });
    session.destroy();
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
