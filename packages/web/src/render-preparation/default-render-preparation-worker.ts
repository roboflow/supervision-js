import { EMBEDDED_MASK_PREPARATION_WORKER_SOURCE } from "#render-preparation/embedded-mask-preparation-worker";
import type { RenderPreparationWorkerFactory } from "#types/render-preparation";

const DEFAULT_WORKER_NAME = "supervision-js-render-preparation";
let defaultWorkerUrl: string | undefined;

/**
 * Creates workers from the self-contained source embedded in the browser
 * package. The shared object URL is intentionally retained for the lifetime of
 * the module so every session and every member of a worker pool can reuse it.
 */
export function createDefaultRenderPreparationWorkerFactory(): RenderPreparationWorkerFactory {
  return {
    createWorker() {
      defaultWorkerUrl ??= URL.createObjectURL(
        new Blob([EMBEDDED_MASK_PREPARATION_WORKER_SOURCE], {
          type: "text/javascript",
        }),
      );

      return new Worker(defaultWorkerUrl, {
        name: DEFAULT_WORKER_NAME,
      });
    },
  };
}
