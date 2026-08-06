/**
 * Session entry point (`supervision-js-react-native/sessions`).
 *
 * The React Native analog of the web package's `createMediaSession()`: one
 * factory owns the decode pump, inference dispatch, mask preparation, the
 * strict-sync packet lifecycle (present → retire → dispose), and teardown.
 * Consumers provide inference as an injected worklet — the library renders
 * detections; it does not run models (see docs/public/guides/public-api.md).
 *
 * Vendor runtimes (reanimated, worklets, vision-camera worklet threads,
 * Nitro) load lazily at factory time on the JS thread, the same optional-peer
 * posture as the native ID-mask builder; only Skia is a static import, which
 * keeps this subpath device-only like `./skia`.
 */

import { Skia, type SkImage } from "@shopify/react-native-skia";

import {
  createEmptyReactNativeLiveIdMaskUniforms,
  type ReactNativeIdMaskUniforms,
  type ReactNativeLiveIdMaskNativeBuilderHandle,
  type ReactNativeLiveSerializedDetection,
  type TopLeftRect,
} from "./index";
import {
  createReactNativeSkiaMaskFrame,
  disposeReactNativeSkiaImage,
  type ReactNativeSkiaMaskFrame,
} from "./skia";
import { PreparedFrameStore } from "./renderers/prepared-frame-store";
import { REACT_NATIVE_FILE_SESSION_DEFAULTS } from "./sessions/media-session-defaults";
import {
  type ReactNativeBoxedVideoFrameSource,
  type ReactNativeVideoFrameHandle,
} from "./video-frame-source";
import { createReactNativeVideoFileSource } from "./adapters/video-file";

export { createMediaSession } from "./sessions/media-session-core";
export {
  MediaSessionError,
  type MediaSession,
  type MediaSessionErrorCode,
  type MediaSessionErrorStage,
  type MediaSessionErrorState,
  type MediaSessionMediaState,
  type MediaSessionOptions,
  type MediaSessionState,
  type MediaSessionStateListener,
  type MediaSessionStateUnsubscribe,
} from "./types/media-session";
export type {
  MediaFrameProcessor,
  MediaFrameProcessorResult,
} from "./types/frame-processor";
export type {
  MediaFrameSource,
  MediaFrameSourceConsumer,
  MediaSessionCapabilities,
} from "./types/frame-source";
export type {
  MediaRendererAdapter,
  MediaRendererPrepareOptions,
  MediaSessionRendererState,
  MediaSessionRenderPreparationState,
  PreparedMediaFramePacket,
} from "./types/renderer";

/**
 * Minimal structural view of a reanimated shared value. UI components read
 * these; the session's pump thread writes them. Reanimated's own
 * `SharedValue<T>` satisfies it.
 */
export interface ReactNativeSharedValue<TValue> {
  value: TValue;
}

/** Opaque worklet runtime handle produced by `createReactNativeWorkletRuntime`. */
export type ReactNativeWorkletRuntimeHandle = object;

/** @deprecated Prefer `REACT_NATIVE_FILE_SESSION_DEFAULTS`. */
export const REACT_NATIVE_VIDEO_SESSION_DEFAULTS =
  REACT_NATIVE_FILE_SESSION_DEFAULTS;

/** Slim per-frame detection summary delivered to the JS thread. */
export interface ReactNativeVideoSessionDetection {
  readonly bbox: {
    readonly x1: number;
    readonly x2: number;
    readonly y1: number;
    readonly y2: number;
  };
  readonly color: number;
  readonly label: string;
  readonly score: number;
}

export interface ReactNativeVideoSessionStats {
  readonly builder: string;
  readonly detectionCount: number;
  readonly durationMs: number;
  readonly fillMs: number;
  readonly processedFrames: number;
  readonly segmentationMs: number;
  readonly tickMs: number;
  readonly videoTimeMs: number;
  readonly wallMs: number;
}

export interface ReactNativeVideoSessionEndEvent {
  /** Set when playback halted on an error; absent for pause/stop/end. */
  readonly error?: string;
  /** True when the pump exited for a pause; `resume()` continues. */
  readonly paused: boolean;
}

export interface ReactNativeVideoSessionMaskEffects {
  readonly mosaicMaskIds: readonly number[];
  readonly spotlightMaskIds: readonly number[];
}

export type ReactNativeClassMaskEffect = "redact" | "spotlight";
export type ReactNativeClassMaskEffects = Readonly<
  Record<string, ReactNativeClassMaskEffect>
>;

/**
 * Creates the package-owned worklet that maps host-selected class effects to
 * the mask IDs for one presented video frame.
 */
export function createReactNativeClassMaskEffectsResolver(
  classEffects: ReactNativeSharedValue<ReactNativeClassMaskEffects>,
): (
  detections: readonly ReactNativeLiveSerializedDetection[],
) => ReactNativeVideoSessionMaskEffects {
  return (detections) => {
    "worklet";

    const effects = classEffects.value;
    const mosaicMaskIds: number[] = [];
    const spotlightMaskIds: number[] = [];

    for (let index = 0; index < detections.length; index += 1) {
      const effect = effects[detections[index]!.label ?? ""];

      if (effect === "redact") {
        mosaicMaskIds[mosaicMaskIds.length] = index + 1;
      } else if (effect === "spotlight") {
        spotlightMaskIds[spotlightMaskIds.length] = index + 1;
      }
    }

    return { mosaicMaskIds, spotlightMaskIds };
  };
}

export interface ReactNativeVideoSessionPresentationOptions {
  readonly borderWidth?: number;
  readonly edgeSmoothing?: number;
  readonly fillOpacity?: number;
  /** Artifact bounds; default to `REACT_NATIVE_LIVE_ID_MASK_DEFAULTS`. */
  readonly maxPixels?: number;
  readonly maxSide?: number;
  readonly mosaicCellPx?: number;
  /** Memory-guard overrides; default to `REACT_NATIVE_VIDEO_SESSION_DEFAULTS`. */
  readonly fullResMaskMaxPixels?: number;
  readonly maxPresentationSide?: number;
}

export interface ReactNativeVideoSessionOptions {
  readonly fileUri: string;
  /** Canvas-space rect the video is drawn into; update via `setMediaRect`. */
  readonly mediaRect: TopLeftRect;
  readonly nativeBuilder?: ReactNativeLiveIdMaskNativeBuilderHandle | null;
  readonly presentation?: ReactNativeVideoSessionPresentationOptions;
  /** Worklet runtime the pump runs on (owned by the caller, reusable). */
  readonly runtime: ReactNativeWorkletRuntimeHandle;
  /**
   * Inference, injected as a worklet: turn one decoded frame into serialized
   * detections in the upright video's coordinate space.
   * `returnMaskAtOriginalResolution` reflects the session's memory guard.
   */
  readonly serializeFrame: (
    handle: ReactNativeVideoFrameHandle,
    returnMaskAtOriginalResolution: boolean,
  ) => ReactNativeLiveSerializedDetection[];
  /** Optional worklet mapping this tick's detections to mask effects. */
  readonly resolveMaskEffects?: (
    detections: readonly ReactNativeLiveSerializedDetection[],
  ) => ReactNativeVideoSessionMaskEffects;
  /** Presentation-synced detections, delivered on the JS thread per tick. */
  readonly onDetections?: (
    detections: readonly ReactNativeVideoSessionDetection[],
  ) => void;
  readonly onEnded?: (event: ReactNativeVideoSessionEndEvent) => void;
  /** Throttled pump diagnostics, delivered on the JS thread. */
  readonly onStats?: (stats: ReactNativeVideoSessionStats) => void;
}

export interface ReactNativeVideoSession {
  readonly durationMs: number;
  readonly frameHeight: number;
  readonly frameWidth: number;
  readonly nominalFrameRate: number;
  /** Presentation lanes for the UI: media frame, mask, and its uniforms. */
  readonly frameImage: ReactNativeSharedValue<SkImage | null>;
  readonly maskImage: ReactNativeSharedValue<SkImage | null>;
  readonly maskUniforms: ReactNativeSharedValue<ReactNativeIdMaskUniforms>;
  setMediaRect(rect: TopLeftRect): void;
  /** Halts the pump but keeps the decoder open at position. */
  pause(): void;
  resume(): void;
  /** Halts and closes the decoder; the last presented frame stays visible. */
  stop(): void;
  /** Stops, releases every packet resource, and silences callbacks. Idempotent. */
  destroy(): void;
}

/** Renderer-private saved-video packet; never part of the public session API. */
interface ReactNativeVideoPreparedFramePacket {
  readonly detections: readonly ReactNativeVideoSessionDetection[];
  readonly frameImage: SkImage;
  readonly maskImage: SkImage | null;
  readonly maskUniforms: ReactNativeIdMaskUniforms;
  readonly packetId: number;
  readonly timestampMs: number;
}

interface ReactNativeVideoPreparedFrameStoreState {
  readonly active: ReactNativeVideoPreparedFramePacket | null;
  readonly retired: ReactNativeVideoPreparedFramePacket | null;
}

interface WorkletVendorModules {
  makeMutable<TValue>(value: TValue): ReactNativeSharedValue<TValue>;
  scheduleOnRN(fn: (...args: never[]) => void, ...args: unknown[]): void;
  scheduleOnRuntime(runtime: never, worklet: () => void): void;
}

/**
 * Creates a dedicated native thread + worklet runtime for session pumps.
 * Create one per screen and reuse it across sessions; threads are not
 * reclaimed until the app exits.
 */
export function createReactNativeWorkletRuntime(
  name: string,
): ReactNativeWorkletRuntimeHandle {
  if (typeof require !== "function") {
    throw new Error("worklet runtime unavailable: require is not a function");
  }

  // Lazy requires keep these optional peers: Metro resolves them inline on
  // device, while Node/Vitest reach the throw with a diagnosable message.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nitro = require("react-native-nitro-modules") as {
    NitroModules: {
      createHybridObject(name: string): {
        createNativeThread(name: string): object;
      };
    };
  };
  const thread = nitro.NitroModules.createHybridObject(
    "NativeThreadFactory",
  ).createNativeThread(name);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cameraWorklets = require("react-native-vision-camera-worklets") as {
    createWorkletRuntimeForThread(thread: object): object;
  };

  return cameraWorklets.createWorkletRuntimeForThread(thread);
}

function resolveWorkletVendorModules(): WorkletVendorModules {
  if (typeof require !== "function") {
    throw new Error("video session unavailable: require is not a function");
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const reanimated = require("react-native-reanimated") as {
    makeMutable<TValue>(value: TValue): ReactNativeSharedValue<TValue>;
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const worklets = require("react-native-worklets") as {
    scheduleOnRN: WorkletVendorModules["scheduleOnRN"];
    scheduleOnRuntime: WorkletVendorModules["scheduleOnRuntime"];
  };

  return {
    makeMutable: reanimated.makeMutable,
    scheduleOnRN: worklets.scheduleOnRN,
    scheduleOnRuntime: worklets.scheduleOnRuntime,
  };
}

/**
 * Opens a saved video and runs it through the strict-sync pipeline: decode →
 * injected inference → ID-mask prep (native builder with JS fallback) →
 * packet swap. One pump tick produces one packet; frame and mask can never
 * mix ticks. Playback starts immediately.
 *
 * Throws with a descriptive message when the file cannot be opened or a
 * native dependency is missing (this factory is device-only).
 */
export function createReactNativeVideoSession(
  options: ReactNativeVideoSessionOptions,
): ReactNativeVideoSession {
  const vendors = resolveWorkletVendorModules();
  const source = createReactNativeVideoFileSource({ fileUri: options.fileUri });

  source.open();

  const boxedSource: ReactNativeBoxedVideoFrameSource = source.boxedSource;
  const timeline = source.timeline;
  const durationMs = (timeline.duration ?? 0) * 1000;
  const frameWidth = timeline.width;
  const frameHeight = timeline.height;
  const nominalFrameRate = timeline.frameRate ?? 0;

  const emptyUniforms = createEmptyReactNativeLiveIdMaskUniforms();
  const frameImage = vendors.makeMutable<SkImage | null>(null);
  const maskImage = vendors.makeMutable<SkImage | null>(null);
  const maskUniforms = vendors.makeMutable(emptyUniforms);
  const preparedFrameStoreState =
    vendors.makeMutable<ReactNativeVideoPreparedFrameStoreState>({
      active: null,
      retired: null,
    });
  const nextPacketId = vendors.makeMutable(0);
  const playingShared = vendors.makeMutable(false);
  const pausedShared = vendors.makeMutable(false);
  const mediaRectShared = vendors.makeMutable<TopLeftRect>({
    ...options.mediaRect,
  });

  const presentation = options.presentation ?? {};
  const fullResMaskMaxPixels =
    presentation.fullResMaskMaxPixels ??
    REACT_NATIVE_FILE_SESSION_DEFAULTS.fullResMaskMaxPixels;
  const maxPresentationSide =
    presentation.maxPresentationSide ??
    REACT_NATIVE_FILE_SESSION_DEFAULTS.maxPresentationSide;
  const statsIntervalMs = REACT_NATIVE_FILE_SESSION_DEFAULTS.statsIntervalMs;
  const nativeBuilder = options.nativeBuilder ?? null;
  const serializeFrame = options.serializeFrame;
  const resolveMaskEffects = options.resolveMaskEffects;
  const scheduleOnRN = vendors.scheduleOnRN;

  let destroyed = false;
  const createPreparedFrameStore = () => {
    "worklet";

    const store = new PreparedFrameStore<ReactNativeVideoPreparedFramePacket>(
      (packet) => {
        disposeReactNativeSkiaImage(packet.frameImage);
        disposeReactNativeSkiaImage(packet.maskImage);
      },
    );
    store.restore(preparedFrameStoreState.value);
    return store;
  };

  const reportDetections = (
    detections: readonly ReactNativeVideoSessionDetection[],
  ) => {
    if (!destroyed) {
      options.onDetections?.(detections);
    }
  };
  const reportStats = (stats: ReactNativeVideoSessionStats) => {
    if (!destroyed) {
      options.onStats?.(stats);
    }
  };
  const reportEnded = (event: ReactNativeVideoSessionEndEvent) => {
    if (!destroyed) {
      options.onEnded?.(event);
    }
  };

  const runPump = () => {
    "worklet";

    const pumpSource = boxedSource.unbox();
    const preparedFrameStore = createPreparedFrameStore();
    const startedAt = Date.now();
    const framePixels = pumpSource.frameWidth * pumpSource.frameHeight;
    const returnMasksAtOriginalResolution = framePixels <= fullResMaskMaxPixels;
    const scalePaint = Skia.Paint();
    let lastStatsAt = 0;
    let processedFrames = 0;
    let endReason = "";

    try {
      while (playingShared.value) {
        const handle = pumpSource.copyNextFrame();

        if (!handle) {
          break;
        }

        const tickStartedAt = Date.now();
        const detections = serializeFrame(
          handle,
          returnMasksAtOriginalResolution,
        );
        const segmentationMs = Date.now() - tickStartedAt;

        const overlayDetections: ReactNativeVideoSessionDetection[] = [];

        for (let index = 0; index < detections.length; index += 1) {
          const detection = detections[index]!;

          overlayDetections[index] = {
            bbox: detection.bbox,
            color: detection.color,
            label: detection.label ?? "object",
            score: detection.score ?? 0,
          };
        }

        scheduleOnRN(reportDetections, overlayDetections);

        const effects = resolveMaskEffects
          ? resolveMaskEffects(detections)
          : undefined;
        const mediaRect = mediaRectShared.value;
        let preparedMask: ReactNativeSkiaMaskFrame | null = null;

        try {
          preparedMask = createReactNativeSkiaMaskFrame({
            borderWidth: presentation.borderWidth,
            detections,
            edgeSmoothing: presentation.edgeSmoothing,
            fillOpacity: presentation.fillOpacity,
            frameHeight: handle.height,
            frameWidth: handle.width,
            maxPixels: presentation.maxPixels,
            maxSide: presentation.maxSide,
            mediaRect: {
              height: mediaRect.height,
              width: mediaRect.width,
              x: mediaRect.x,
              y: mediaRect.y,
            },
            mosaicCellPx: presentation.mosaicCellPx,
            mosaicMaskIds: effects?.mosaicMaskIds,
            nativeBuilder,
            spotlightMaskIds: effects?.spotlightMaskIds,
          });
        } catch {
          preparedMask = null;
        }

        // Skia's Metal context is thread-local: a texture image created on
        // this pump thread cannot be drawn by the render thread's context.
        // Rasterize to a context-independent CPU image, then the pixel
        // buffer can be released immediately. Large frames are downscaled
        // on the GPU first so the per-frame CPU raster stays bounded.
        const frameTimestampMs = handle.timestampMs;
        const textureImage = Skia.Image.MakeImageFromNativeBuffer(
          handle.pointer,
        );
        const presentationScale = Math.min(
          1,
          maxPresentationSide / Math.max(handle.width, handle.height),
        );
        let scaledImage: SkImage | null = null;

        if (presentationScale < 1) {
          const scaledWidth = Math.max(
            1,
            Math.round(handle.width * presentationScale),
          );
          const scaledHeight = Math.max(
            1,
            Math.round(handle.height * presentationScale),
          );
          const surface = Skia.Surface.MakeOffscreen(scaledWidth, scaledHeight);

          if (surface) {
            surface
              .getCanvas()
              .drawImageRect(
                textureImage,
                Skia.XYWHRect(0, 0, handle.width, handle.height),
                Skia.XYWHRect(0, 0, scaledWidth, scaledHeight),
                scalePaint,
              );

            const snapshot = surface.makeImageSnapshot();

            scaledImage = snapshot.makeNonTextureImage();
            disposeReactNativeSkiaImage(snapshot);
            surface.dispose();
          }
        }

        const presentedImage: SkImage | null =
          scaledImage ?? textureImage.makeNonTextureImage();

        disposeReactNativeSkiaImage(textureImage);
        handle.release();

        if (!presentedImage) {
          disposeReactNativeSkiaImage(preparedMask ? preparedMask.image : null);
          continue;
        }

        // Promote one coherent packet. The store retires the old packet for
        // one further presentation before it disposes either Skia image.
        const packet: ReactNativeVideoPreparedFramePacket = {
          detections: overlayDetections,
          frameImage: presentedImage,
          maskImage: preparedMask ? preparedMask.image : null,
          maskUniforms: preparedMask ? preparedMask.uniforms : emptyUniforms,
          packetId: nextPacketId.value,
          timestampMs: frameTimestampMs,
        };

        nextPacketId.value += 1;
        maskUniforms.value = packet.maskUniforms;
        maskImage.value = packet.maskImage;
        frameImage.value = packet.frameImage;
        try {
          preparedFrameStore.presentNow(packet);
        } finally {
          preparedFrameStoreState.value = preparedFrameStore.snapshot();
        }

        processedFrames += 1;

        if (Date.now() - lastStatsAt > statsIntervalMs) {
          lastStatsAt = Date.now();
          scheduleOnRN(reportStats, {
            builder: preparedMask?.builder ?? "-",
            detectionCount: detections.length,
            durationMs,
            fillMs: preparedMask?.fillMs ?? 0,
            processedFrames,
            segmentationMs,
            tickMs: Date.now() - tickStartedAt,
            videoTimeMs: frameTimestampMs,
            wallMs: Date.now() - startedAt,
          });
        }
      }
    } catch (error) {
      if (typeof error === "string") {
        endReason = error;
      } else if (typeof error === "object" && error !== null) {
        const record = error as { readonly message?: unknown };

        endReason =
          typeof record.message === "string"
            ? record.message
            : "video-session-pump-error";
      } else {
        endReason = "video-session-pump-error";
      }
    } finally {
      // A pause exits the loop but keeps the source open so resume can
      // continue pulling from the same position.
      const paused = pausedShared.value && endReason === "";

      if (!paused) {
        pumpSource.close();
      }

      playingShared.value = false;
      scheduleOnRN(reportEnded, {
        error: endReason === "" ? undefined : endReason,
        paused,
      });
    }
  };

  // Runs on the pump runtime so it is serialized after the pump loop exits.
  const cleanupPackets = () => {
    "worklet";

    frameImage.value = null;
    maskImage.value = null;
    maskUniforms.value = emptyUniforms;
    const preparedFrameStore = createPreparedFrameStore();

    preparedFrameStoreState.value = { active: null, retired: null };
    preparedFrameStore.disposeNow();
  };

  const schedulePump = () => {
    vendors.scheduleOnRuntime(options.runtime as never, runPump);
  };

  const haltPump = (keepSourceOpen: boolean) => {
    const wasPaused = pausedShared.value;
    const wasPlaying = playingShared.value;

    pausedShared.value = keepSourceOpen;
    playingShared.value = false;

    // While paused the pump loop is not running, so nothing will close the
    // source; do it directly.
    if (!keepSourceOpen && wasPaused) {
      source.close();
    }

    return { wasPaused, wasPlaying };
  };

  playingShared.value = true;
  schedulePump();

  return {
    durationMs,
    frameHeight,
    frameImage,
    frameWidth,
    maskImage,
    maskUniforms,
    nominalFrameRate,
    destroy() {
      if (destroyed) {
        return;
      }

      haltPump(false);
      destroyed = true;
      vendors.scheduleOnRuntime(options.runtime as never, cleanupPackets);
    },
    pause() {
      if (destroyed || !playingShared.value) {
        return;
      }

      haltPump(true);
    },
    resume() {
      if (destroyed || playingShared.value || !pausedShared.value) {
        return;
      }

      pausedShared.value = false;
      playingShared.value = true;
      schedulePump();
    },
    setMediaRect(rect: TopLeftRect) {
      mediaRectShared.value = { ...rect };
    },
    stop() {
      if (destroyed) {
        return;
      }

      const { wasPaused } = haltPump(false);

      // The pump was not running to report the end; report it here.
      if (wasPaused) {
        reportEnded({ paused: false });
      }
    },
  };
}
