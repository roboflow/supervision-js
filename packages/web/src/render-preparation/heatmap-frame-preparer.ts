import type {
  DetectionHeatmap,
  HeatmapAnnotationRenderer,
} from "supervision-js-core";
import { colorizeHeatmap } from "#renderers/heatmap-color";
import { createDefaultRenderPreparationWorkerFactory } from "./default-render-preparation-worker";
import {
  HeatmapPreparationWorkerMessageType,
  type HeatmapPreparationWorkerRequest,
  type HeatmapPreparationWorkerResponse,
} from "./heatmap-preparation-worker-protocol";
import {
  RenderPreparationMode,
  type RenderPreparationOptions,
} from "#types/render-preparation";
import { createWorkerRpcClient } from "#workers/worker-rpc-client";

export interface PreparedHeatmapImage {
  readonly resource: ImageBitmap | ImageData;
  close(): void;
}

export interface HeatmapFramePreparer {
  prepare(
    map: DetectionHeatmap,
    renderer: HeatmapAnnotationRenderer,
  ): Promise<PreparedHeatmapImage>;
  destroy(): void;
}

/** The same bundled worker also cooks masks, but heatmaps use their own queue. */
export function createHeatmapFramePreparer(
  options: RenderPreparationOptions | undefined,
): HeatmapFramePreparer {
  const mode = options?.mode ?? RenderPreparationMode.Auto;
  let isDestroyed = false;
  let rpc: ReturnType<
    typeof createWorkerRpcClient<
      HeatmapPreparationWorkerRequest,
      HeatmapPreparationWorkerResponse
    >
  > | null = null;

  if (mode !== RenderPreparationMode.MainThread) {
    try {
      if (!options?.workerFactory && typeof Worker === "undefined") {
        throw new Error("Heatmap preparation worker is unavailable.");
      }
      const factory =
        options?.workerFactory ?? createDefaultRenderPreparationWorkerFactory();
      rpc = createWorkerRpcClient<
        HeatmapPreparationWorkerRequest,
        HeatmapPreparationWorkerResponse
      >({
        defaultErrorMessage: "Heatmap preparation worker failed.",
        isResponse: isHeatmapResponse,
        onOrphanedResponse: closeHeatmapResponse,
        worker: factory.createWorker(),
      });
    } catch (error) {
      if (mode === RenderPreparationMode.Worker) throw error;
    }
  }

  return {
    destroy() {
      isDestroyed = true;
      rpc?.destroy();
      rpc = null;
    },

    async prepare(map, renderer) {
      if (isDestroyed) {
        throw new Error("Heatmap frame preparer has been destroyed.");
      }

      if (rpc) {
        let response: HeatmapPreparationWorkerResponse | undefined;
        try {
          response = await rpc.request({
            map,
            renderer,
            type: HeatmapPreparationWorkerMessageType.Prepare,
          });
        } catch (error) {
          if (mode === RenderPreparationMode.Worker || isDestroyed) throw error;
          rpc?.destroy();
          rpc = null;
          console.warn(
            "Heatmap preparation worker failed; falling back to the main thread.",
            error,
          );
        }
        if (response?.type === HeatmapPreparationWorkerMessageType.Error) {
          throw new RangeError(response.error);
        }
        if (response?.type === HeatmapPreparationWorkerMessageType.Complete) {
          const resource = response.imageBitmap ?? response.imageData;
          if (!resource) throw new Error("Heatmap worker returned no raster.");
          return {
            resource,
            close() {
              if ("close" in resource) resource.close();
            },
          };
        }
      }

      // Deferred from the present, even in environments without workers.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const resource = new ImageData(
        colorizeHeatmap(map, renderer),
        map.width,
        map.height,
      );
      return { resource, close() {} };
    },
  };
}

function isHeatmapResponse(
  value: unknown,
): value is HeatmapPreparationWorkerResponse {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return (
    type === HeatmapPreparationWorkerMessageType.Complete ||
    type === HeatmapPreparationWorkerMessageType.Error
  );
}

function closeHeatmapResponse(response: HeatmapPreparationWorkerResponse) {
  if (response.type === HeatmapPreparationWorkerMessageType.Complete) {
    response.imageBitmap?.close();
  }
}
