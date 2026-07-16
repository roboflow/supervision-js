/**
 * Skia-coupled entry point (`supervision-js-react-native/skia`).
 *
 * Everything that touches `@shopify/react-native-skia` lives behind this
 * subpath so the base entry stays dependency-light — the same posture the
 * web package takes with Pixi, adapted to RN's optional-peer convention
 * (mirrors how `react-native-nitro-modules` is wired).
 */

import {
  AlphaType,
  ColorType,
  PaintStyle,
  Skia,
  type SkImage,
  type SkPicture,
} from "@shopify/react-native-skia";

import {
  createReactNativeLiveIdMaskArtifactAuto,
  resolveReactNativeLiveIdMaskUniforms,
  type ReactNativeIdMaskUniforms,
  type ReactNativeLiveIdMaskArtifactAutoOptions,
  type KeypointDrawInstruction,
  type PolygonDrawInstruction,
  type PolylineDrawInstruction,
  type TopLeftRect,
} from "./index";

export interface ReactNativeSkiaVectorFrameOptions {
  /** Height of the source media coordinate space. */
  readonly frameHeight: number;
  /** Width of the source media coordinate space. */
  readonly frameWidth: number;
  readonly keypoints?: readonly KeypointDrawInstruction[];
  /** Canvas-space rect the media is drawn into. */
  readonly mediaRect: TopLeftRect;
  readonly polygons?: readonly PolygonDrawInstruction[];
  readonly polylines?: readonly PolylineDrawInstruction[];
}

/**
 * One immutable Skia picture containing all vector geometry for a frame.
 * The caller owns `picture` and must dispose it after it leaves the screen.
 */
export interface ReactNativeSkiaVectorFrame {
  readonly edgeCount: number;
  readonly keypointCount: number;
  readonly markerCount: number;
  readonly picture: SkPicture;
  readonly polygonCount: number;
  readonly polylineCount: number;
  readonly prepMs: number;
}

/** Releases a recorded Skia vector picture. Null-safe and worklet-safe. */
export function disposeReactNativeSkiaPicture(
  picture: SkPicture | null | undefined,
) {
  "worklet";

  if (picture && typeof picture.dispose === "function") {
    picture.dispose();
  }
}

/**
 * Records polygon, polyline, and keypoint instructions into one presentable
 * Skia picture. Source points are mapped into `mediaRect`; marker radii and
 * stroke widths stay in canvas pixels, matching the web renderer contract.
 *
 * The function is intentionally synchronous and worklet-safe so a camera
 * producer can build and atomically swap the picture beside its source frame.
 */
export function createReactNativeSkiaVectorFrame(
  options: ReactNativeSkiaVectorFrameOptions,
): ReactNativeSkiaVectorFrame | null {
  "worklet";

  const polygons = options.polygons ?? [];
  const polylines = options.polylines ?? [];
  const keypoints = options.keypoints ?? [];

  if (
    options.frameWidth <= 0 ||
    options.frameHeight <= 0 ||
    options.mediaRect.width <= 0 ||
    options.mediaRect.height <= 0 ||
    (polygons.length === 0 && polylines.length === 0 && keypoints.length === 0)
  ) {
    return null;
  }

  const startedAt = Date.now();
  const recorder = Skia.PictureRecorder();
  const canvas = recorder.beginRecording(
    Skia.XYWHRect(
      0,
      0,
      options.mediaRect.x + options.mediaRect.width,
      options.mediaRect.y + options.mediaRect.height,
    ),
  );
  const scaleX = options.mediaRect.width / options.frameWidth;
  const scaleY = options.mediaRect.height / options.frameHeight;
  const mapPoint = (point: { readonly x: number; readonly y: number }) => ({
    x: options.mediaRect.x + point.x * scaleX,
    y: options.mediaRect.y + point.y * scaleY,
  });
  let edgeCount = 0;
  let markerCount = 0;

  const drawPath = (
    points: readonly { readonly x: number; readonly y: number }[],
    closed: boolean,
    fill: { readonly alpha: number; readonly color: number } | undefined,
    stroke:
      | {
          readonly alpha: number;
          readonly color: number;
          readonly dash?: readonly number[];
          readonly width: number;
        }
      | undefined,
  ) => {
    "worklet";

    if (points.length < (closed ? 3 : 2)) {
      return;
    }

    const path = Skia.Path.Make();
    const first = mapPoint(points[0]!);
    path.moveTo(first.x, first.y);

    for (let index = 1; index < points.length; index += 1) {
      const point = mapPoint(points[index]!);
      path.lineTo(point.x, point.y);
    }

    if (closed) {
      path.close();
    }

    if (fill) {
      const paint = Skia.Paint();
      paint.setAntiAlias(true);
      paint.setColor(Skia.Color(fill.color));
      paint.setAlphaf(fill.alpha);
      paint.setStyle(PaintStyle.Fill);
      canvas.drawPath(path, paint);
      paint.dispose();
    }

    if (stroke && stroke.width > 0) {
      const paint = Skia.Paint();
      paint.setAntiAlias(true);
      paint.setColor(Skia.Color(stroke.color));
      paint.setAlphaf(stroke.alpha);
      paint.setStrokeWidth(stroke.width);
      paint.setStyle(PaintStyle.Stroke);

      const dash = stroke.dash?.filter((interval) => interval > 0);
      const dashIntervals =
        dash && dash.length % 2 === 1 ? [...dash, ...dash] : dash;
      const pathEffect =
        dashIntervals && dashIntervals.length >= 2
          ? Skia.PathEffect.MakeDash([...dashIntervals], 0)
          : null;

      if (pathEffect) {
        paint.setPathEffect(pathEffect);
      }

      canvas.drawPath(path, paint);
      paint.dispose();
      pathEffect?.dispose();
    }

    path.dispose();
  };

  const drawLine = (
    from: { readonly x: number; readonly y: number },
    to: { readonly x: number; readonly y: number },
    stroke: {
      readonly alpha: number;
      readonly color: number;
      readonly width: number;
    },
  ) => {
    "worklet";

    if (stroke.width <= 0) {
      return;
    }

    const mappedFrom = mapPoint(from);
    const mappedTo = mapPoint(to);
    const paint = Skia.Paint();
    paint.setAntiAlias(true);
    paint.setColor(Skia.Color(stroke.color));
    paint.setAlphaf(stroke.alpha);
    paint.setStrokeWidth(stroke.width);
    paint.setStyle(PaintStyle.Stroke);
    canvas.drawLine(mappedFrom.x, mappedFrom.y, mappedTo.x, mappedTo.y, paint);
    paint.dispose();
  };

  for (const polygon of polygons) {
    drawPath(polygon.points, true, polygon.fill, polygon.stroke);
  }

  for (const polyline of polylines) {
    drawPath(polyline.points, false, undefined, polyline.stroke);
  }

  for (const keypoint of keypoints) {
    for (const edge of keypoint.edges) {
      if (edge.shadowStroke) {
        drawLine(edge.from, edge.to, edge.shadowStroke);
      }
      drawLine(edge.from, edge.to, edge.stroke);
      edgeCount += 1;
    }

    for (const marker of keypoint.markers) {
      const point = mapPoint(marker.point);

      if (marker.shape === "cross") {
        const stroke = marker.stroke ?? {
          alpha: 1,
          color: 0xffffff,
          width: 2,
        };
        const paint = Skia.Paint();
        paint.setAntiAlias(true);
        paint.setColor(Skia.Color(stroke.color));
        paint.setAlphaf(stroke.alpha);
        paint.setStrokeWidth(stroke.width);
        paint.setStyle(PaintStyle.Stroke);
        canvas.drawLine(
          point.x - marker.radius,
          point.y - marker.radius,
          point.x + marker.radius,
          point.y + marker.radius,
          paint,
        );
        canvas.drawLine(
          point.x + marker.radius,
          point.y - marker.radius,
          point.x - marker.radius,
          point.y + marker.radius,
          paint,
        );
        paint.dispose();
      } else {
        if (marker.fill) {
          const paint = Skia.Paint();
          paint.setAntiAlias(true);
          paint.setColor(Skia.Color(marker.fill.color));
          paint.setAlphaf(marker.fill.alpha);
          paint.setStyle(PaintStyle.Fill);
          canvas.drawCircle(point.x, point.y, marker.radius, paint);
          paint.dispose();
        }

        if (marker.stroke) {
          const paint = Skia.Paint();
          paint.setAntiAlias(true);
          paint.setColor(Skia.Color(marker.stroke.color));
          paint.setAlphaf(marker.stroke.alpha);
          paint.setStrokeWidth(marker.stroke.width);
          paint.setStyle(PaintStyle.Stroke);
          canvas.drawCircle(point.x, point.y, marker.radius, paint);
          paint.dispose();
        }
      }

      markerCount += 1;
    }
  }

  const picture = recorder.finishRecordingAsPicture();
  recorder.dispose();

  return {
    edgeCount,
    keypointCount: keypoints.length,
    markerCount,
    picture,
    polygonCount: polygons.length,
    polylineCount: polylines.length,
    prepMs: Date.now() - startedAt,
  };
}

export interface ReactNativeSkiaMaskFrameOptions extends ReactNativeLiveIdMaskArtifactAutoOptions {
  readonly edgeSmoothing?: number;
  /** Canvas-space rect the media is drawn into. */
  readonly mediaRect: TopLeftRect;
  /** Cell size (canvas px) of the censor mosaic for `mosaicMaskIds`. */
  readonly mosaicCellPx?: number;
  /** Mask ids (detection index + 1) rendered as an opaque censor mosaic. */
  readonly mosaicMaskIds?: readonly number[];
  /** Mask ids spotlit through the dark veil. */
  readonly spotlightMaskIds?: readonly number[];
}

/**
 * One presentable mask packet: the Alpha_8 ID-mask uploaded as a Skia image
 * plus the shader uniforms that draw it, with builder diagnostics.
 *
 * Ownership: the caller owns `image` and must release it with
 * `disposeReactNativeSkiaImage()` once the packet leaves the screen.
 */
export interface ReactNativeSkiaMaskFrame {
  readonly builder: "native" | "js";
  readonly byteLength: number;
  readonly fallbackReason?: string;
  readonly fillMs: number;
  readonly height: number;
  readonly image: SkImage;
  readonly uniforms: ReactNativeIdMaskUniforms;
  readonly uploadMs: number;
  readonly width: number;
}

/** Releases a Skia image if it is present and disposable. Null-safe. */
export function disposeReactNativeSkiaImage(image: SkImage | null | undefined) {
  "worklet";

  if (image && typeof image.dispose === "function") {
    image.dispose();
  }
}

/**
 * Builds one live ID-mask packet end to end: artifact (native builder with
 * JS fallback) → Alpha_8 Skia image upload → shader uniforms.
 *
 * Returns `null` when there is nothing to draw. Throws worklet-safe plain
 * `{ message, name }` errors prefixed with the failing stage so callers can
 * log exactly where a frame died.
 */
export function createReactNativeSkiaMaskFrame(
  options: ReactNativeSkiaMaskFrameOptions,
): ReactNativeSkiaMaskFrame | null {
  "worklet";

  let stage = "mask-init";

  try {
    stage = "mask-build-artifact";
    const build = createReactNativeLiveIdMaskArtifactAuto(options);

    if (!build) {
      return null;
    }

    const { artifact, diagnostics } = build;
    const uploadStartedAt = Date.now();

    stage = "mask-create-skia-data";
    if (!Skia.Data || typeof Skia.Data.fromBytes !== "function") {
      throw {
        message: "Skia.Data.fromBytes is unavailable in this worklet runtime",
        name: "TypeError",
      };
    }

    const imageData = Skia.Data.fromBytes(artifact.data);

    stage = "mask-create-skia-image";
    if (!Skia.Image || typeof Skia.Image.MakeImage !== "function") {
      throw {
        message: "Skia.Image.MakeImage is unavailable in this worklet runtime",
        name: "TypeError",
      };
    }

    const image = Skia.Image.MakeImage(
      {
        alphaType: AlphaType.Opaque,
        colorType: ColorType.Alpha_8,
        height: artifact.height,
        width: artifact.width,
      },
      imageData,
      artifact.width,
    );

    if (!image) {
      return null;
    }

    const uploadMs = Date.now() - uploadStartedAt;

    stage = "mask-resolve-uniforms";
    const uniforms = resolveReactNativeLiveIdMaskUniforms({
      artifact,
      edgeSmoothing: options.edgeSmoothing,
      mediaRect: options.mediaRect,
      mosaicCellPx: options.mosaicCellPx,
      mosaicMaskIds: options.mosaicMaskIds,
      spotlightMaskIds: options.spotlightMaskIds,
    });

    return {
      builder: diagnostics.builder,
      byteLength: artifact.data.byteLength,
      fallbackReason: diagnostics.fallbackReason,
      fillMs: diagnostics.fillMs,
      height: artifact.height,
      image,
      uniforms,
      uploadMs,
      width: artifact.width,
    };
  } catch (error) {
    let message = "unknown error";
    let name = "Error";

    if (typeof error === "string") {
      message = error;
    } else if (typeof error === "object" && error !== null) {
      const record = error as {
        readonly message?: unknown;
        readonly name?: unknown;
      };

      if (typeof record.message === "string") {
        message = record.message;
      }

      if (typeof record.name === "string") {
        name = record.name;
      }
    }

    throw {
      message: `${stage}: ${message}`,
      name,
    };
  }
}
