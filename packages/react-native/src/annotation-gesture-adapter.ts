import {
  AnnotationHandleKind,
  getAnnotationHandles,
  pickAnnotationHandle,
  pickDetectionAtPoint,
  type AnnotationEditingEngine,
  type AnnotationPointerInput,
  type Detection,
  type DetectionFrame,
  type DetectionPickOptions,
  type DetectionPickResult,
} from "supervision-js-core";

import type { ReactNativeFrameLayout, ReactNativePoint } from "./index";

export interface ReactNativeAnnotationGestureInput extends ReactNativePoint {
  readonly timestamp: number;
  readonly pointerId?: number;
  readonly button?: number;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly detail?: number;
}

export interface ReactNativeAnnotationGestureAdapter {
  pointerDown(
    input: ReactNativeAnnotationGestureInput,
  ): DetectionPickResult | null;
  pointerMove(input: ReactNativeAnnotationGestureInput): void;
  pointerUp(input: ReactNativeAnnotationGestureInput): void;
  keyDown(key: string): void;
  cancel(): void;
}

/**
 * Connects React Native canvas/touch coordinates to the shared core editing
 * engine. Gesture semantics remain identical to web; hosts retain selection,
 * persistence, undo, and native gesture-handler ownership.
 */
export function createReactNativeAnnotationGestureAdapter(options: {
  readonly editingEngine: AnnotationEditingEngine;
  readonly getFrame: () => DetectionFrame;
  readonly getLayout: () => ReactNativeFrameLayout;
  readonly getSelectedDetection?: () => Detection | undefined;
  readonly onPick?: (pick: DetectionPickResult | null) => void;
  readonly pickOptions?: DetectionPickOptions;
}): ReactNativeAnnotationGestureAdapter {
  return {
    pointerDown(input) {
      const layout = options.getLayout();
      const point = layout.mapCanvasPoint(input);
      if (!point) return null;

      const frame = options.getFrame();
      const selected = options.getSelectedDetection?.();
      const handle = selected
        ? pickAnnotationHandle(
            getAnnotationHandles(selected, layout.scale),
            point,
          )
        : undefined;
      const pick = pickDetectionAtPoint(frame, point, {
        ...options.pickOptions,
        maskMediaDimensions: options.pickOptions?.maskMediaDimensions ?? {
          height: layout.mediaRect.height / layout.scale,
          width: layout.mediaRect.width / layout.scale,
        },
        viewportScale: options.pickOptions?.viewportScale ?? layout.scale,
      });

      options.onPick?.(pick);
      if (
        handle?.kind === AnnotationHandleKind.Vertex &&
        handle.geometryIndex !== undefined &&
        selected &&
        (input.button === 2 || input.shiftKey)
      ) {
        options.editingEngine.deleteVertex(selected, handle.geometryIndex);
      } else if (handle && selected) {
        options.editingEngine.beginHandleDrag(
          selected,
          handle,
          toPointerInput(input, point),
        );
      } else {
        options.editingEngine.pointerDown(toPointerInput(input, point), pick);
      }

      return pick;
    },

    pointerMove(input) {
      options.editingEngine.pointerMove(
        toPointerInput(
          input,
          mapCanvasPointUnbounded(options.getLayout(), input),
        ),
      );
    },

    pointerUp(input) {
      options.editingEngine.pointerUp(
        toPointerInput(
          input,
          mapCanvasPointUnbounded(options.getLayout(), input),
        ),
      );
    },

    keyDown(key) {
      options.editingEngine.keyDown(key);
    },

    cancel() {
      options.editingEngine.cancel();
    },
  };
}

function mapCanvasPointUnbounded(
  layout: ReactNativeFrameLayout,
  point: ReactNativePoint,
) {
  return {
    x: (point.x - layout.mediaRect.x) / layout.scale,
    y: (point.y - layout.mediaRect.y) / layout.scale,
  };
}

function toPointerInput(
  input: ReactNativeAnnotationGestureInput,
  point: ReactNativePoint,
): AnnotationPointerInput {
  return {
    point,
    timestamp: input.timestamp,
    button: input.button,
    shiftKey: input.shiftKey,
    altKey: input.altKey,
    ctrlKey: input.ctrlKey,
    metaKey: input.metaKey,
    detail: input.detail,
    pointerId: input.pointerId,
  };
}
