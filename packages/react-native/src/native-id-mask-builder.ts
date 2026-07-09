import {
  MAX_ID_MASK_PALETTE_ENTRIES,
  MAX_ID_MASK_STROKE_WIDTH,
} from "supervision-js-core";

import type {
  IdMaskBuildArtifact,
  IdMaskBuildOptions,
  IdMaskBuilder,
  IdMaskDetection,
} from "./specs/IdMaskBuilder.nitro";
import type {
  ReactNativeLiveIdMaskArtifact,
  ReactNativeLiveIdMaskArtifactOptions,
} from "./index";
import { REACT_NATIVE_LIVE_ID_MASK_DEFAULTS } from "./live-defaults";

export const REACT_NATIVE_LIVE_ID_MASK_NATIVE_BUILDER_NAME = "IdMaskBuilder";

type NitroModulesModule = typeof import("react-native-nitro-modules");

/**
 * Minimal structural view of the Nitro `IdMaskBuilder` hybrid object.
 *
 * Keeping this local means package consumers and tests never need
 * `react-native-nitro-modules` types; the real hybrid object satisfies it.
 */
export interface ReactNativeLiveIdMaskNativeBuilder {
  createArtifact(options: IdMaskBuildOptions): IdMaskBuildArtifact;
}

/**
 * Boxed native builder that can cross into worklet runtimes. Mirrors Nitro's
 * `BoxedHybridObject<T>` shape without importing its types.
 */
export interface ReactNativeLiveIdMaskBoxedNativeBuilder {
  unbox(): ReactNativeLiveIdMaskNativeBuilder;
}

/**
 * Result of trying to load the native builder on the React/JS thread.
 *
 * `boxed` is `null` when the native module is unavailable (Android, Expo Go,
 * missing pod install, plain Node). `fallbackReason` explains why so the demo
 * HUD can surface it.
 */
export interface ReactNativeLiveIdMaskNativeBuilderHandle {
  readonly boxed: ReactNativeLiveIdMaskBoxedNativeBuilder | null;
  readonly fallbackReason?: string;
}

let cachedNativeBuilderHandle:
  ReactNativeLiveIdMaskNativeBuilderHandle | undefined;

/**
 * Loads and boxes the native Nitro ID-mask builder.
 *
 * Must run on the normal React/JS thread (module lookup cannot happen inside
 * a worklet). The returned handle is safe to capture inside worklets; pass it
 * to `createReactNativeLiveIdMaskArtifactAuto()` via `options.nativeBuilder`.
 */
export function loadReactNativeLiveIdMaskNativeBuilder(): ReactNativeLiveIdMaskNativeBuilderHandle {
  cachedNativeBuilderHandle ??= resolveNativeBuilderHandle();

  return cachedNativeBuilderHandle;
}

export function isReactNativeLiveIdMaskNativeBuilderAvailable(
  handle: ReactNativeLiveIdMaskNativeBuilderHandle,
): boolean {
  "worklet";

  return handle.boxed !== null;
}

// Defined before its captor: the worklets Babel plugin turns worklet function
// declarations into non-hoisted assignments, and module-level worklets capture
// each other by value at module-init time.
function resolveMaskArrayBuffer(mask: Uint8Array): ArrayBuffer {
  "worklet";

  if (
    mask.byteOffset === 0 &&
    mask.buffer instanceof ArrayBuffer &&
    mask.byteLength === mask.buffer.byteLength
  ) {
    return mask.buffer;
  }

  const copy = new Uint8Array(mask.byteLength);

  copy.set(mask);

  return copy.buffer;
}

/**
 * Runs the native fill loop for one live ID-mask artifact.
 *
 * Matches `createReactNativeLiveIdMaskArtifact()` semantics exactly: same
 * artifact size, detection ordering, palette layout, limits, and
 * empty/invalid-mask behavior. Throws when the native builder is unavailable
 * or the native call fails; callers own the JS fallback.
 */
export function createReactNativeLiveIdMaskArtifactWithNativeBuilder(
  handle: ReactNativeLiveIdMaskNativeBuilderHandle,
  options: ReactNativeLiveIdMaskArtifactOptions,
): ReactNativeLiveIdMaskArtifact | undefined {
  "worklet";

  if (!handle.boxed) {
    throw new Error("native-id-mask-builder-unavailable");
  }

  const detectionLimit = MAX_ID_MASK_PALETTE_ENTRIES - 1;
  const detectionCount = Math.min(options.detections.length, detectionLimit);

  if (detectionCount <= 0) {
    return undefined;
  }

  const builder = handle.boxed.unbox();
  const detections: IdMaskDetection[] = [];

  for (let index = 0; index < detectionCount; index += 1) {
    const detection = options.detections[index]!;

    detections[index] = {
      bbox: {
        x1: detection.bbox.x1,
        y1: detection.bbox.y1,
        x2: detection.bbox.x2,
        y2: detection.bbox.y2,
      },
      className: detection.label,
      color: detection.color,
      confidence: detection.score,
      mask: resolveMaskArrayBuffer(detection.mask),
      maskHeight: detection.maskHeight,
      maskRotatedCw: detection.maskRotatedCw === true,
      maskWidth: detection.maskWidth,
    };
  }

  const result = builder.createArtifact({
    borderWidth: options.borderWidth ?? 0,
    detections,
    fillOpacity: options.fillOpacity ?? 1,
    frameHeight: options.frameHeight,
    frameWidth: options.frameWidth,
    maxPaletteEntries: MAX_ID_MASK_PALETTE_ENTRIES,
    maxPixels:
      options.maxPixels ?? REACT_NATIVE_LIVE_ID_MASK_DEFAULTS.maxPixels,
    maxSide: options.maxSide ?? REACT_NATIVE_LIVE_ID_MASK_DEFAULTS.maxSide,
    maxStrokeWidth: MAX_ID_MASK_STROKE_WIDTH,
  });

  if (result.maskCount <= 0) {
    return undefined;
  }

  return {
    data: new Uint8Array(result.data),
    edgeFeatherTexels: result.edgeFeatherTexels,
    fillPalette: new Float32Array(result.fillPalette),
    hasStroke: result.hasStroke,
    height: result.height,
    maskCount: result.maskCount,
    maxStrokeWidth: result.maxStrokeWidth,
    nativeFillMs: result.fillMs,
    opacity: result.opacity,
    scale: result.scale,
    strokePalette: new Float32Array(result.strokePalette),
    strokeWidths: new Float32Array(result.strokeWidths),
    width: result.width,
  };
}

function resolveNativeBuilderHandle(): ReactNativeLiveIdMaskNativeBuilderHandle {
  if (typeof require !== "function") {
    return {
      boxed: null,
      fallbackReason: "nitro-runtime-require-unavailable",
    };
  }

  try {
    // Lazy require keeps react-native-nitro-modules an optional peer: Metro
    // resolves it inline on device, while Node/Vitest fall through to the
    // catch below and report the JS fallback reason instead of crashing.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nitro = require("react-native-nitro-modules") as NitroModulesModule;
    const builder = nitro.NitroModules.createHybridObject<IdMaskBuilder>(
      REACT_NATIVE_LIVE_ID_MASK_NATIVE_BUILDER_NAME,
    );

    return { boxed: nitro.NitroModules.box(builder) };
  } catch (error) {
    return {
      boxed: null,
      fallbackReason: resolveLoadErrorMessage(error),
    };
  }
}

function resolveLoadErrorMessage(error: unknown) {
  if (typeof error === "string") {
    return error;
  }

  if (typeof error === "object" && error !== null) {
    const record = error as { readonly message?: unknown };

    if (typeof record.message === "string") {
      return record.message;
    }
  }

  return "native-id-mask-builder-load-error";
}
