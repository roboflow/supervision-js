import {
  compositeMaskFrame,
  createMaskIdFrame,
  createPngIdMaskFrame,
} from "#render-preparation/mask-frame-compositor";
import { createDefaultRenderPreparationWorkerFactory } from "#render-preparation/default-render-preparation-worker";
import {
  PreparedMaskFrameKind,
  type PreparedMaskFrame,
} from "#render-preparation/mask-frame-artifact";
import { getBrowserMaskPreparationWorkerCount } from "#render-preparation/mask-preparation-worker-count";
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

export { PreparedMaskFrameKind, type PreparedMaskFrame };

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
  let isDestroyed = false;
  let strictWorkerFailureMessage: string | null = null;

  if (!workerPreparer) {
    return createMainThreadMaskFramePreparer(
      RenderPreparationWorkerStatus.Unavailable,
      "Mask preparation worker is unavailable; using main-thread preparation.",
    );
  }

  return {
    destroy() {
      if (isDestroyed) {
        return;
      }

      isDestroyed = true;
      workerPreparer?.destroy();
      workerPreparer = undefined;
      mainThreadPreparer.destroy();
    },

    getStatus() {
      if (strictWorkerFailureMessage) {
        return {
          executionMode: RenderPreparationExecutionMode.Worker,
          message: strictWorkerFailureMessage,
          workerStatus: RenderPreparationWorkerStatus.Error,
        };
      }

      return workerPreparer?.getStatus() ?? mainThreadPreparer.getStatus();
    },

    async prepare(job) {
      if (isDestroyed) {
        throw new Error("Mask frame preparer has been destroyed.");
      }

      const activeWorkerPreparer = workerPreparer;

      if (!activeWorkerPreparer) {
        if (strictWorkerFailureMessage) {
          throw new Error(strictWorkerFailureMessage);
        }

        return mainThreadPreparer.prepare(job);
      }

      try {
        return await activeWorkerPreparer.prepare(job);
      } catch (error) {
        if (isDestroyed) {
          throw error;
        }

        if (workerPreparer === activeWorkerPreparer) {
          activeWorkerPreparer.destroy();
          workerPreparer = undefined;
        }

        if (mode === RenderPreparationMode.Worker) {
          const isFirstStrictFailure = strictWorkerFailureMessage === null;

          strictWorkerFailureMessage ??= getErrorMessage(
            error,
            "Mask preparation worker failed.",
          );

          if (isFirstStrictFailure) {
            options.onStatusChange?.();
          }

          throw error;
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
    if (options.mode === RenderPreparationMode.Worker) {
      throw new Error("Mask preparation worker is unavailable.");
    }

    return undefined;
  }

  const workerFactory =
    options.renderPreparation?.workerFactory ??
    createDefaultRenderPreparationWorkerFactory();
  const workerCount = getBrowserMaskPreparationWorkerCount(
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

      const pngIdMaskFrame = await createPreparedPngIdMaskFrame(job);

      if (pngIdMaskFrame) {
        return pngIdMaskFrame;
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
        idMaskData: createMaskIdFrame(job.instructions)?.data,
        key: job.key,
        kind: PreparedMaskFrameKind.RgbaImage,
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

async function createPreparedPngIdMaskFrame(
  job: MaskFramePreparationJob,
): Promise<PreparedMaskFrame | undefined> {
  if (
    typeof Blob === "undefined" ||
    typeof createImageBitmap === "undefined" ||
    typeof CompressionStream === "undefined"
  ) {
    return undefined;
  }

  try {
    const frame = await createPngIdMaskFrame(job.instructions);

    if (!frame) {
      return undefined;
    }

    const imageBitmap = await createImageBitmap(
      new Blob([frame.png], { type: "image/png" }),
    );

    return {
      close() {
        imageBitmap.close();
      },
      fillPalette: frame.fillPalette,
      hasStroke: frame.hasStroke,
      height: imageBitmap.height,
      key: job.key,
      kind: PreparedMaskFrameKind.PngIdMask,
      maxStrokeWidth: frame.maxStrokeWidth,
      png: frame.png,
      source: imageBitmap,
      strokePalette: frame.strokePalette,
      strokeWidths: frame.strokeWidths,
      width: imageBitmap.width,
    };
  } catch {
    return undefined;
  }
}

function createWorkerMaskFramePreparer(
  workerFactory: RenderPreparationWorkerFactory,
  workerCount: number,
): MaskFramePreparer {
  let latestMessage: string | null = null;
  let isDestroyed = false;
  const workers = createWorkerRpcPool(workerFactory, workerCount);

  return {
    destroy() {
      if (isDestroyed) {
        return;
      }

      isDestroyed = true;

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
      if (isDestroyed) {
        throw new Error("Mask frame preparer has been destroyed.");
      }

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
  if (message.artifactKind === PreparedMaskFrameKind.PngIdMask) {
    if (
      !message.imageBitmap ||
      !message.fillPalette ||
      !message.png ||
      !message.strokePalette ||
      !message.strokeWidths
    ) {
      throw new Error(
        "Mask preparation worker returned an incomplete ID mask artifact.",
      );
    }

    return {
      close() {
        message.imageBitmap?.close();
      },
      fillPalette: message.fillPalette,
      hasStroke: message.hasStroke ?? false,
      height: message.imageBitmap.height,
      key: message.key,
      kind: PreparedMaskFrameKind.PngIdMask,
      maxStrokeWidth: message.maxStrokeWidth ?? 0,
      png: message.png,
      source: message.imageBitmap,
      strokePalette: message.strokePalette,
      strokeWidths: message.strokeWidths,
      width: message.imageBitmap.width,
    };
  }

  if (message.imageBitmap) {
    return {
      close() {
        message.imageBitmap?.close();
      },
      height: message.imageBitmap.height,
      idMaskData: message.idMaskData,
      key: message.key,
      kind: PreparedMaskFrameKind.RgbaImage,
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
    idMaskData: message.idMaskData,
    key: message.key,
    kind: PreparedMaskFrameKind.RgbaImage,
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

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
