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
  Skia,
  type SkImage,
} from "@shopify/react-native-skia";

import {
  createReactNativeLiveIdMaskArtifactAuto,
  resolveReactNativeLiveIdMaskUniforms,
  type ReactNativeIdMaskUniforms,
  type ReactNativeLiveIdMaskArtifactAutoOptions,
  type TopLeftRect,
} from "./index";

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
