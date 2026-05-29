import type { RenderPreparationWorkerFactory } from "#types/render-preparation";

const DEFAULT_WORKER_NAME = "supervision-js-render-preparation";

export function createDefaultRenderPreparationWorkerFactory(): RenderPreparationWorkerFactory {
  return {
    createWorker() {
      return new Worker(
        new URL("./mask-preparation.worker.js", import.meta.url),
        {
          name: DEFAULT_WORKER_NAME,
          type: "module",
        },
      );
    },
  };
}
