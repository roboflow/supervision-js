import { decodePng16, decodePng8Gray } from "./depth-png16";
import {
  DepthPreparationWorkerMessageType,
  type DepthPreparationWorkerRequest,
  type DepthPreparationWorkerResponse,
} from "./depth-preparation-worker-protocol";

/**
 * Answers one decode request, in the worker or on the main thread: the reply
 * and the buffers it can transfer. A file that does not decode is an error
 * reply, never a thrown exception, so the caller can tell a bad file from a
 * broken worker.
 */
export async function decodeDepthPreparationRequest(
  request: Omit<DepthPreparationWorkerRequest, "requestId"> & {
    readonly requestId?: number;
  },
): Promise<{
  readonly response: DepthPreparationWorkerResponse;
  readonly transfer: Transferable[];
}> {
  const requestId = request.requestId ?? 0;

  try {
    if (request.bitDepth === 8) {
      const decoded = await decodePng8Gray(request.bytes);

      return {
        response: {
          bitDepth: 8,
          height: decoded.height,
          requestId,
          type: DepthPreparationWorkerMessageType.Complete,
          values: decoded.values.buffer,
          width: decoded.width,
        },
        transfer: [decoded.values.buffer],
      };
    }

    const decoded = await decodePng16(request.bytes, {
      padRowsForWebGl: request.padRowsForWebGl,
    });
    const padded = decoded.paddedUpload;

    return {
      response: {
        bitDepth: 16,
        height: decoded.height,
        paddedUpload: padded
          ? {
              bytes: padded.bytes.buffer,
              textureWidth: padded.textureWidth,
            }
          : undefined,
        requestId,
        type: DepthPreparationWorkerMessageType.Complete,
        values: decoded.values.buffer,
        width: decoded.width,
      },
      transfer: padded
        ? [decoded.values.buffer, padded.bytes.buffer]
        : [decoded.values.buffer],
    };
  } catch (error) {
    return {
      response: {
        error:
          error instanceof Error ? error.message : "Unable to decode depth.",
        requestId,
        type: DepthPreparationWorkerMessageType.Error,
      },
      transfer: [],
    };
  }
}
