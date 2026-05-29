import { describe, expect, it, vi } from "vitest";

import {
  RenderPreparationExecutionMode,
  RenderPreparationMode,
  RenderPreparationWorkerStatus,
} from "#types/render-preparation";
import { DetectionMaskEncoding } from "#types/detections";

import { resetMocks } from "../../test/media-renderer-harness";
import {
  type MaskFramePreparationJob,
  MaskPreparationWorkerMessageType,
} from "./mask-preparation-worker-protocol";
import { createMaskFramePreparer } from "./mask-frame-preparer";

const maskPreparationJob: MaskFramePreparationJob = {
  instructions: [
    {
      alpha: 0.5,
      color: 0xff0000,
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
    get terminateCount() {
      return terminateCount;
    },
    worker,
  };
}
