import type { Detection, DetectionFrame } from "#types/detections";

export enum DetectionPickTarget {
  Box = "box",
  Mask = "mask",
}

export enum MediaInteractionMode {
  Always = "always",
  Disabled = "disabled",
  PausedOnly = "pausedOnly",
}

export interface DetectionPickPoint {
  readonly x: number;
  readonly y: number;
}

export interface DetectionPickResult {
  readonly detection: Detection;
  readonly detectionIndex: number;
  readonly frame: DetectionFrame;
  readonly mediaTime: number;
  readonly point: DetectionPickPoint;
  readonly target: DetectionPickTarget;
}

export interface DetectionPickOptions {
  readonly padding?: number;
}

export interface DetectionSelectionOptions {
  readonly detectionIndex: number;
  readonly mediaTime?: number;
  readonly point?: DetectionPickPoint;
  readonly target?: DetectionPickTarget;
}

export interface MediaInteractionOptions extends DetectionPickOptions {
  readonly mode?: MediaInteractionMode;
  readonly onHover?: (pick: DetectionPickResult | null) => void;
  readonly onSelect?: (pick: DetectionPickResult | null) => void;
}
