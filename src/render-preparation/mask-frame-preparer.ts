import { compositeMaskFrame } from "#render-preparation/mask-frame-compositor";
import { createDefaultRenderPreparationWorkerFactory } from "#render-preparation/default-render-preparation-worker";
import {
  MaskPreparationWorkerMessageType,
  type MaskFramePreparationJob,
  type MaskPreparationWorkerRequest,
  type MaskPreparationWorkerResponse,
} from "#render-preparation/mask-preparation-worker-protocol";
import {
  RenderPreparationExecutionMode,
  RenderPreparationMode,
  RenderPreparationWorkerStatus,
  type RenderPreparationOptions,
  type RenderPreparationWorkerFactory,
} from "#types/render-preparation";
import { createWorkerRpcClient } from "#workers/worker-rpc-client";

const DEFAULT_MASK_PREPARATION_WORKER_COUNT = 2;

export interface PreparedMaskFrame {
  readonly height: number;
  readonly key: string;
  readonly source: HTMLCanvasElement | ImageBitmap;
  readonly width: number;
  close(): void;
}

export interface MaskFramePreparerStatus {
  readonly executionMode: RenderPreparationExecutionMode;
  readonly message: string | null;
  readonly workerStatus: RenderPreparationWorkerStatus;
}

export interface MaskFramePreparer {
  getStatus(): MaskFramePreparerStatus;
  prepare(job: MaskFramePreparationJob): Promise<PreparedMaskFrame | undefined>;
  destroy(): void;
}

export function createMaskFramePreparer(
  options: {
    readonly renderPreparation?: RenderPreparationOptions;
    readonly onStatusChange?: () => void;
  } = {},
): MaskFramePreparer {
  const mainThreadPreparer = createMainThreadMaskFramePreparer(
    RenderPreparationWorkerStatus.Disabled,
  );
  const mode = options.renderPreparation?.mode ?? RenderPreparationMode.Auto;

  if (mode === RenderPreparationMode.MainThread) {
    return mainThreadPreparer;
  }

  let workerPreparer = createWorkerPreparerIfAvailable({
    mode,
    renderPreparation: options.renderPreparation,
  });

  if (!workerPreparer) {
    return createMainThreadMaskFramePreparer(
      RenderPreparationWorkerStatus.Unavailable,
      "Mask preparation worker is unavailable; using main-thread preparation.",
    );
  }

  return {
    destroy() {
      workerPreparer?.destroy();
      workerPreparer = undefined;
      mainThreadPreparer.destroy();
    },

    getStatus() {
      return workerPreparer?.getStatus() ?? mainThreadPreparer.getStatus();
    },

    async prepare(job) {
      const activeWorkerPreparer = workerPreparer;

      if (!activeWorkerPreparer) {
        return mainThreadPreparer.prepare(job);
      }

      try {
        return await activeWorkerPreparer.prepare(job);
      } catch (error) {
        if (workerPreparer === activeWorkerPreparer) {
          activeWorkerPreparer.destroy();
          workerPreparer = undefined;
        }

        mainThreadPreparer.setFallbackMessage(
          getErrorMessage(
            error,
            "Mask preparation worker failed; using main-thread preparation.",
          ),
        );
        options.onStatusChange?.();

        return mainThreadPreparer.prepare(job);
      }
    },
  };
}

function createWorkerPreparerIfAvailable(options: {
  readonly mode: RenderPreparationMode;
  readonly renderPreparation?: RenderPreparationOptions;
}) {
  if (
    !options.renderPreparation?.workerFactory &&
    typeof Worker === "undefined"
  ) {
    return undefined;
  }

  const workerFactory =
    options.renderPreparation?.workerFactory ??
    createDefaultRenderPreparationWorkerFactory();
  const workerCount = resolveWorkerCount(
    options.renderPreparation?.maskFrame?.workerCount,
  );

  try {
    return createWorkerMaskFramePreparer(workerFactory, workerCount);
  } catch (error) {
    if (options.mode === RenderPreparationMode.Worker) {
      throw error;
    }

    return undefined;
  }
}

function createMainThreadMaskFramePreparer(
  workerStatus: RenderPreparationWorkerStatus,
  message: string | null = null,
) {
  let isDestroyed = false;
  let fallbackMessage = message;

  const preparer = {
    destroy() {
      isDestroyed = true;
    },

    getStatus(): MaskFramePreparerStatus {
      return {
        executionMode: RenderPreparationExecutionMode.MainThread,
        message: fallbackMessage,
        workerStatus,
      };
    },

    async prepare(
      job: MaskFramePreparationJob,
    ): Promise<PreparedMaskFrame | undefined> {
      if (isDestroyed) {
        throw new Error("Mask frame preparer has been destroyed.");
      }

      const compositedFrame = compositeMaskFrame(job.instructions);

      if (!compositedFrame) {
        return undefined;
      }

      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");

      if (!context) {
        throw new Error("Unable to create mask frame canvas context.");
      }

      canvas.width = compositedFrame.width;
      canvas.height = compositedFrame.height;
      context.putImageData(
        new ImageData(
          compositedFrame.data,
          compositedFrame.width,
          compositedFrame.height,
        ),
        0,
        0,
      );

      return {
        close() {
          canvas.width = 0;
          canvas.height = 0;
        },
        height: compositedFrame.height,
        key: job.key,
        source: canvas,
        width: compositedFrame.width,
      };
    },

    setFallbackMessage(message: string) {
      fallbackMessage = message;
    },
  };

  return preparer;
}

function createWorkerMaskFramePreparer(
  workerFactory: RenderPreparationWorkerFactory,
  workerCount: number,
): MaskFramePreparer {
  let latestMessage: string | null = null;
  const workers = createWorkerRpcPool(workerFactory, workerCount);

  return {
    destroy() {
      for (const worker of workers) {
        worker.rpc.destroy();
      }
    },

    getStatus() {
      const failureMessage =
        workers
          .find((worker) => worker.rpc.getFailureMessage())
          ?.rpc.getFailureMessage() ?? null;

      return {
        executionMode: RenderPreparationExecutionMode.Worker,
        message: latestMessage ?? failureMessage,
        workerStatus: failureMessage
          ? RenderPreparationWorkerStatus.Error
          : RenderPreparationWorkerStatus.Ready,
      };
    },

    async prepare(job) {
      return prepareWithWorker(
        selectLeastBusyWorker(workers),
        job,
        (message) => {
          latestMessage = message;
        },
      );
    },
  };
}

interface WorkerMaskFramePreparerEntry {
  activeRequestCount: number;
  readonly rpc: ReturnType<
    typeof createWorkerRpcClient<
      MaskPreparationWorkerRequest,
      MaskPreparationWorkerResponse
    >
  >;
}

function createWorkerRpcPool(
  workerFactory: RenderPreparationWorkerFactory,
  workerCount: number,
): WorkerMaskFramePreparerEntry[] {
  const workers: WorkerMaskFramePreparerEntry[] = [];

  try {
    for (let index = 0; index < workerCount; index += 1) {
      workers.push({
        activeRequestCount: 0,
        rpc: createWorkerRpcClient<
          MaskPreparationWorkerRequest,
          MaskPreparationWorkerResponse
        >({
          defaultErrorMessage: "Mask preparation worker failed.",
          isResponse: isWorkerResponse,
          onOrphanedResponse: closeWorkerResponse,
          worker: workerFactory.createWorker(),
        }),
      });
    }
  } catch (error) {
    for (const worker of workers) {
      worker.rpc.destroy();
    }

    throw error;
  }

  return workers;
}

function selectLeastBusyWorker(
  workers: readonly WorkerMaskFramePreparerEntry[],
) {
  let selectedWorker = workers[0];

  if (!selectedWorker) {
    throw new Error("Mask preparation worker pool is empty.");
  }

  for (const worker of workers.slice(1)) {
    if (worker.activeRequestCount < selectedWorker.activeRequestCount) {
      selectedWorker = worker;
    }
  }

  return selectedWorker;
}

async function prepareWithWorker(
  worker: WorkerMaskFramePreparerEntry,
  job: MaskFramePreparationJob,
  setLatestMessage: (message: string) => void,
) {
  worker.activeRequestCount += 1;

  try {
    const message = await worker.rpc.request({
      job,
      type: MaskPreparationWorkerMessageType.Prepare,
    });

    if (message.type === MaskPreparationWorkerMessageType.Empty) {
      return undefined;
    }

    if (message.type === MaskPreparationWorkerMessageType.Error) {
      setLatestMessage(message.error);
      throw new Error(message.error);
    }

    try {
      return createPreparedFrameFromWorkerResponse(message);
    } catch (error) {
      setLatestMessage(
        getErrorMessage(
          error,
          "Unable to read mask preparation worker response.",
        ),
      );
      throw error;
    }
  } finally {
    worker.activeRequestCount -= 1;
  }
}

function createPreparedFrameFromWorkerResponse(
  message: Extract<
    MaskPreparationWorkerResponse,
    { readonly type: MaskPreparationWorkerMessageType.Complete }
  >,
): PreparedMaskFrame {
  if (message.imageBitmap) {
    return {
      close() {
        message.imageBitmap?.close();
      },
      height: message.imageBitmap.height,
      key: message.key,
      source: message.imageBitmap,
      width: message.imageBitmap.width,
    };
  }

  if (!message.imageData) {
    throw new Error("Mask preparation worker returned no image artifact.");
  }

  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("Unable to create mask frame canvas context.");
  }

  canvas.width = message.imageData.width;
  canvas.height = message.imageData.height;
  context.putImageData(message.imageData, 0, 0);

  return {
    close() {
      canvas.width = 0;
      canvas.height = 0;
    },
    height: message.imageData.height,
    key: message.key,
    source: canvas,
    width: message.imageData.width,
  };
}

function closeWorkerResponse(message: MaskPreparationWorkerResponse) {
  if (
    message.type === MaskPreparationWorkerMessageType.Complete &&
    message.imageBitmap
  ) {
    message.imageBitmap.close();
  }
}

function isWorkerResponse(
  value: unknown,
): value is MaskPreparationWorkerResponse {
  return (
    isRecord(value) &&
    typeof value.requestId === "number" &&
    typeof value.key === "string" &&
    (value.type === MaskPreparationWorkerMessageType.Complete ||
      value.type === MaskPreparationWorkerMessageType.Empty ||
      value.type === MaskPreparationWorkerMessageType.Error)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveWorkerCount(workerCount: number | undefined) {
  if (workerCount === undefined) {
    return DEFAULT_MASK_PREPARATION_WORKER_COUNT;
  }

  return Math.max(1, Math.floor(workerCount));
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
