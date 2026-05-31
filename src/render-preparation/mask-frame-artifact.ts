export enum PreparedMaskFrameKind {
  PngIdMask = "pngIdMask",
  RgbaImage = "rgbaImage",
}

export interface PreparedRgbaMaskFrame {
  readonly height: number;
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
  readonly png: Uint8Array<ArrayBuffer>;
  readonly source: ImageBitmap;
  readonly strokePalette: Float32Array<ArrayBuffer>;
  readonly width: number;
  close(): void;
}

export type PreparedMaskFrame = PreparedPngIdMaskFrame | PreparedRgbaMaskFrame;
