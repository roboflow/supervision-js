import { EMBEDDED_ENGINE_WORKER_SOURCE } from "./embedded-engine-worker";

const WORKER_NAME = "supervision-js-video-engine";
let workerUrl: string | undefined;

/**
 * The one place the engine worker is spawned. Isolated for two reasons:
 *
 *   - The build embeds the worker as source text, so it spawns from a Blob
 *     object URL and a host needs no bundler configuration to ship it. The URL
 *     is held for the lifetime of the module so every engine instance reuses it.
 *   - Every consumer mocks this module rather than spawn a real worker. Keeping
 *     it a one-function file means the mock surface is a single factory, and the
 *     facade under test stays real.
 */
export function createEngineWorker(): Worker {
  workerUrl ??= URL.createObjectURL(
    new Blob([EMBEDDED_ENGINE_WORKER_SOURCE], { type: "text/javascript" }),
  );

  return new Worker(workerUrl, { name: WORKER_NAME });
}
