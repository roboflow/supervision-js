export enum PreparedMaskFrameKind {
  PngIdMask = "pngIdMask",
  RgbaImage = "rgbaImage",
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
   * The uncomposited detection-id plane when preparation falls back to an
   * RGBA image. This keeps id-based effects available without requiring PNG
   * encoding or ImageBitmap support.
   */
  readonly idMaskData?: Uint8Array<ArrayBuffer>;
  readonly key: string;
  readonly kind: PreparedMaskFrameKind.RgbaImage;
  readonly regionMaskCoverage?: PreparedRegionMaskCoverageFrame;
  readonly source: HTMLCanvasElement | ImageBitmap;
  readonly width: number;
  close(): void;
}

export interface PreparedPngIdMaskFrame {
  readonly fillPalette: Float32Array<ArrayBuffer>;
  readonly hasStroke: boolean;
  readonly height: number;
  readonly key: string;
  readonly kind: PreparedMaskFrameKind.PngIdMask;
  readonly maxStrokeWidth: number;
  readonly png: Uint8Array<ArrayBuffer>;
  readonly regionMaskCoverage?: PreparedRegionMaskCoverageFrame;
  readonly source: ImageBitmap;
  readonly strokePalette: Float32Array<ArrayBuffer>;
  readonly strokeWidths: Float32Array<ArrayBuffer>;
  readonly width: number;
  close(): void;
}

export type PreparedMaskFrame = PreparedPngIdMaskFrame | PreparedRgbaMaskFrame;
