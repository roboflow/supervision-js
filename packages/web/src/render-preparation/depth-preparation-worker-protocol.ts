/**
 * Messages between the depth source and the render-preparation worker, which
 * decodes depth and confidence PNGs off the main thread. Internal: the worker
 * script is a deployment asset, and its protocol is not public.
 */
export enum DepthPreparationWorkerMessageType {
  Decode = "depth-decode",
  Complete = "depth-decode-complete",
  Error = "depth-decode-error",
}

export interface DepthPreparationWorkerRequest {
  readonly requestId: number;
  readonly type: DepthPreparationWorkerMessageType.Decode;
  /** The PNG file's bytes, transferred once the worker has proven itself. */
  readonly bytes: ArrayBuffer;
  /** 16 for depth samples, 8 for a confidence plane. */
  readonly bitDepth: 16 | 8;
  /** Also return odd-width depth rows padded for a WebGL upload. */
  readonly padRowsForWebGl?: boolean;
}

export type DepthPreparationWorkerResponse =
  | {
      readonly requestId: number;
      readonly type: DepthPreparationWorkerMessageType.Complete;
      readonly bitDepth: 16 | 8;
      readonly width: number;
      readonly height: number;
      /** Host-order Uint16 samples at 16 bits, bytes at 8, transferred. */
      readonly values: ArrayBuffer;
      readonly paddedUpload?: {
        readonly bytes: ArrayBuffer;
        readonly textureWidth: number;
      };
    }
  | {
      readonly requestId: number;
      readonly type: DepthPreparationWorkerMessageType.Error;
      readonly error: string;
    };
