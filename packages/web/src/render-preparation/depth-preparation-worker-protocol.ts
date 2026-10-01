import type { DepthPreviewLumaPath } from "./depth-preview-luma";

/**
 * Messages between the depth source and the render-preparation worker, which
 * decodes depth and confidence PNGs, and copies decoded preview frames' luma,
 * off the main thread. Internal: the worker script is a deployment asset, and
 * its protocol is not public.
 */
export enum DepthPreparationWorkerMessageType {
  Decode = "depth-decode",
  Complete = "depth-decode-complete",
  Error = "depth-decode-error",
  PreviewLuma = "depth-preview-luma",
  PreviewLumaComplete = "depth-preview-luma-complete",
}

/** A decoded preview frame, transferred to the worker, which closes it. */
export interface DepthPreviewLumaWorkerRequest {
  readonly requestId: number;
  readonly type: DepthPreparationWorkerMessageType.PreviewLuma;
  readonly frame: VideoFrame;
  readonly correction: Uint8Array | null;
}

export type DepthPreviewLumaWorkerResponse =
  | {
      readonly requestId: number;
      readonly type: DepthPreparationWorkerMessageType.PreviewLumaComplete;
      /** One byte per pixel, transferred. */
      readonly luma: ArrayBuffer;
      readonly width: number;
      readonly height: number;
      readonly path: DepthPreviewLumaPath;
    }
  | {
      readonly requestId: number;
      readonly type: DepthPreparationWorkerMessageType.Error;
      readonly error: string;
    };

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
