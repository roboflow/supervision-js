import { describe, expect, it, vi } from "vitest";

import {
  RenderPreparationExecutionMode,
  RenderPreparationMode,
  RenderPreparationWorkerStatus,
} from "#types/render-preparation";
import { DetectionMaskEncoding } from "supervision-js-core";

import { resetMocks } from "../../../../test/media-renderer-harness";
import {
  type MaskFramePreparationJob,
  MaskPreparationWorkerMessageType,
} from "./mask-preparation-worker-protocol";
import {
  createMaskFramePreparer,
  PreparedMaskFrameKind,
} from "./mask-frame-preparer";

const maskPreparationJob: MaskFramePreparationJob = {
  instructions: [
    {
      alpha: 0.5,
      color: 0xff0000,
      detectionIndex: 0,
      mask: {
        counts: "021",
        encoding: DetectionMaskEncoding.CompressedRle,
        height: 2,
        width: 2,
      },
    },
  ],
  key: "0:0",
};

describe("mask frame preparer", () => {
  it("uses PNG ID-mask artifacts on the main thread when browser support exists", async () => {
    resetMocks();

    const imageBitmap = {
      close: vi.fn(),
      height: 2,
      width: 2,
    } as unknown as ImageBitmap;
    const originalCreateImageBitmap = globalThis.createImageBitmap;
    const createImageBitmap = vi.fn(async () => imageBitmap);

    globalThis.createImageBitmap = createImageBitmap;

    try {
      const preparer = createMaskFramePreparer({
        renderPreparation: {
          mode: RenderPreparationMode.MainThread,
        },
      });

      await expect(preparer.prepare(maskPreparationJob)).resolves.toMatchObject(
        {
          height: 2,
          key: "0:0",
          kind: PreparedMaskFrameKind.PngIdMask,
          source: imageBitmap,
          width: 2,
        },
      );
      expect(createImageBitmap).toHaveBeenCalledWith(expect.any(Blob));

      preparer.destroy();
    } finally {
      globalThis.createImageBitmap = originalCreateImageBitmap;
    }
  });

  it("distributes concurrent worker requests across the configured worker pool", async () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const fakeWorkers: ReturnType<typeof createFakeMaskPreparationWorker>[] =
        [];
      const preparer = createMaskFramePreparer({
        renderPreparation: {
          maskFrame: {
            workerCount: 2,
          },
          mode: RenderPreparationMode.Worker,
          workerFactory: {
            createWorker: () => {
              const fakeWorker = createFakeMaskPreparationWorker((message) => ({
                imageData: new ImageData(
                  new Uint8ClampedArray(2 * 2 * 4),
                  2,
                  2,
                ),
                key: message.job.key,
                requestId: message.requestId,
                type: MaskPreparationWorkerMessageType.Complete,
              }));

              fakeWorkers.push(fakeWorker);
              return fakeWorker.worker;
            },
          },
        },
      });
      const firstFramePromise = preparer.prepare(maskPreparationJob);
      const secondFramePromise = preparer.prepare({
        ...maskPreparationJob,
        key: "1:0.04",
      });

      expect(fakeWorkers).toHaveLength(2);
      expect(
        fakeWorkers[0]?.messages.map((message) => message.job.key),
      ).toEqual(["0:0"]);
      expect(
        fakeWorkers[1]?.messages.map((message) => message.job.key),
      ).toEqual(["1:0.04"]);

      await vi.runOnlyPendingTimersAsync();

      await expect(
        Promise.all([firstFramePromise, secondFramePromise]),
      ).resolves.toEqual([
        expect.objectContaining({ key: "0:0" }),
        expect.objectContaining({ key: "1:0.04" }),
      ]);

      preparer.destroy();
      expect(fakeWorkers.map((worker) => worker.terminateCount)).toEqual([
        1, 1,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back once when concurrent worker requests fail", async () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const fakeWorker = createFakeMaskPreparationWorker((message) => ({
        error: `boom ${message.requestId}`,
        key: message.job.key,
        requestId: message.requestId,
        type: MaskPreparationWorkerMessageType.Error,
      }));
      const onStatusChange = vi.fn();
      const preparer = createMaskFramePreparer({
        onStatusChange,
        renderPreparation: {
          maskFrame: {
            workerCount: 1,
          },
          mode: RenderPreparationMode.Worker,
          workerFactory: {
            createWorker: () => fakeWorker.worker,
          },
        },
      });
      const firstFramePromise = preparer.prepare(maskPreparationJob);
      const secondFramePromise = preparer.prepare({
        ...maskPreparationJob,
        key: "1:0.04",
      });

      await vi.runOnlyPendingTimersAsync();

      await expect(
        Promise.all([firstFramePromise, secondFramePromise]),
      ).resolves.toEqual([
        expect.objectContaining({ key: "0:0" }),
        expect.objectContaining({ key: "1:0.04" }),
      ]);
      expect(preparer.getStatus()).toMatchObject({
        executionMode: RenderPreparationExecutionMode.MainThread,
        workerStatus: RenderPreparationWorkerStatus.Disabled,
      });
      expect(onStatusChange).toHaveBeenCalled();
      expect(fakeWorker.terminateCount).toBe(1);

      preparer.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back when worker responses do not include an image artifact", async () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const fakeWorker = createFakeMaskPreparationWorker((message) => ({
        key: message.job.key,
        requestId: message.requestId,
        type: MaskPreparationWorkerMessageType.Complete,
      }));
      const preparer = createMaskFramePreparer({
        renderPreparation: {
          maskFrame: {
            workerCount: 1,
          },
          mode: RenderPreparationMode.Worker,
          workerFactory: {
            createWorker: () => fakeWorker.worker,
          },
        },
      });
      const framePromise = preparer.prepare(maskPreparationJob);

      await vi.runOnlyPendingTimersAsync();

      await expect(framePromise).resolves.toEqual(
        expect.objectContaining({ key: "0:0" }),
      );
      expect(preparer.getStatus()).toMatchObject({
        executionMode: RenderPreparationExecutionMode.MainThread,
        message: "Mask preparation worker returned no image artifact.",
        workerStatus: RenderPreparationWorkerStatus.Disabled,
      });

      preparer.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects pending worker preparations after destroy instead of falling back", async () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const fakeWorker = createFakeMaskPreparationWorker((message) => ({
        imageData: new ImageData(new Uint8ClampedArray(2 * 2 * 4), 2, 2),
        key: message.job.key,
        requestId: message.requestId,
        type: MaskPreparationWorkerMessageType.Complete,
      }));
      const preparer = createMaskFramePreparer({
        renderPreparation: {
          maskFrame: {
            workerCount: 1,
          },
          mode: RenderPreparationMode.Worker,
          workerFactory: {
            createWorker: () => fakeWorker.worker,
          },
        },
      });
      const framePromise = preparer.prepare(maskPreparationJob);

      expect(fakeWorker.messages).toHaveLength(1);

      preparer.destroy();

      await expect(framePromise).rejects.toThrow(
        "Worker RPC client has been destroyed.",
      );
      await expect(preparer.prepare(maskPreparationJob)).rejects.toThrow(
        "Mask frame preparer has been destroyed.",
      );
      expect(fakeWorker.terminateCount).toBe(1);

      await vi.runOnlyPendingTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });

  it("hydrates PNG ID-mask worker artifacts without losing shader palettes", async () => {
    vi.useFakeTimers();
    resetMocks();

    try {
      const imageBitmap = {
        close: vi.fn(),
        height: 2,
        width: 2,
      } as unknown as ImageBitmap;
      const fillPalette = new Float32Array([0, 0, 0, 0, 1, 0, 0, 0.5]);
      const strokePalette = new Float32Array([0, 0, 0, 0, 1, 1, 1, 1]);
      const strokeWidths = new Float32Array([0, 5]);
      const png = new Uint8Array([1, 2, 3]);
      const fakeWorker = createFakeMaskPreparationWorker((message) => ({
        artifactKind: PreparedMaskFrameKind.PngIdMask,
        fillPalette,
        hasStroke: true,
        imageBitmap,
        key: message.job.key,
        maxStrokeWidth: 5,
        png,
        requestId: message.requestId,
        strokePalette,
        strokeWidths,
        type: MaskPreparationWorkerMessageType.Complete,
      }));
      const preparer = createMaskFramePreparer({
        renderPreparation: {
          mode: RenderPreparationMode.Worker,
          workerFactory: {
            createWorker: () => fakeWorker.worker,
          },
        },
      });
      const framePromise = preparer.prepare(maskPreparationJob);

      await vi.runOnlyPendingTimersAsync();

      await expect(framePromise).resolves.toMatchObject({
        fillPalette,
        hasStroke: true,
        height: 2,
        key: "0:0",
        kind: PreparedMaskFrameKind.PngIdMask,
        maxStrokeWidth: 5,
        png,
        source: imageBitmap,
        strokePalette,
        strokeWidths,
        width: 2,
      });

      preparer.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});

function createFakeMaskPreparationWorker(
  createResponse: (
    message: Extract<
      Parameters<Worker["postMessage"]>[0],
      { readonly requestId: number }
    > & {
      readonly job: MaskFramePreparationJob;
      readonly requestId: number;
    },
  ) => unknown,
) {
  const listeners: Array<(event: MessageEvent<unknown>) => void> = [];
  const messages: Array<{
    readonly job: MaskFramePreparationJob;
    readonly requestId: number;
  }> = [];
  let terminateCount = 0;
  const worker = {
    addEventListener(type: string, listener: (event: MessageEvent) => void) {
      if (type === "message") {
        listeners.push(listener as (event: MessageEvent<unknown>) => void);
      }
    },

    postMessage(message: {
      readonly job: MaskFramePreparationJob;
      readonly requestId: number;
    }) {
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
