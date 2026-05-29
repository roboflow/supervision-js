import { compositeMaskFrame } from "#render-preparation/mask-frame-compositor";
import { createDefaultRenderPreparationWorkerFactory } from "#render-preparation/default-render-preparation-worker";
import {
  MaskPreparationWorkerMessageType,
  type MaskFramePreparationJob,
  type MaskPreparationWorkerResponse,
} from "#render-preparation/mask-preparation-worker-protocol";
import {
  RenderPreparationExecutionMode,
  RenderPreparationMode,
  RenderPreparationWorkerStatus,
  type RenderPreparationOptions,
  type RenderPreparationWorkerFactory,
} from "#types/render-preparation";

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

  try {
    return createWorkerMaskFramePreparer(workerFactory);
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
): MaskFramePreparer {
  const worker = workerFactory.createWorker();
  let isDestroyed = false;
  let failureMessage: string | null = null;
  let nextRequestId = 1;
  let latestMessage: string | null = null;
  const pendingRequests = new Map<
    number,
    {
      reject(error: unknown): void;
      resolve(frame: PreparedMaskFrame | undefined): void;
    }
  >();

  worker.addEventListener("message", (event) => {
    handleWorkerMessage(event.data as unknown);
  });
  worker.addEventListener("error", (event) => {
    rejectPendingRequests(event.message || "Mask preparation worker failed.");
  });
  worker.addEventListener("messageerror", () => {
    rejectPendingRequests("Mask preparation worker message failed.");
  });

  return {
    destroy() {
      if (isDestroyed) {
        return;
      }

      isDestroyed = true;
      rejectPendingRequests("Mask frame preparer has been destroyed.");
      worker.terminate();
    },

    getStatus() {
      return {
        executionMode: RenderPreparationExecutionMode.Worker,
        message: latestMessage,
        workerStatus: failureMessage
          ? RenderPreparationWorkerStatus.Error
          : RenderPreparationWorkerStatus.Ready,
      };
    },

    prepare(job) {
      if (isDestroyed) {
        return Promise.reject(
          new Error("Mask frame preparer has been destroyed."),
        );
      }

      if (failureMessage) {
        return Promise.reject(new Error(failureMessage));
      }

      const requestId = nextRequestId;
      nextRequestId += 1;

      return new Promise<PreparedMaskFrame | undefined>((resolve, reject) => {
        pendingRequests.set(requestId, { reject, resolve });
        worker.postMessage({
          job,
          requestId,
          type: MaskPreparationWorkerMessageType.Prepare,
        });
      });
    },
  };

  function handleWorkerMessage(message: unknown) {
    if (!isWorkerResponse(message)) {
      return;
    }

    const pendingRequest = pendingRequests.get(message.requestId);

    if (!pendingRequest) {
      closeWorkerResponse(message);
      return;
    }

    pendingRequests.delete(message.requestId);

    if (message.type === MaskPreparationWorkerMessageType.Empty) {
      pendingRequest.resolve(undefined);
      return;
    }

    if (message.type === MaskPreparationWorkerMessageType.Error) {
      latestMessage = message.error;
      pendingRequest.reject(new Error(message.error));
      return;
    }

    try {
      pendingRequest.resolve(createPreparedFrameFromWorkerResponse(message));
    } catch (error) {
      pendingRequest.reject(error);
    }
  }

  function rejectPendingRequests(message: string) {
    failureMessage = message;
    latestMessage = message;

    for (const pendingRequest of pendingRequests.values()) {
      pendingRequest.reject(new Error(message));
    }

    pendingRequests.clear();
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

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
