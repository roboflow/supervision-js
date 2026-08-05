import { describe, expect, it, vi } from "vitest";

import {
  createContainer,
  createMockSample,
  mediaMock,
  pixiMock,
  resetMocks,
} from "../../../test/media-renderer-harness";

describe("media session integration", () => {
  it("forwards the complete initial vector presentation and visibility", async () => {
    resetMocks();
    mediaMock.samples = [createMockSample(0, 0)];
    const { createMediaSession } = await import("./index");
    const polygonResolve = vi.fn(() => undefined);
    const polylineResolve = vi.fn(() => undefined);
    const keypointResolve = vi.fn(() => undefined);
    const session = await createMediaSession({
      container: createContainer(),
      detections: {
        frames: [
          {
            detections: [
              {
                id: "vector-1",
                polygon: {
                  points: [
                    { x: 0, y: 0 },
                    { x: 10, y: 0 },
                    { x: 0, y: 10 },
                  ],
                },
                polyline: {
                  points: [
                    { x: 0, y: 0 },
                    { x: 10, y: 10 },
                  ],
                },
                keypoints: {
                  edges: [],
                  points: [{ x: 5, y: 5 }],
                },
              },
            ],
            mediaTime: 0,
          },
        ],
      },
      media: "sample.mp4",
      presentation: {
        keypointStyle: { resolve: keypointResolve },
        polygonStyle: { resolve: polygonResolve },
        polylineStyle: { resolve: polylineResolve },
        visibility: { annotationsHidden: true },
      },
      renderer: { autoPlay: false },
    });

    for (const resolve of [polygonResolve, polylineResolve, keypointResolve]) {
      expect(resolve).toHaveBeenCalledWith(
        expect.objectContaining({ id: "vector-1" }),
        expect.objectContaining({ hidden: true }),
      );
    }

    session.destroy();
  });

  it("preserves explicit null box presentation at session creation", async () => {
    resetMocks();
    mediaMock.samples = [createMockSample(0, 0)];
    const { createMediaSession } = await import("./index");

    const session = await createMediaSession({
      container: createContainer(),
      detections: {
        frames: [
          {
            detections: [
              {
                className: "player",
                rect: { height: 40, width: 20, x: 20, y: 35 },
              },
            ],
            mediaTime: 0,
          },
        ],
      },
      media: "sample.mp4",
      presentation: {
        boxStyle: null,
      },
      renderer: {
        autoPlay: false,
      },
    });

    expect(pixiMock.graphicsInstances[0]?.clear).toHaveBeenCalledOnce();
    expect(pixiMock.graphicsInstances[0]?.rect).not.toHaveBeenCalled();
    expect(session.getState().renderer).toMatchObject({
      activeDetectionCount: 1,
      activeDetectionFrameTime: 0,
    });

    session.destroy();
  });

  it("forwards host-owned editing, brush, and preview options through a session", async () => {
    resetMocks();
    mediaMock.samples = [createMockSample(0, 0)];
    const { createMediaSession } = await import("./index");
    const pointerDown = vi.fn();
    const previewOverlay = vi.fn(() => ({}));
    const editingEngine = {
      cancel: vi.fn(),
      deleteVertex: vi.fn(),
      getState: vi.fn(() => ({
        activeDetectionId: null,
        activeHandleId: null,
        kind: "idle",
        pointerId: null,
        preview: null,
      })),
      hasCreationTool: vi.fn(() => false),
      keyDown: vi.fn(),
      pointerDown,
      pointerMove: vi.fn(),
      pointerUp: vi.fn(),
      setCreationTool: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
      subscribeFastTranslate: vi.fn(() => () => undefined),
    };
    const brushEditor = {
      canvas: { height: 2, width: 2 },
      getCursor: () => ({ mode: "add", point: null, radius: 1 }),
      subscribeTextureUpdates: () => () => undefined,
      subscribeCursorUpdates: () => () => undefined,
    };

    const session = await createMediaSession({
      container: createContainer(),
      detections: {
        frames: [
          {
            detections: [
              {
                id: "editable",
                rect: { height: 2, width: 2, x: 1, y: 1 },
              },
            ],
            mediaTime: 0,
          },
        ],
      },
      media: "sample.mp4",
      renderer: {
        autoPlay: false,
        editingEngine: editingEngine as never,
        maskBrush: { editor: brushEditor as never },
        previewOverlay,
      },
    });
    const interactionContainer = pixiMock.containerInstances.find(
      (container) => container.eventMode === "static",
    );
    const pointerDownHandler = interactionContainer?.on.mock.calls.find(
      ([eventName]) => eventName === "pointerdown",
    )?.[1] as ((event: unknown) => void) | undefined;

    pointerDownHandler?.({
      button: 0,
      getLocalPosition: () => ({ x: 1, y: 1 }),
      pointerId: 1,
      timeStamp: 1,
    });

    expect(pointerDown).toHaveBeenCalledOnce();
    expect(previewOverlay).toHaveBeenCalled();
    expect(pixiMock.canvasSourceOptions).toContainEqual(
      expect.objectContaining({ resource: brushEditor.canvas }),
    );

    session.destroy();
  });

  it("runs a complete appendable media session through rendering, updates, seeking, and cleanup", async () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      mediaMock.getDurationFromMetadata.mockResolvedValue(6);
      mediaMock.samples = [
        createMockSample(0, 0),
        createMockSample(1, 0),
        createMockSample(5, 0),
      ];
      const fakeWorker = createFakeMaskPreparationWorker((message) => ({
        artifactKind: "pngIdMask",
        fillPalette: new Float32Array([0, 0, 0, 0, 1, 0, 0, 0.7]),
        hasStroke: true,
        imageBitmap: {
          close: vi.fn(),
          height: 2,
          width: 2,
        },
        key: message.job.key,
        maxStrokeWidth: 1,
        png: new Uint8Array([1, 2, 3]),
        requestId: message.requestId,
        strokePalette: new Float32Array([0, 0, 0, 0, 1, 1, 1, 1]),
        strokeWidths: new Float32Array([0, 1]),
        type: "complete",
      }));
      const {
        BaseBoxStyle,
        BaseLabelStyle,
        BaseMaskStyle,
        BoxShape,
        createMediaSession,
        DetectionFrameSelectionMode,
        DetectionMaskEncoding,
        MediaSessionStatus,
        RenderPreparationExecutionMode,
        RenderPreparationMode,
        RenderPreparationWorkerStatus,
      } = await import("./index");
      const states: unknown[] = [];
      const session = await createMediaSession({
        container: createContainer(),
        detections: {
          appendable: { datasetId: "integration-session" },
          sync: {
            frameRate: 1,
            selectionMode: DetectionFrameSelectionMode.NearestFrameIndex,
          },
        },
        media: "fixture-stream.mp4",
        onState(state) {
          states.push(state);
        },
        presentation: {
          boxStyle: new BaseBoxStyle({
            stroke: { alpha: 0.9, color: 0xff00ff, width: 3 },
          }),
          labelStyle: new BaseLabelStyle({ includeConfidence: true }),
          maskStyle: new BaseMaskStyle({
            color: 0x22c55e,
            opacity: 0.7,
            stroke: { alpha: 1, color: 0xffffff, width: 2 },
          }),
        },
        renderer: {
          autoPlay: false,
          renderPreparation: {
            maskFrame: {
              workerCount: 1,
            },
            mode: RenderPreparationMode.Worker,
            workerFactory: {
              createWorker: () => fakeWorker.worker,
            },
          },
        },
      });

      expect(session.getState()).toMatchObject({
        renderer: {
          activeDetectionCount: 0,
          currentTime: 0,
        },
        status: MediaSessionStatus.Ready,
      });
      expect(mediaMock.urlSourceConstructor).toHaveBeenCalledWith(
        "fixture-stream.mp4",
      );

      await session.appendDetectionFrames([
        {
          detections: [
            {
              className: "player",
              confidence: 0.92,
              id: "player-1",
              mask: {
                counts: "021",
                encoding: DetectionMaskEncoding.CompressedRle,
                height: 2,
                width: 2,
              },
              rect: { height: 40, width: 20, x: 20, y: 35 },
            },
          ],
          endTime: 1,
          frameIndex: 0,
          mediaTime: 0,
        },
      ]);
      await session.seek(0);
      await vi.runOnlyPendingTimersAsync();

      expect(session.getState()).toMatchObject({
        renderPreparation: {
          executionMode: RenderPreparationExecutionMode.Worker,
          workerStatus: RenderPreparationWorkerStatus.Ready,
        },
        renderer: {
          activeDetectionCount: 1,
          activeDetectionFrameIndex: 0,
          currentTime: 0,
        },
        status: MediaSessionStatus.Ready,
      });
      expect(fakeWorker.messages.length).toBeGreaterThanOrEqual(1);
      expect(pixiMock.spriteInstances[0]).toMatchObject({
        height: 720,
        visible: true,
        width: 1280,
      });
      expect(pixiMock.graphicsInstances[0]?.rect).toHaveBeenLastCalledWith(
        10,
        15,
        20,
        40,
      );
      expect(pixiMock.graphicsInstances[0]?.stroke).toHaveBeenLastCalledWith({
        alpha: 0.9,
        color: 0xff00ff,
        width: 6,
      });
      expect(pixiMock.textInstances[0]?.text).toBe("player 92%");

      await session.appendDetectionFrames([
        {
          detections: [
            {
              className: "person",
              confidence: 0.88,
              id: "person-5",
              mask: {
                counts: "021",
                encoding: DetectionMaskEncoding.CompressedRle,
                height: 2,
                width: 2,
              },
              rect: { height: 80, width: 40, x: 50, y: 80 },
            },
          ],
          endTime: 6,
          frameIndex: 5,
          mediaTime: 5,
        },
      ]);
      await session.seek(0);

      expect(session.getState().renderer).toMatchObject({
        activeDetectionCount: 1,
        activeDetectionFrameIndex: 0,
        currentTime: 0,
      });

      await session.seek(5);
      await vi.runOnlyPendingTimersAsync();

      expect(session.getState().renderer).toMatchObject({
        activeDetectionCount: 1,
        activeDetectionFrameIndex: 5,
        currentTime: 5,
      });
      expect(pixiMock.graphicsInstances[0]?.rect).toHaveBeenLastCalledWith(
        30,
        40,
        40,
        80,
      );
      expect(pixiMock.textInstances[0]?.text).toBe("person 88%");

      session.setPresentation({
        boxStyle: new BaseBoxStyle({
          cornerRadius: 8,
          shape: BoxShape.RoundedRect,
          stroke: { alpha: 1, color: 0x38bdf8, width: 5 },
        }),
      });

      expect(pixiMock.graphicsInstances[0]?.roundRect).toHaveBeenLastCalledWith(
        30,
        40,
        40,
        80,
        8,
      );
      expect(session.getDetectionSummary()).toMatchObject({
        datasetId: "integration-session",
        detectionCount: 2,
        frameCount: 2,
      });

      session.destroy();

      expect(session.getState()).toMatchObject({
        status: MediaSessionStatus.Destroyed,
      });
      expect(fakeWorker.terminateCount).toBe(2);
      expect(pixiMock.appDestroy).toHaveBeenCalledOnce();
      expect(mediaMock.dispose).toHaveBeenCalledOnce();
      expect(states.at(-1)).toMatchObject({
        status: MediaSessionStatus.Destroyed,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

interface FakeMaskPreparationWorkerMessage {
  readonly job: {
    readonly key: string;
  };
  readonly requestId: number;
}

function createFakeMaskPreparationWorker(
  createResponse: (message: FakeMaskPreparationWorkerMessage) => unknown,
) {
  const listeners: Array<(event: MessageEvent<unknown>) => void> = [];
  const messages: FakeMaskPreparationWorkerMessage[] = [];
  let terminateCount = 0;
  const worker = {
    addEventListener(type: string, listener: (event: MessageEvent) => void) {
      if (type === "message") {
        listeners.push(listener as (event: MessageEvent<unknown>) => void);
      }
    },

    postMessage(message: FakeMaskPreparationWorkerMessage) {
      messages.push(message);
      setTimeout(() => {
        for (const listener of listeners) {
          listener({
            data: createResponse(message),
          } as MessageEvent<unknown>);
        }
      }, 0);
    },

    terminate() {
      terminateCount += 1;
    },
  } as unknown as Worker;

  return {
    messages,
    get terminateCount() {
      return terminateCount;
    },
    worker,
  };
}
