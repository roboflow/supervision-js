export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Detection {
  readonly id?: string | number;
  readonly className?: string;
  readonly confidence?: number;
  readonly rect?: Rect;
  readonly metadata?: Record<string, unknown>;
}

export interface DetectionFrame {
  readonly mediaTime: number;
  readonly detections: readonly Detection[];
}
