import { createDefaultRenderPreparationWorkerFactory } from "./default-render-preparation-worker";
import {
  DepthPreparationWorkerMessageType,
  type DepthPreviewLumaWorkerRequest,
  type DepthPreviewLumaWorkerResponse,
} from "./depth-preparation-worker-protocol";
// Types only: the luma reader itself ships in the lazily loaded preview
// decoder, which copies on the page whenever this copier declines a frame.
import type {
  DepthPreviewLuma,
  DepthPreviewLumaCopier,
} from "./depth-preview-luma";
import {
  RenderPreparationMode,
  type RenderPreparationOptions,
} from "#types/render-preparation";
import {
  createWorkerRpcClient,
  type WorkerRpcClient,
} from "#workers/worker-rpc-client";

export type { DepthPreviewLumaCopier };

/**
 * Hands each frame to a render-preparation worker of its own, which copies
 * its luma and closes it; the page only posts the frame and takes the bytes
 * back. A browser that cannot send a frame to a worker, or a worker that
 * fails, leaves this and every later frame to the page, unless the mode
 * requires the worker.
 */
export function createDepthPreviewLumaCopier(
  options: RenderPreparationOptions | undefined,
): DepthPreviewLumaCopier {
  const mode = options?.mode ?? RenderPreparationMode.Auto;
  let rpc: WorkerRpcClient<
    DepthPreviewLumaWorkerRequest,
    DepthPreviewLumaWorkerResponse
  > | null = null;
  let warned = false;

  if (
    mode !== RenderPreparationMode.MainThread &&
    (options?.workerFactory || typeof Worker !== "undefined")
  ) {
    try {
      rpc = createWorkerRpcClient<
        DepthPreviewLumaWorkerRequest,
        DepthPreviewLumaWorkerResponse
      >({
        defaultErrorMessage: "Depth preview worker failed.",
        isResponse: isPreviewLumaResponse,
        worker: (
          options?.workerFactory ??
          createDefaultRenderPreparationWorkerFactory()
        ).createWorker(),
      });
    } catch (error) {
      if (mode === RenderPreparationMode.Worker) throw error;
    }
  }

  const fallBack = (error: unknown) => {
    if (mode === RenderPreparationMode.Worker) throw error;
    rpc?.destroy();
    rpc = null;
    if (!warned) {
      warned = true;
      console.warn(
        "Depth preview frames cannot be copied in the worker; copying them on the main thread.",
        error,
      );
    }
  };

  return {
    get offMainThread() {
      return rpc !== null;
    },

    copy(frame, correction) {
      if (!rpc) return null;

      const request = rpc.request(
        {
          correction,
          frame,
          type: DepthPreparationWorkerMessageType.PreviewLuma,
        },
        [frame as unknown as Transferable],
      );

      // A frame that went to the worker is detached here. One still open
      // was refused by postMessage, and the page copies it instead.
      if (frame.codedWidth > 0) {
        request.catch(() => undefined);
        fallBack(
          new Error("This browser cannot send a video frame to a worker."),
        );
        return null;
      }

      return request.then(
        (response): DepthPreviewLuma | null => {
          if (response.type === DepthPreparationWorkerMessageType.Error) {
            fallBack(new Error(response.error));
            return null;
          }

          return {
            busyMs: 0,
            height: response.height,
            luma: new Uint8Array(response.luma),
            path: response.path,
            width: response.width,
          };
        },
        (error: unknown) => {
          fallBack(error);
          return null;
        },
      );
    },

    destroy() {
      rpc?.destroy();
      rpc = null;
    },
  };
}

function isPreviewLumaResponse(
  value: unknown,
): value is DepthPreviewLumaWorkerResponse {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;

  return (
    type === DepthPreparationWorkerMessageType.PreviewLumaComplete ||
    type === DepthPreparationWorkerMessageType.Error
  );
}
