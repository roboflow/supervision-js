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
  StrokeCap as SkiaStrokeCap,
  StrokeJoin as SkiaStrokeJoin,
  type SkImage,
  type SkPicture,
} from "@shopify/react-native-skia";

import type { BoxStrokeStyle } from "supervision-js-core";

import {
  createReactNativeLiveIdMaskArtifactAuto,
  resolveReactNativeLiveIdMaskUniforms,
  type ReactNativeIdMaskUniforms,
  type ReactNativeLiveIdMaskArtifact,
  type ReactNativeLiveIdMaskArtifactAutoOptions,
  type ReactNativeLiveIdMaskBuildDiagnostics,
  type ReactNativeLiveIdMaskBuildResult,
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

/** Structural subset shared by Reanimated and worklet runtime values. */
export interface ReactNativeSkiaSharedValue<TValue> {
  value: TValue;
}

/** Creates the transparent sentinel required by animated Skia image props. */
export function createEmptyReactNativeSkiaMaskImage(): SkImage {
  "worklet";

  const image = Skia.Image.MakeImage(
    {
      alphaType: AlphaType.Opaque,
      colorType: ColorType.Alpha_8,
      height: 1,
      width: 1,
    },
    Skia.Data.fromBytes(new Uint8Array([0])),
    1,
  );

  if (!image) {
    throw new Error("Unable to create the empty React Native Skia mask image.");
  }

  return image;
}

/**
 * Promotes an image while keeping its predecessor alive for one presentation.
 * React Native Skia may still draw the prior image on the UI thread; disposing
 * it immediately can paint the complete media rect black.
 */
export function swapReactNativeSkiaMaskImage(
  active: ReactNativeSkiaSharedValue<SkImage>,
  activeIsEmpty: ReactNativeSkiaSharedValue<boolean>,
  retired: ReactNativeSkiaSharedValue<SkImage | null>,
  next: SkImage | null,
  empty: SkImage,
) {
  "worklet";

  const previous = active.value;
  const obsolete = retired.value;

  active.value = next ?? empty;
  retired.value = activeIsEmpty.value ? null : previous;
  activeIsEmpty.value = next === null;
  // Keep disposal inline: imported helper references are not reliably captured
  // when this function is serialized onto the UI worklet runtime.
  if (obsolete && typeof obsolete.dispose === "function") {
    obsolete.dispose();
  }
}

/** Same one-presentation retirement rule for recorded vector pictures. */
export function swapReactNativeSkiaPicture(
  active: ReactNativeSkiaSharedValue<SkPicture>,
  activeIsEmpty: ReactNativeSkiaSharedValue<boolean>,
  retired: ReactNativeSkiaSharedValue<SkPicture | null>,
  next: SkPicture | null,
  empty: SkPicture,
) {
  "worklet";

  const previous = active.value;
  const obsolete = retired.value;

  active.value = next ?? empty;
  retired.value = activeIsEmpty.value ? null : previous;
  activeIsEmpty.value = next === null;
  // Keep disposal inline for the same UI-worklet serialization boundary.
  if (obsolete && typeof obsolete.dispose === "function") {
    obsolete.dispose();
  }
}

/**
 * Creates a valid no-op picture for declarative Skia picture props.
 *
 * React Native Skia's picture prop does not accept `null`, including when the
 * prop is animated through a Reanimated shared value. Keep this picture in the
 * shared value whenever there is no vector geometry to present.
 */
export function createEmptyReactNativeSkiaPicture(): SkPicture {
  "worklet";

  const recorder = Skia.PictureRecorder();
  recorder.beginRecording(Skia.XYWHRect(0, 0, 1, 1));
  const picture = recorder.finishRecordingAsPicture();
  recorder.dispose();
  return picture;
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

  const configureStrokePaint = (
    paint: ReturnType<typeof Skia.Paint>,
    stroke: BoxStrokeStyle,
  ) => {
    "worklet";

    paint.setAntiAlias(true);
    paint.setColor(Skia.Color(stroke.color));
    paint.setAlphaf(stroke.alpha);
    paint.setStrokeWidth(stroke.width);
    paint.setStyle(PaintStyle.Stroke);

    if (stroke.cap === "round") {
      paint.setStrokeCap(SkiaStrokeCap.Round);
    } else if (stroke.cap === "square") {
      paint.setStrokeCap(SkiaStrokeCap.Square);
    } else if (stroke.cap === "butt") {
      paint.setStrokeCap(SkiaStrokeCap.Butt);
    }

    if (stroke.join === "round") {
      paint.setStrokeJoin(SkiaStrokeJoin.Round);
    } else if (stroke.join === "bevel") {
      paint.setStrokeJoin(SkiaStrokeJoin.Bevel);
    } else if (stroke.join === "miter") {
      paint.setStrokeJoin(SkiaStrokeJoin.Miter);
    }

    if (stroke.miterLimit !== undefined) {
      paint.setStrokeMiter(stroke.miterLimit);
    }

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

    return pathEffect;
  };

  const drawPath = (
    points: readonly { readonly x: number; readonly y: number }[],
    closed: boolean,
    fill: { readonly alpha: number; readonly color: number } | undefined,
    stroke: BoxStrokeStyle | undefined,
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
      const pathEffect = configureStrokePaint(paint, stroke);

      canvas.drawPath(path, paint);
      paint.dispose();
      pathEffect?.dispose();
    }

    path.dispose();
  };

  const drawLine = (
    from: { readonly x: number; readonly y: number },
    to: { readonly x: number; readonly y: number },
    stroke: BoxStrokeStyle,
  ) => {
    "worklet";

    if (stroke.width <= 0) {
      return;
    }

    const mappedFrom = mapPoint(from);
    const mappedTo = mapPoint(to);
    const paint = Skia.Paint();
    const pathEffect = configureStrokePaint(paint, stroke);
    canvas.drawLine(mappedFrom.x, mappedFrom.y, mappedTo.x, mappedTo.y, paint);
    paint.dispose();
    pathEffect?.dispose();
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
        const pathEffect = configureStrokePaint(paint, stroke);
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
        pathEffect?.dispose();
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
          const pathEffect = configureStrokePaint(paint, marker.stroke);
          canvas.drawCircle(point.x, point.y, marker.radius, paint);
          paint.dispose();
          pathEffect?.dispose();
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
 * Inputs that turn a built artifact into a presentable packet.
 *
 * Deliberately disjoint from the artifact's own inputs: nothing here is baked
 * into the mask bytes, which is what makes an artifact reusable across frames
 * whose media rect or effect selection has moved on.
 */
export interface ReactNativeSkiaMaskFrameFromArtifactOptions {
  readonly artifact: ReactNativeLiveIdMaskArtifact;
  readonly diagnostics: ReactNativeLiveIdMaskBuildDiagnostics;
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
 * Normalizes a thrown value into the worklet-safe `{ message, name }` shape,
 * prefixed with the stage that failed. Worklet runtimes do not reliably carry
 * `Error` instances across the boundary, so this never rethrows the original.
 */
function resolveMaskFrameError(stage: string, error: unknown) {
  "worklet";

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

  return {
    message: `${stage}: ${message}`,
    name,
  };
}

/**
 * Runs only the fill: detections in, raw ID-mask bytes out.
 *
 * Split out from `createReactNativeSkiaMaskFrame()` because this is the whole
 * cost — ~15 ms per frame with the JS builder on a Pixel 10 Pro against ~0 ms
 * for the upload — and it depends on nothing that changes between two frames
 * sharing the same detections. A caller presenting held detections can build
 * once and pass the result to `createReactNativeSkiaMaskFrameFromArtifact()`
 * for each frame.
 *
 * Returns `null` when there is nothing to draw. Throws worklet-safe plain
 * `{ message, name }` errors prefixed with the failing stage.
 */
export function buildReactNativeSkiaMaskArtifact(
  options: ReactNativeLiveIdMaskArtifactAutoOptions,
): ReactNativeLiveIdMaskBuildResult | null {
  "worklet";

  try {
    return createReactNativeLiveIdMaskArtifactAuto(options) ?? null;
  } catch (error) {
    throw resolveMaskFrameError("mask-build-artifact", error);
  }
}

/**
 * Uploads a built artifact as an Alpha_8 Skia image and resolves its shader
 * uniforms.
 *
 * Each call mints its own `SkImage`, so reusing one artifact across frames
 * still gives every packet an image it solely owns — `PreparedFrameStore` can
 * retire and dispose packets exactly as before, with no shared-handle
 * refcounting to get wrong.
 *
 * Pass `diagnostics.fillMs` as 0 when reusing an artifact; reporting the
 * original fill would tell the readout work happened on this frame that did
 * not.
 */
export function createReactNativeSkiaMaskFrameFromArtifact(
  options: ReactNativeSkiaMaskFrameFromArtifactOptions,
): ReactNativeSkiaMaskFrame | null {
  "worklet";

  let stage = "mask-init";

  try {
    const artifact = options.artifact;
    const diagnostics = options.diagnostics;
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
    throw resolveMaskFrameError(stage, error);
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

  const build = buildReactNativeSkiaMaskArtifact(options);

  if (!build) {
    return null;
  }

  return createReactNativeSkiaMaskFrameFromArtifact({
    artifact: build.artifact,
    diagnostics: build.diagnostics,
    edgeSmoothing: options.edgeSmoothing,
    mediaRect: options.mediaRect,
    mosaicCellPx: options.mosaicCellPx,
    mosaicMaskIds: options.mosaicMaskIds,
    spotlightMaskIds: options.spotlightMaskIds,
  });
}
