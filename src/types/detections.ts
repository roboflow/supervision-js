export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export enum DetectionMaskEncoding {
  CompressedRle = "compressedRle",
}

export interface CompressedRleDetectionMask {
  readonly encoding: DetectionMaskEncoding.CompressedRle;
  readonly width: number;
  readonly height: number;
  readonly counts: string;
}

export type DetectionMask = CompressedRleDetectionMask;

export interface Detection {
  readonly id?: string | number;
  readonly className?: string;
  readonly confidence?: number;
  readonly rect?: Rect;
  readonly mask?: DetectionMask;
  readonly metadata?: Record<string, unknown>;
}

export interface DetectionFrame {
  readonly frameIndex?: number;
  readonly mediaTime: number;
  readonly endTime?: number;
  readonly detections: readonly Detection[];
}
