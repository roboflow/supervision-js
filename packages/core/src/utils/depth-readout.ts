import {
  DepthMapKind,
  type DepthMap,
  type DepthReadout,
} from "#types/depth-map";
import type { Point } from "#types/detections";
import { decodeDepthSample } from "#utils/depth-color-mapping";

/**
 * Reads the depth map pixel under a point.
 *
 * `coordinateSpace` is the size `point` is measured in, normally the media's;
 * the map is stretched over it the way the renderer draws it. Without it the
 * point is in map pixels. Returns null outside the map.
 */
export function readDepthAt(
  map: DepthMap,
  point: Point,
  coordinateSpace?: { readonly width: number; readonly height: number },
): DepthReadout | null {
  const scaleX = coordinateSpace ? map.width / coordinateSpace.width : 1;
  const scaleY = coordinateSpace ? map.height / coordinateSpace.height : 1;
  const x = Math.floor(point.x * scaleX);
  const y = Math.floor(point.y * scaleY);

  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 0 ||
    y < 0 ||
    x >= map.width ||
    y >= map.height
  ) {
    return null;
  }

  const index = y * map.width + x;
  const { samples } = map;
  const stored = samples.values[index];
  const value = decodeDepthSample(stored, samples);
  const step =
    samples.encoding === "scaled16"
      ? 1 / samples.scale
      : (samples.range.max - samples.range.min) / (254 - samples.reservedMax);
  const confidence = map.confidence?.[index];
  const readout: DepthReadout = {
    precision: samples.encoding === "scaled16" ? "exact" : "preview",
    step,
    stored,
    valid: value !== null,
    x,
    y,
    ...(confidence === undefined ? {} : { confidence: confidence / 255 }),
  };

  if (value === null) {
    return readout;
  }

  const camera = map.camera;
  const focalBaseline = camera ? camera.fxPx * camera.baselineM : undefined;
  const doffs = camera?.doffsPx ?? 0;

  switch (map.kind) {
    case DepthMapKind.DisparityPx: {
      const shifted = value + doffs;

      return {
        ...readout,
        disparityPx: value,
        ...(focalBaseline !== undefined && shifted > 0
          ? { depthM: focalBaseline / shifted }
          : {}),
      };
    }
    case DepthMapKind.DepthM:
      return {
        ...readout,
        depthM: value,
        ...(focalBaseline !== undefined
          ? { disparityPx: focalBaseline / value - doffs }
          : {}),
      };
    default:
      return { ...readout, relativeInverse: value };
  }
}
