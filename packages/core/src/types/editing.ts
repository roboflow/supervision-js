import type { Detection, Point, Rect } from "#types/detections";
import type { DetectionPickResult } from "#types/interaction";
import type { BoxFillStyle, BoxStrokeStyle } from "#types/box-style";
import type { AnnotationStyleContext, DetectionStyleValue } from "#types/style";

export enum AnnotationGeometryKind {
  Box = "box",
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
  DragSelecting = "dragSelecting",
}

export enum AnnotationHandleKind {
  Resize = "resize",
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
}

export interface AnnotationPointerInput {
  readonly point: Point;
  readonly timestamp: number;
  readonly button?: number;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly detail?: number;
  readonly pointerId?: number;
}

export interface AnnotationCreationTool {
  readonly geometry: AnnotationGeometryKind;
  createDetection(geometry: Rect | readonly Point[]): Detection;
  readonly minVertices?: number;
  readonly mode?: "drag" | "multiClick" | "freehand";
  readonly shouldCommit?: (geometry: Rect | readonly Point[]) => boolean;
}

export interface AnnotationEditingState {
  readonly kind: AnnotationGestureStateKind;
  readonly preview: Detection | null;
  readonly activeDetectionId: string | number | null;
  readonly activeHandleId: string | null;
  readonly pointerId: number | null;
}

export interface AnnotationEditingEngineOptions {
  readonly viewportScale?: () => number;
  readonly onStateChange?: (state: AnnotationEditingState) => void;
  readonly onPreview?: (preview: Detection | null) => void;
  readonly onCommit?: (
    detection: Detection,
    previous: Detection | null,
  ) => void;
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
  setCreationTool(tool: AnnotationCreationTool | null): void;
  pointerDown(
    input: AnnotationPointerInput,
    pick?: DetectionPickResult | null,
  ): void;
  pointerMove(input: AnnotationPointerInput): void;
  pointerUp(input: AnnotationPointerInput): void;
  keyDown(key: string): void;
  beginHandleDrag(
    detection: Detection,
    handle: AnnotationHandleDefinition,
    input: AnnotationPointerInput,
  ): void;
  deleteVertex(detection: Detection, vertexIndex: number): Detection | null;
  cancel(): void;
  hasCreationTool(): boolean;
  subscribe(listener: (state: AnnotationEditingState) => void): () => void;
  subscribeFastTranslate(
    listener: (id: string | number, dx: number, dy: number) => void,
  ): () => void;
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
