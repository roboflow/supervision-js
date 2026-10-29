import type { Detection, DetectionFrame } from "#types/detections";
import type {
  AnnotationHandleDefinition,
  AnnotationPointerInput,
} from "#types/editing";

export enum DetectionPickTarget {
  Box = "box",
  Edge = "edge",
  Keypoint = "keypoint",
  Label = "label",
  Mask = "mask",
  OrientedBox = "orientedBox",
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
  /** Pick editable geometry by zIndex, then frame order, rather than area.
   *  Rects accompanying masks or paths are bounds, not independent box targets;
   *  mask fills stay below vector geometry unless maskOrder is "detection".
   *  Defaults to false. */
  readonly preferTopmost?: boolean;
  /** Include masks in detection order when preferTopmost is enabled. */
  readonly maskOrder?: "detection";
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
        readonly detectionIds?: never;
      }
    | {
        readonly detectionId?: string | number;
        readonly detectionIndex: number;
        readonly detectionIds?: never;
      }
    | {
        /** Ordered selection; takes precedence over singular selectors. */
        readonly detectionIds: readonly (string | number)[];
        readonly detectionId?: string | number;
        readonly detectionIndex?: number;
      }
  );

/** The renderer supplies `viewportScale` from its own viewport. */
export interface MediaInteractionOptions extends Omit<
  DetectionPickOptions,
  "viewportScale"
> {
  readonly mode?: MediaInteractionMode;
  /**
   * Runs before default selection, editing, or marquee handling, including empty
   * presses and repeated hits. Return "handled" to skip those defaults and the
   * press's subsequent tap, or "continue" to keep them. Hosts own any ongoing
   * gesture and should let its release or cancellation reach the renderer.
   * The browser may report coordinates outside media; there, "continue" permits
   * only selected-handle editing with an editing engine.
   * Returning "continue" must leave selection and editing state unchanged:
   * defaults use the snapshot resolved before this callback. Return "handled"
   * when the host changes that state.
   */
  readonly onPointerPress?: (press: {
    readonly input: AnnotationPointerInput;
    readonly pick: DetectionPickResult | null;
    /** Semantic handle of the primary selection; it need not be drawn. */
    readonly selectedHandle: {
      readonly pick: DetectionPickResult;
      readonly handle: AnnotationHandleDefinition;
    } | null;
  }) => "handled" | "continue";
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
  /** Select intersecting bounds by default, or require full containment. */
  readonly marqueeSelectionMode?: "intersects" | "contained";
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
