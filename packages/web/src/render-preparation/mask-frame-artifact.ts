export enum PreparedMaskFrameKind {
  IdMask = "idMask",
  RgbaImage = "rgbaImage",
}

/**
 * How detection ids are laid out in a prepared frame's raster. WebGL aligns
 * every uploaded texture row to four bytes, so a raster whose width is not a
 * multiple of four carries the id in the red channel of four instead of one.
 */
export enum IdMaskRasterFormat {
  R8 = "r8unorm",
  Rgba8 = "rgba8unorm",
}

export interface PreparedRgbaMaskFrame {
  readonly height: number;
  readonly key: string;
  readonly kind: PreparedMaskFrameKind.RgbaImage;
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
  readonly rasterFormat: IdMaskRasterFormat;
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
  const pixelOffset = y * frame.width + x;

  return (
    frame.raster[
      frame.rasterFormat === IdMaskRasterFormat.R8
        ? pixelOffset
        : pixelOffset * 4
    ] ?? 0
  );
}
