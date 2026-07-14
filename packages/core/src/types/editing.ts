import type { Detection, Point, Rect } from "#types/detections";
import type { DetectionPickResult } from "#types/interaction";
import type { BoxFillStyle, BoxStrokeStyle } from "#types/box-style";

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

/** Renderer-neutral presentation for editing affordances and previews. */
export interface AnnotationOverlayStyle {
  readonly editingPreview?: {
    readonly stroke?: BoxStrokeStyle;
    readonly polygonFill?: BoxFillStyle;
    readonly closeZoneStroke?: BoxStrokeStyle;
  };
  readonly selectionHandle?: {
    readonly fill?: BoxFillStyle;
    readonly stroke?: BoxStrokeStyle;
    readonly addVertexAlpha?: number;
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
