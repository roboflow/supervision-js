import { createDefaultRenderPreparationWorkerFactory } from "../default-render-preparation-worker";
import { decodeDepthPreparationRequest } from "./frame-decode";
import { getBrowserMaskPreparationWorkerCount } from "../mask-preparation-worker-count";
import {
  DepthPreparationWorkerMessageType,
  type DecimatedDepthUpload,
  type DepthPreparationWorkerRequest,
  type DepthPreparationWorkerResponse,
} from "./worker-protocol";
import {
  RenderPreparationMode,
  type RenderPreparationOptions,
} from "#types/render-preparation";
import {
  createWorkerRpcClient,
  type WorkerRpcClient,
} from "#workers/worker-rpc-client";

/** A decoded depth PNG: host-order samples, or bytes for a confidence plane. */
export interface DecodedDepthImage<Values extends Uint16Array | Uint8Array> {
  readonly width: number;
  readonly height: number;
  readonly values: Values;
  /** Odd-width depth rows padded for WebGL, when asked for. */
  readonly paddedUpload?: {
    readonly bytes: Uint8Array;
    readonly textureWidth: number;
  };
  /** Depth decimated for upload, when `decimateBy` asked for it. */
  readonly decimatedUpload?: DecimatedDepthUpload<Uint8Array>;
}

export interface DepthDecodeOptions {
  readonly padRowsForWebGl?: boolean;
  /** Also decimate depth by this whole factor for upload, from 2 up. */
  readonly decimateBy?: number;
  /** Drops the result; the decode itself runs to the end in the worker. */
  readonly signal?: AbortSignal;
}

export interface DepthFramePreparer {
  /**
   * Decodes worth running at once: one per worker in the pool, sized as the
   * mask workers are, or 1 on the main thread.
   */
  readonly concurrency: number;
  /** Decodes a 16-bit depth PNG. The bytes are the preparer's from here on. */
  decodeDepth(
    bytes: ArrayBuffer,
    options?: DepthDecodeOptions,
  ): Promise<DecodedDepthImage<Uint16Array>>;
  decodeConfidence(
    bytes: ArrayBuffer,
    options?: Pick<DepthDecodeOptions, "signal">,
  ): Promise<DecodedDepthImage<Uint8Array>>;
  destroy(): void;
}

/**
 * Decodes depth and confidence PNGs in a pool of render-preparation workers,
 * sized the way the mask pool is (`maskFrame.workerCount`, by default half
 * the cores up to 4), or on the main thread when the mode asks for it or
 * `Auto` finds no working worker. The first worker starts at once, so a
 * factory that throws fails `Worker` mode here; the others start only when
 * every running one is busy, so a still map never spawns a pool.
 *
 * Until a worker has answered once, `Auto` posts a copy of the bytes, so a
 * worker that fails to start (a CSP that blocks blob workers, say) leaves the
 * original to decode here. After that the bytes are transferred. Nothing ever
 * terminates a worker to cancel a decode: an aborted request's reply is
 * dropped when it arrives.
 */
export function createDepthFramePreparer(
  options: RenderPreparationOptions | undefined,
): DepthFramePreparer {
  const mode = options?.mode ?? RenderPreparationMode.Auto;
  const poolSize = getBrowserMaskPreparationWorkerCount(
    options?.maskFrame?.workerCount,
  );
  let isDestroyed = false;
  let workerAnswered = false;
  let warnedFallback = false;
  let factory: { createWorker(): Worker } | null = null;
  let pool: PoolWorker[] | null = null;

  const startWorker = (): PoolWorker => {
    const worker: PoolWorker = {
      busy: 0,
      rpc: createWorkerRpcClient<
        DepthPreparationWorkerRequest,
        DepthPreparationWorkerResponse
      >({
        defaultErrorMessage: "Depth preparation worker failed.",
        isResponse: isDepthResponse,
        worker: factory!.createWorker(),
      }),
    };

    pool!.push(worker);
    return worker;
  };

  if (mode !== RenderPreparationMode.MainThread) {
    try {
      if (!options?.workerFactory && typeof Worker === "undefined") {
        throw new Error("Depth preparation worker is unavailable.");
      }
      factory =
        options?.workerFactory ?? createDefaultRenderPreparationWorkerFactory();
      pool = [];
      startWorker();
    } catch (error) {
      pool = null;
      if (mode === RenderPreparationMode.Worker) throw error;
    }
  }

  /** The least busy worker, starting another while all are busy and there is room. */
  const pickWorker = (): PoolWorker | null => {
    if (!pool || pool.length === 0) return null;

    let least = pool[0];

    for (const worker of pool) if (worker.busy < least.busy) least = worker;
    if (least.busy > 0 && pool.length < poolSize && workerAnswered) {
      try {
        return startWorker();
      } catch {
        // A pool that cannot grow keeps the workers it has.
      }
    }

    return least;
  };

  const abandonPool = () => {
    for (const worker of pool ?? []) worker.rpc.destroy();
    pool = null;
  };

  const decode = async (
    bytes: ArrayBuffer,
    bitDepth: 16 | 8,
    decodeOptions: DepthDecodeOptions,
  ): Promise<
    Extract<
      DepthPreparationWorkerResponse,
      { type: DepthPreparationWorkerMessageType.Complete }
    >
  > => {
    const { signal } = decodeOptions;

    if (isDestroyed) {
      throw new Error("Depth frame preparer has been destroyed.");
    }
    signal?.throwIfAborted();

    const request = {
      bitDepth,
      bytes,
      decimateBy: decodeOptions.decimateBy,
      padRowsForWebGl: decodeOptions.padRowsForWebGl,
      type: DepthPreparationWorkerMessageType.Decode,
    } as const;
    let response: DepthPreparationWorkerResponse | undefined;
    const worker = pickWorker();

    if (worker) {
      const transfer =
        mode === RenderPreparationMode.Worker || workerAnswered
          ? [bytes]
          : undefined;

      const byteLength = bytes.byteLength;

      worker.busy += 1;
      try {
        response = await abortable(
          worker.rpc.request(request, transfer),
          signal,
        );
        workerAnswered = true;
      } catch (error) {
        if (
          signal?.aborted ||
          isDestroyed ||
          mode === RenderPreparationMode.Worker
        ) {
          throw error;
        }
        // A worker that broke stays broken; later decodes stay here.
        abandonPool();
        // Bytes the worker already took cannot be decoded here.
        if (bytes.byteLength !== byteLength) throw error;
        if (!warnedFallback) {
          warnedFallback = true;
          console.warn(
            "Depth preparation worker failed; decoding on the main thread.",
            error,
          );
        }
      } finally {
        worker.busy -= 1;
      }
    }

    if (!response) {
      response = (await decodeDepthPreparationRequest(request)).response;
      signal?.throwIfAborted();
    }
    if (isDestroyed) {
      throw new Error("Depth frame preparer has been destroyed.");
    }
    if (response.type === DepthPreparationWorkerMessageType.Error) {
      throw new RangeError(response.error);
    }

    return response;
  };

  return {
    get concurrency() {
      return pool ? poolSize : 1;
    },

    async decodeConfidence(bytes, decodeOptions = {}) {
      const response = await decode(bytes, 8, decodeOptions);

      return {
        height: response.height,
        values: new Uint8Array(response.values),
        width: response.width,
      };
    },

    async decodeDepth(bytes, decodeOptions = {}) {
      const response = await decode(bytes, 16, decodeOptions);

      return {
        decimatedUpload: response.decimatedUpload
          ? {
              ...response.decimatedUpload,
              bytes: new Uint8Array(response.decimatedUpload.bytes),
            }
          : undefined,
        height: response.height,
        paddedUpload: response.paddedUpload
          ? {
              bytes: new Uint8Array(response.paddedUpload.bytes),
              textureWidth: response.paddedUpload.textureWidth,
            }
          : undefined,
        values: new Uint16Array(response.values),
        width: response.width,
      };
    },

    destroy() {
      isDestroyed = true;
      abandonPool();
    },
  };
}

interface PoolWorker {
  /** Requests posted and not yet answered. */
  busy: number;
  readonly rpc: WorkerRpcClient<
    DepthPreparationWorkerRequest,
    DepthPreparationWorkerResponse
  >;
}

/** Rejects when the signal aborts; the work itself carries on unobserved. */
export function abortable<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
) {
  if (!signal) return work;

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);

    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function isDepthResponse(
  value: unknown,
): value is DepthPreparationWorkerResponse {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;

  return (
    type === DepthPreparationWorkerMessageType.Complete ||
    type === DepthPreparationWorkerMessageType.Error
  );
}
