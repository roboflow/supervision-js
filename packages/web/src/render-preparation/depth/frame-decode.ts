import { decodePng16, decodePng8Gray } from "./png16";
import {
  DepthPreparationWorkerMessageType,
  type DecimatedDepthUpload,
  type DepthPreparationWorkerRequest,
  type DepthPreparationWorkerResponse,
} from "./worker-protocol";

const HOST_IS_LITTLE_ENDIAN =
  new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

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
    const decimated =
      request.decimateBy !== undefined && request.decimateBy >= 2
        ? decimateDepthUpload(
            decoded.values,
            decoded.width,
            decoded.height,
            Math.floor(request.decimateBy),
            request.padRowsForWebGl === true,
          )
        : null;
    const transfer: Transferable[] = [decoded.values.buffer];

    if (padded) transfer.push(padded.bytes.buffer);
    if (decimated) transfer.push(decimated.bytes.buffer);

    return {
      response: {
        bitDepth: 16,
        decimatedUpload: decimated
          ? { ...decimated, bytes: decimated.bytes.buffer as ArrayBuffer }
          : undefined,
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
      transfer,
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

/**
 * Depth for a texture `factor` times smaller on each side, each texel the
 * sample at its block's centre, as the renderer decimates a map larger than
 * the GPU allows. Null on a big-endian host, which uploads the full map.
 */
export function decimateDepthUpload(
  values: Uint16Array,
  width: number,
  height: number,
  factor: number,
  padRowsForWebGl: boolean,
): DecimatedDepthUpload<Uint8Array> | null {
  if (!HOST_IS_LITTLE_ENDIAN || factor < 2) return null;

  const targetWidth = Math.ceil(width / factor);
  const targetHeight = Math.ceil(height / factor);
  // WebGL reads two-byte texels in rows of four bytes.
  const textureWidth = padRowsForWebGl
    ? targetWidth + (targetWidth % 2)
    : targetWidth;
  const texels = new Uint16Array(textureWidth * targetHeight);
  const columns = new Uint32Array(targetWidth);

  for (let x = 0; x < targetWidth; x += 1) {
    columns[x] = Math.min(
      width - 1,
      Math.floor(((x + 0.5) * width) / targetWidth),
    );
  }
  for (let y = 0; y < targetHeight; y += 1) {
    const row =
      Math.min(height - 1, Math.floor(((y + 0.5) * height) / targetHeight)) *
      width;
    const target = y * textureWidth;

    for (let x = 0; x < targetWidth; x += 1) {
      texels[target + x] = values[row + columns[x]];
    }
  }

  return {
    bytes: new Uint8Array(texels.buffer),
    height: targetHeight,
    textureWidth,
    width: targetWidth,
  };
}
