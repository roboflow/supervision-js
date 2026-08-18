import type { Detection, DetectionFrame } from "#types/detections";

export enum DetectionPickTarget {
  Box = "box",
  Edge = "edge",
  Keypoint = "keypoint",
  Label = "label",
  Mask = "mask",
  Polygon = "polygon",
  Polyline = "polyline",
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
  /** Index of the keypoint or edge when the target identifies a sub-geometry. */
  readonly geometryIndex?: number;
}

export interface DetectionPickOptions {
  readonly padding?: number;
  readonly polylinePadding?: number;
  readonly keypointPadding?: number;
  readonly edgePadding?: number;
  /**
   * Media-to-screen scale (screen pixels per media unit). Pick paddings are
   * screen-space sizes divided by this scale so they stay constant on screen
   * at any zoom, like editing handles. Defaults to 1 (paddings taken as
   * media units).
   */
  readonly viewportScale?: number;
  /** Media dimensions used to map media-space points into mask raster space. */
  readonly maskMediaDimensions?: {
    readonly width: number;
    readonly height: number;
  };
  readonly includeLocked?: boolean;
  readonly includeMasks?: boolean;
  readonly filter?: (detection: Detection, detectionIndex: number) => boolean;
}

interface DetectionSelectionOptionsBase {
  readonly mediaTime?: number;
  readonly point?: DetectionPickPoint;
  readonly target?: DetectionPickTarget;
}

export type DetectionSelectionOptions = DetectionSelectionOptionsBase &
  (
    | {
        readonly detectionId: string | number;
        readonly detectionIndex?: number;
      }
    | {
        readonly detectionId?: string | number;
        readonly detectionIndex: number;
      }
  );

/** The renderer supplies `viewportScale` from its own viewport. */
export interface MediaInteractionOptions extends Omit<
  DetectionPickOptions,
  "viewportScale"
> {
  readonly mode?: MediaInteractionMode;
  readonly onHover?: (pick: DetectionPickResult | null) => void;
  /**
   * Reports selection identity changes. A stable, frame-unique detection id
   * may keep rendering as selected across later frames without re-emitting
   * this callback. The pick is the immutable frame snapshot where the
   * selection event occurred; use the detection id with the active frame when
   * current geometry is required.
   */
  readonly onSelect?: (pick: DetectionPickResult | null) => void;
  readonly multiSelect?: boolean;
  /**
   * Reports selection membership changes, not per-frame geometry updates for
   * stable detection ids. Each pick is the snapshot that produced that
   * membership event.
   */
  readonly onSelectionChange?: (picks: readonly DetectionPickResult[]) => void;
  readonly onMarqueeChange?: (
    rect: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    } | null,
  ) => void;
}
