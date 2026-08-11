import { resolveStyleValue } from "#styles/style-value";
import { resolveStrokeStyle } from "#styles/stroke-style";
import type { BoxFillStyle, BoxStrokeStyle } from "#types/box-style";
import {
  KeypointVisibility,
  type Detection,
  type SkeletonDefinitions,
} from "#types/detections";
import {
  KeypointMarkerShape,
  type KeypointDrawInstruction,
  type KeypointStyle,
  type KeypointStyleContext,
} from "#types/keypoint-style";
import type {
  DetectionStylePredicate,
  DetectionStyleValue,
} from "#types/style";

export interface BaseKeypointStyleOptions {
  readonly definitions?: SkeletonDefinitions;
  readonly markerFill?: DetectionStyleValue<
    Partial<BoxFillStyle>,
    KeypointStyleContext
  >;
  readonly markerStroke?: DetectionStyleValue<
    Partial<BoxStrokeStyle>,
    KeypointStyleContext
  >;
  readonly edgeStroke?: DetectionStyleValue<
    Partial<BoxStrokeStyle>,
    KeypointStyleContext
  >;
  readonly edgeShadowStroke?: DetectionStyleValue<
    Partial<BoxStrokeStyle> | null,
    KeypointStyleContext
  >;
  readonly radius?: DetectionStyleValue<number, KeypointStyleContext>;
  readonly shouldRender?: DetectionStylePredicate<KeypointStyleContext>;
}

export class BaseKeypointStyle implements KeypointStyle {
  constructor(private readonly options: BaseKeypointStyleOptions = {}) {}

  resolve(
    detection: Detection,
    context: KeypointStyleContext,
  ): KeypointDrawInstruction | undefined {
    const geometry = detection.keypoints;

    if (
      !geometry ||
      context.hidden ||
      this.options.shouldRender?.(detection, context) === false
    ) {
      return undefined;
    }

    const definition = detection.className
      ? this.options.definitions?.[detection.className]
      : undefined;
    const markerFill = resolveStyleValue(
      this.options.markerFill,
      detection,
      context,
    );
    const markerStroke = resolveStyleValue(
      this.options.markerStroke,
      detection,
      context,
    );
    const edgeStroke = resolveStyleValue(
      this.options.edgeStroke,
      detection,
      context,
    );
    const shadowStroke = resolveStyleValue(
      this.options.edgeShadowStroke,
      detection,
      context,
    );
    const radius =
      resolveStyleValue(this.options.radius, detection, context) ?? 6;
    const edges = geometry.edges.map(([fromIndex, toIndex], edgeIndex) => ({
      from: geometry.points[fromIndex]!,
      to: geometry.points[toIndex]!,
      stroke: resolveStrokeStyle(
        definition?.edges[edgeIndex]?.color === undefined
          ? edgeStroke
          : { ...edgeStroke, color: definition.edges[edgeIndex].color },
        {
          alpha: 1,
          color: 0x00ff66,
          width: 2,
        },
      ),
      ...(shadowStroke === null
        ? {}
        : {
            shadowStroke: resolveStrokeStyle(shadowStroke, {
              alpha: 0.65,
              color: 0x000000,
              width: 4,
            }),
          }),
    }));
    const markers = geometry.points.flatMap((point, index) => {
      const visibility =
        geometry.visibility?.[index] ?? KeypointVisibility.Visible;

      if (visibility === KeypointVisibility.NotLabeled) {
        return [];
      }

      return [
        {
          fill: {
            alpha: markerFill?.alpha ?? 1,
            color:
              definition?.vertices[index]?.color ??
              markerFill?.color ??
              0x00ff66,
          },
          index,
          point,
          radius,
          shape:
            visibility === KeypointVisibility.Occluded
              ? KeypointMarkerShape.Cross
              : KeypointMarkerShape.Circle,
          stroke: resolveStrokeStyle(markerStroke, {
            alpha: 1,
            color: 0xffffff,
            width: 2,
          }),
        },
      ];
    });

    return { edges, markers };
  }
}
