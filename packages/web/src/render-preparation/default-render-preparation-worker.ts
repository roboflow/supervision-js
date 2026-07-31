import type { RenderPreparationWorkerFactory } from "#types/render-preparation";

const DEFAULT_WORKER_NAME = "supervision-js-render-preparation";

/**
 * The worker has a split protocol dependency. Webpack consumers that emit
 * worker entries under `/_app/` need this entry option in the published ESM so
 * that its follow-up chunks resolve from `/_app/`, rather than relatively from
 * `/_app/<worker>.js` as `/_app/_app/<chunk>.js`.
 *
 * Rollup removes ordinary comments, so the package build restores this webpack
 * magic comment at the exact `new URL` expression in its output.
 */
export function createDefaultRenderPreparationWorkerFactory(): RenderPreparationWorkerFactory {
  return {
    createWorker() {
      return new Worker(
        new URL(
          /* webpackEntryOptions: { publicPath: "/" } */
          "./mask-preparation.worker.js",
          import.meta.url,
        ),
        {
          name: DEFAULT_WORKER_NAME,
          type: "module",
        },
      );
    },
  };
}
