import { createDefaultRenderPreparationWorkerFactory } from "./default-render-preparation-worker";
import { decodeDepthPreparationRequest } from "./depth-frame-decode";
import {
  DepthPreparationWorkerMessageType,
  type DepthPreparationWorkerRequest,
  type DepthPreparationWorkerResponse,
} from "./depth-preparation-worker-protocol";
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
}

export interface DepthDecodeOptions {
  readonly padRowsForWebGl?: boolean;
  /** Drops the result; the decode itself runs to the end in the worker. */
  readonly signal?: AbortSignal;
}

export interface DepthFramePreparer {
  /** Decodes a 16-bit depth PNG. The bytes are the preparer's from here on. */
  decodeDepth(
    bytes: ArrayBuffer,
    options?: DepthDecodeOptions,
  ): Promise<DecodedDepthImage<Uint16Array>>;
  /** Decodes an 8-bit confidence PNG. */
  decodeConfidence(
    bytes: ArrayBuffer,
    options?: Pick<DepthDecodeOptions, "signal">,
  ): Promise<DecodedDepthImage<Uint8Array>>;
  destroy(): void;
}

/**
 * Decodes depth and confidence PNGs in the render-preparation worker, the one
 * the session already uses for masks and heatmaps, or on the main thread when
 * the mode asks for it or `Auto` finds no working worker.
 *
 * Until the worker has answered once, `Auto` posts a copy of the bytes, so a
 * worker that fails to start (a CSP that blocks blob workers, say) leaves the
 * original to decode here. After that the bytes are transferred. Nothing ever
 * terminates the worker to cancel a decode: an aborted request's reply is
 * dropped when it arrives.
 */
export function createDepthFramePreparer(
  options: RenderPreparationOptions | undefined,
): DepthFramePreparer {
  const mode = options?.mode ?? RenderPreparationMode.Auto;
  let isDestroyed = false;
  let workerAnswered = false;
  let warnedFallback = false;
  let rpc: WorkerRpcClient<
    DepthPreparationWorkerRequest,
    DepthPreparationWorkerResponse
  > | null = null;

  if (mode !== RenderPreparationMode.MainThread) {
    try {
      if (!options?.workerFactory && typeof Worker === "undefined") {
        throw new Error("Depth preparation worker is unavailable.");
      }
      const factory =
        options?.workerFactory ?? createDefaultRenderPreparationWorkerFactory();

      rpc = createWorkerRpcClient<
        DepthPreparationWorkerRequest,
        DepthPreparationWorkerResponse
      >({
        defaultErrorMessage: "Depth preparation worker failed.",
        isResponse: isDepthResponse,
        worker: factory.createWorker(),
      });
    } catch (error) {
      if (mode === RenderPreparationMode.Worker) throw error;
    }
  }

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
      padRowsForWebGl: decodeOptions.padRowsForWebGl,
      type: DepthPreparationWorkerMessageType.Decode,
    } as const;
    let response: DepthPreparationWorkerResponse | undefined;

    if (rpc) {
      const transfer =
        mode === RenderPreparationMode.Worker || workerAnswered
          ? [bytes]
          : undefined;

      const byteLength = bytes.byteLength;

      try {
        response = await abortable(rpc.request(request, transfer), signal);
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
        rpc?.destroy();
        rpc = null;
        // Bytes the worker already took cannot be decoded here.
        if (bytes.byteLength !== byteLength) throw error;
        if (!warnedFallback) {
          warnedFallback = true;
          console.warn(
            "Depth preparation worker failed; decoding on the main thread.",
            error,
          );
        }
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
      rpc?.destroy();
      rpc = null;
    },
  };
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
