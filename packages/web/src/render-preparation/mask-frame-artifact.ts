export enum PreparedMaskFrameKind {
  PngIdMask = "pngIdMask",
  RgbaImage = "rgbaImage",
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
  readonly source: ImageBitmap;
  readonly strokePalette: Float32Array<ArrayBuffer>;
  readonly strokeWidths: Float32Array<ArrayBuffer>;
  readonly width: number;
  close(): void;
}

export type PreparedMaskFrame = PreparedPngIdMaskFrame | PreparedRgbaMaskFrame;
