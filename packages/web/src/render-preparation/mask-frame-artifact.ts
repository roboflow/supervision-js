export enum PreparedMaskFrameKind {
  IdMask = "idMask",
  RgbaImage = "rgbaImage",
}

/**
 * How an id raster is laid out for the texture it is uploaded into. WebGPU
 * takes any bytesPerRow, so ids go up one byte per pixel. WebGL aligns every
 * uploaded row to four bytes and rejects a single-channel upload whose width
 * is not a multiple of four, which is what the four-channel layout is for.
 */
export enum IdMaskTextureFormat {
  R8 = "r8unorm",
  Rgba8 = "rgba8unorm",
}

export interface PreparedRegionMaskCoverageEntry {
  readonly data: Uint8Array<ArrayBuffer>;
  readonly detectionIndex: number;
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

/**
 * Overlap-preserving membership planes for exact region crops. Every target
 * owns an alpha crop, so masks remain independent where their pixels overlap.
 */
export interface PreparedRegionMaskCoverageFrame {
  readonly entries: readonly PreparedRegionMaskCoverageEntry[];
}

export interface PreparedRgbaMaskFrame {
  readonly height: number;
  /**
   * The uncomposited detection-id plane carried alongside the RGBA composite,
   * so id-keyed effects such as the mask halo still have a plane to read when
   * the id raster could not be cooked.
   */
  readonly idMaskData?: Uint8Array<ArrayBuffer>;
  readonly key: string;
  readonly kind: PreparedMaskFrameKind.RgbaImage;
  readonly regionMaskCoverage?: PreparedRegionMaskCoverageFrame;
  readonly source: HTMLCanvasElement | ImageBitmap;
  readonly width: number;
  close(): void;
}

export interface PreparedIdMaskFrame {
  readonly fillPalette: Float32Array<ArrayBuffer>;
  readonly hasStroke: boolean;
  readonly height: number;
  readonly key: string;
  readonly kind: PreparedMaskFrameKind.IdMask;
  readonly maxStrokeWidth: number;
  readonly raster: Uint8Array<ArrayBuffer>;
  readonly regionMaskCoverage?: PreparedRegionMaskCoverageFrame;
  readonly strokePalette: Float32Array<ArrayBuffer>;
  readonly strokeWidths: Float32Array<ArrayBuffer>;
  readonly width: number;
  close(): void;
}

export type PreparedMaskFrame = PreparedIdMaskFrame | PreparedRgbaMaskFrame;

export function readIdMaskRasterValue(
  frame: PreparedIdMaskFrame,
  x: number,
  y: number,
) {
  return frame.raster[y * frame.width + x] ?? 0;
}
