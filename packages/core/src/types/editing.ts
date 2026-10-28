import type { Detection, Point, Rect } from "#types/detections";
import type { DetectionPickResult } from "#types/interaction";
import type { BoxFillStyle, BoxStrokeStyle } from "#types/box-style";
import type { AnnotationStyleContext, DetectionStyleValue } from "#types/style";

export enum AnnotationGeometryKind {
  Box = "box",
  OrientedBox = "orientedBox",
  Polygon = "polygon",
  Polyline = "polyline",
  Keypoints = "keypoints",
  Mask = "mask",
}

export enum AnnotationGestureStateKind {
  Idle = "idle",
  Creating = "creating",
  Moving = "moving",
  Resizing = "resizing",
  Rotating = "rotating",
  DragSelecting = "dragSelecting",
}

export enum AnnotationHandleKind {
  Resize = "resize",
  Rotate = "rotate",
  Vertex = "vertex",
  AddVertex = "addVertex",
  Keypoint = "keypoint",
}

export interface AnnotationHandleDefinition {
  readonly id: string;
  readonly kind: AnnotationHandleKind;
  readonly point: Point;
  readonly cursor: string;
  readonly geometryIndex?: number;
  readonly edgeIndex?: number;
  readonly radius: number;
  readonly hitSize: number;
  /** Media-space start of the stem drawn toward a rotation control. */
  readonly stemFrom?: Point;
}

export interface AnnotationPointerInput {
  readonly point: Point;
  readonly timestamp: number;
  /** Natural media size. Bounds box gestures and dragged or inserted polygon vertices. */
  readonly mediaDimensions?: Pick<Rect, "width" | "height">;
  readonly button?: number;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly detail?: number;
  readonly pointerId?: number;
}

/** Keyboard modifier snapshot; omitted keys are released. */
export type AnnotationModifierKeys = Pick<
  AnnotationPointerInput,
  "shiftKey" | "altKey" | "ctrlKey" | "metaKey"
>;

/** Rotation handle placement on an ordered rectangle's local edge. */
export interface AnnotationRotationHandleOptions {
  /** Ordered top/right/bottom/left edge; defaults to 0 (top). */
  readonly edgeIndex?: 0 | 1 | 2 | 3;
  /** Outward distance from the edge in CSS pixels; defaults to 24. */
  readonly offset?: number;
  /** Outward stem start distance in CSS pixels; defaults to 0 and must not exceed offset. */
  readonly stemOffset?: number;
}

export interface AnnotationHandleOptions {
  readonly rotationHandle?:
    | AnnotationRotationHandleOptions
    | ((detection: Detection) => AnnotationRotationHandleOptions);
}

export interface AnnotationRotationContext {
  /** Original detection at gesture start, with its metadata and ordered axes. */
  readonly detection: Detection;
  /** Initial clockwise radians, in the geometry helper's [-PI, PI] convention. */
  readonly initialRotation: number;
  /** Latest raw pointer input, including the current modifier snapshot. */
  readonly input: AnnotationPointerInput;
}

export interface AnnotationCreationTool {
  readonly geometry: AnnotationGeometryKind;
  /** OrientedBox drag creation supplies clockwise corners with local +x along the dominant drag direction. */
  createDetection(geometry: Rect | readonly Point[]): Detection;
  readonly minVertices?: number;
  readonly mode?: "drag" | "multiClick" | "freehand";
  readonly shouldCommit?: (geometry: Rect | readonly Point[]) => boolean;
  /** Called when a completed creation gesture is rejected, never on cancel(). */
  readonly onRejected?: () => void;
}

export interface AnnotationEditingState {
  readonly kind: AnnotationGestureStateKind;
  readonly preview: Detection | null;
  readonly activeDetectionId: string | number | null;
  readonly activeHandleId: string | null;
  readonly pointerId: number | null;
}

export interface AnnotationEditingEngineOptions extends AnnotationHandleOptions {
  /** Constrain an absolute clockwise rotation candidate in radians. Called once
   * per preview or commit from original geometry, never from a prior preview.
   * Return finite radians; the engine normalizes the result to [-PI, PI]. */
  readonly resolveRotation?: (
    radians: number,
    context: AnnotationRotationContext,
  ) => number;
  readonly viewportScale?: () => number;
  readonly onStateChange?: (state: AnnotationEditingState) => void;
  readonly onPreview?: (preview: Detection | null) => void;
  /** Runs before terminal idle subscribers; getState() already reflects completion. */
  readonly onCommit?: (
    detection: Detection,
    previous: Detection | null,
  ) => void;
  /** Whole-edit cancellation; a contact interruption that retains a draft does not call this. */
  readonly onCancel?: () => void;
  readonly onFastTranslate?: (
    id: string | number,
    dx: number,
    dy: number,
  ) => void;
  readonly capturePointer?: (pointerId: number) => void;
  readonly releasePointer?: (pointerId: number) => void;
}

export interface AnnotationEditingEngine {
  getState(): AnnotationEditingState;
  /** Configured semantic handles; adapters fall back to getAnnotationHandles. */
  getHandles?(
    detection: Detection,
    viewportScale?: number,
  ): readonly AnnotationHandleDefinition[];
  /** Recompute an already-moved rotation preview without moving or committing. */
  setModifiers?(modifiers: AnnotationModifierKeys): void;
  setCreationTool(tool: AnnotationCreationTool | null): void;
  pointerDown(
    input: AnnotationPointerInput,
    pick?: DetectionPickResult | null,
  ): void;
  pointerMove(input: AnnotationPointerInput): void;
  pointerUp(input: AnnotationPointerInput): void;
  /** Ends an interrupted contact without discarding accepted multi-click vertices.
   * An omitted identity addresses the active contact; no active contact is a no-op. */
  pointerCancel?(pointerId?: number): void;
  keyDown(key: string): void;
  /** Remove the last multi-click draft vertex. Returns false when no path is active.
   * Consumes the final vertex by cancelling the draft, without committing it. */
  undoCreation?(): boolean;
  beginHandleDrag(
    detection: Detection,
    handle: AnnotationHandleDefinition,
    input: AnnotationPointerInput,
  ): void;
  deleteVertex(detection: Detection, vertexIndex: number): Detection | null;
  /** Discards the gesture and all uncommitted draft vertices. */
  cancel(): void;
  hasCreationTool(): boolean;
  subscribe(listener: (state: AnnotationEditingState) => void): () => void;
  subscribeFastTranslate(
    listener: (id: string | number, dx: number, dy: number) => void,
  ): () => void;
}

/** The built-in editing engine guarantees multi-click draft Undo. */
export interface DraftUndoAnnotationEditingEngine extends AnnotationEditingEngine {
  undoCreation(): boolean;
}

export interface BuiltInAnnotationEditingEngine extends DraftUndoAnnotationEditingEngine {
  pointerCancel(pointerId?: number): void;
}

/** Factory engine with configured handle placement and live modifier updates. */
export interface ConfiguredAnnotationEditingEngine extends BuiltInAnnotationEditingEngine {
  getHandles(
    detection: Detection,
    viewportScale?: number,
  ): readonly AnnotationHandleDefinition[];
  setModifiers(modifiers: AnnotationModifierKeys): void;
}

export interface PreviewOverlayPoint extends Point {
  readonly positive: boolean;
}

export interface PreviewOverlayData {
  readonly hoverPolygons?: readonly (readonly Point[])[];
  readonly draftPolygons?: readonly (readonly Point[])[];
  readonly points?: readonly PreviewOverlayPoint[];
}

/** Presentation context for a live annotation editing preview. */
export interface AnnotationEditingPreviewStyleContext {
  readonly gestureKind: AnnotationGestureStateKind;
  /** Media-to-screen scale. Screen-space style values are divided by this. */
  readonly viewportScale: number;
}

/** Renderer-neutral presentation for editing affordances and previews. */
export interface AnnotationOverlayStyle {
  readonly editingPreview?: {
    /**
     * Static or annotation-aware preview styling. Resolver support keeps
     * creation, move, and resize previews aligned with the annotation class.
     */
    readonly stroke?: DetectionStyleValue<
      BoxStrokeStyle,
      AnnotationEditingPreviewStyleContext
    >;
    /** Fill for box creation previews. */
    readonly boxFill?: DetectionStyleValue<
      BoxFillStyle,
      AnnotationEditingPreviewStyleContext
    >;
    readonly polygonFill?: DetectionStyleValue<
      BoxFillStyle,
      AnnotationEditingPreviewStyleContext
    >;
    readonly closeZoneStroke?: DetectionStyleValue<
      BoxStrokeStyle,
      AnnotationEditingPreviewStyleContext
    >;
  };
  readonly selectionHandle?: {
    /**
     * Static or annotation-aware handle fills. Resolver support keeps handles
     * visually aligned with each selected annotation, including multi-select.
     */
    readonly fill?: DetectionStyleValue<BoxFillStyle, AnnotationStyleContext>;
    readonly stroke?: DetectionStyleValue<
      BoxStrokeStyle,
      AnnotationStyleContext
    >;
    readonly addVertexAlpha?: number;
    /**
     * Alpha for keypoint handles. Keypoint markers are already drawn by the
     * keypoint style, so consumers that treat the marker itself as the handle
     * set 0 to keep hit testing without a second disc over every point.
     */
    readonly keypointAlpha?: number;
  };
  readonly marquee?: {
    readonly fill?: BoxFillStyle;
  };
  readonly guide?: {
    readonly stroke?: BoxStrokeStyle;
    readonly shadowStroke?: BoxStrokeStyle;
  };
  readonly externalPreview?: {
    readonly hoverFill?: BoxFillStyle;
    readonly hoverStroke?: BoxStrokeStyle;
    readonly draftFill?: BoxFillStyle;
    readonly draftStroke?: BoxStrokeStyle;
    readonly positivePointFill?: BoxFillStyle;
    readonly negativePointFill?: BoxFillStyle;
    readonly pointStroke?: BoxStrokeStyle;
  };
  readonly loading?: {
    readonly stroke?: BoxStrokeStyle;
  };
}
