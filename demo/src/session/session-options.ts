import {
  MediaInteractionMode,
  MediaNormalizationContainer,
  MediaRendererFit,
  MediaSessionMode,
  RenderPreparationMode,
  resolveMediaSessionDefaults,
  type MediaNormalizationAudioCodec,
  type MediaNormalizationFit,
  type MediaNormalizationVideoCodec,
  type MediaSessionDetectionOptions,
  type MediaSessionNormalizationOptions,
  type MediaSessionRendererOptions,
  type ResolvedMediaSessionDefaults,
} from "supervision";

/**
 * The creation-time options the workbench lets a visitor change, held as the
 * set that differs from the session the demo would otherwise build. An absent
 * entry is not "false"; it is "whatever the library or the demo picks", which
 * is what {@link DemoSessionConfiguration} then reports back for display.
 */
export interface DemoSessionOptions {
  readonly autoPlay?: boolean;
  readonly autoRefresh?: boolean;
  readonly bufferAheadSeconds?: number;
  readonly bufferBehindSeconds?: number;
  readonly detectionGateEnabled?: boolean;
  readonly detectionGateRequiredAheadSeconds?: number;
  readonly fit?: MediaRendererFit;
  readonly interactionMode?: MediaInteractionMode;
  readonly loop?: boolean;
  readonly maskMaxCacheFrameCount?: number;
  readonly maskMaxPendingFrameCount?: number;
  readonly maskPrefetchFrameCount?: number;
  readonly maskScanIntervalSeconds?: number;
  readonly maskScheduleBatchSize?: number;
  readonly maskWorkerCount?: number;
  readonly mode?: MediaSessionMode;
  readonly normalize?: boolean;
  readonly normalizeAudioBitrate?: number;
  readonly normalizeAudioCodec?: MediaNormalizationAudioCodec;
  readonly normalizeBitrate?: number;
  readonly normalizeContainer?: MediaNormalizationContainer;
  readonly normalizeDiscardAudio?: boolean;
  readonly normalizeFit?: MediaNormalizationFit;
  readonly normalizeForceTranscode?: boolean;
  readonly normalizeFrameRate?: number;
  readonly normalizeHeight?: number;
  readonly normalizeKeyFrameInterval?: number;
  readonly normalizeStream?: boolean;
  readonly normalizeVideoCodec?: MediaNormalizationVideoCodec;
  readonly normalizeWidth?: number;
  readonly playbackGate?: boolean | "unset";
  readonly preparationGateEnabled?: boolean;
  readonly preparationGateMinimumAheadSeconds?: number;
  readonly preparationGateRequiredAheadSeconds?: number;
  readonly preparationMode?: RenderPreparationMode;
  readonly refreshIntervalSeconds?: number;
}

export const emptyDemoSessionOptions: DemoSessionOptions = {};

/**
 * What the open session actually runs on: the library's own resolution of the
 * options it was handed, alongside the ones it resolves for itself. A panel
 * displaying this is displaying the session rather than a copy of it, so a
 * knob nobody touched still answers for the mode or the frame rate that
 * changed underneath it.
 */
export interface DemoSessionConfiguration {
  readonly autoPlay: boolean;
  readonly autoRefresh: boolean;
  readonly fit: MediaRendererFit;
  readonly interactionMode: MediaInteractionMode;
  readonly loop: boolean;
  readonly mode: MediaSessionMode;
  readonly normalizable: DemoNormalizationSupport;
  readonly playbackGate: boolean | undefined;
  readonly preparationMode: RenderPreparationMode;
  readonly resolved: ResolvedMediaSessionDefaults;
}

/** Whether this source can be handed to the session as a `Blob` to normalize. */
export interface DemoNormalizationSupport {
  readonly supported: boolean;
  readonly reason: string | null;
}

export const normalizationSupported: DemoNormalizationSupport = {
  reason: null,
  supported: true,
};

export function describeMissingNormalization(
  reason: string,
): DemoNormalizationSupport {
  return { reason, supported: false };
}

export function resolveDemoSessionConfiguration(options: {
  readonly detections: MediaSessionDetectionOptions;
  readonly mode: MediaSessionMode;
  readonly normalizable: DemoNormalizationSupport;
  readonly playbackGate: boolean | undefined;
  readonly renderer: MediaSessionRendererOptions;
}): DemoSessionConfiguration {
  return {
    autoPlay: options.renderer.autoPlay ?? true,
    autoRefresh: options.detections.autoRefresh ?? true,
    fit: options.renderer.fit ?? MediaRendererFit.Contain,
    interactionMode:
      options.renderer.interaction?.mode ?? MediaInteractionMode.PausedOnly,
    loop: options.renderer.loop !== false,
    mode: options.mode,
    normalizable: options.normalizable,
    playbackGate: options.playbackGate,
    preparationMode:
      options.renderer.renderPreparation?.mode ?? RenderPreparationMode.Auto,
    resolved: resolveMediaSessionDefaults({
      detections: options.detections,
      mode: options.mode,
      playbackGate: options.playbackGate,
      renderer: options.renderer,
    }),
  };
}

export function applyDemoSessionMode(
  base: MediaSessionMode,
  options: DemoSessionOptions,
): MediaSessionMode {
  return options.mode ?? base;
}

export function applyDemoSessionPlaybackGate(
  base: boolean | undefined,
  options: DemoSessionOptions,
): boolean | undefined {
  if (options.playbackGate === undefined) {
    return base;
  }

  return options.playbackGate === "unset" ? undefined : options.playbackGate;
}

export function applyDemoDetectionOptions(
  base: MediaSessionDetectionOptions,
  options: DemoSessionOptions,
): MediaSessionDetectionOptions {
  const buffer = definedOnly({
    bufferAheadSeconds: options.bufferAheadSeconds,
    bufferBehindSeconds: options.bufferBehindSeconds,
    refreshIntervalSeconds: options.refreshIntervalSeconds,
  });
  const playbackGate = definedOnly({
    enabled: options.detectionGateEnabled,
    requiredAheadSeconds: options.detectionGateRequiredAheadSeconds,
  });

  return {
    ...base,
    ...definedOnly({ autoRefresh: options.autoRefresh }),
    ...(hasEntries(buffer) ? { buffer: { ...base.buffer, ...buffer } } : {}),
    ...(hasEntries(playbackGate)
      ? { playbackGate: { ...base.playbackGate, ...playbackGate } }
      : {}),
  };
}

export function applyDemoRendererOptions(
  base: MediaSessionRendererOptions,
  options: DemoSessionOptions,
): MediaSessionRendererOptions {
  const maskFrame = definedOnly({
    maxCacheFrameCount: options.maskMaxCacheFrameCount,
    maxPendingFrameCount: options.maskMaxPendingFrameCount,
    prefetchFrameCount: options.maskPrefetchFrameCount,
    scanIntervalSeconds: options.maskScanIntervalSeconds,
    scheduleBatchSize: options.maskScheduleBatchSize,
    workerCount: options.maskWorkerCount,
  });
  const preparationGate = definedOnly({
    enabled: options.preparationGateEnabled,
    minimumAheadSeconds: options.preparationGateMinimumAheadSeconds,
    requiredAheadSeconds: options.preparationGateRequiredAheadSeconds,
  });

  return {
    ...base,
    ...definedOnly({
      autoPlay: options.autoPlay,
      fit: options.fit,
      loop: options.loop,
    }),
    ...(options.interactionMode === undefined
      ? {}
      : {
          interaction: { ...base.interaction, mode: options.interactionMode },
        }),
    renderPreparation: {
      ...base.renderPreparation,
      ...definedOnly({ mode: options.preparationMode }),
      ...(hasEntries(maskFrame)
        ? {
            maskFrame: {
              ...base.renderPreparation?.maskFrame,
              ...maskFrame,
            },
          }
        : {}),
      ...(hasEntries(preparationGate)
        ? {
            playbackGate: {
              ...base.renderPreparation?.playbackGate,
              ...preparationGate,
            },
          }
        : {}),
    },
  };
}

export function buildDemoNormalization(
  options: DemoSessionOptions,
): MediaSessionNormalizationOptions | undefined {
  if (options.normalize !== true) {
    return undefined;
  }

  const video = definedOnly({
    bitrate: options.normalizeBitrate,
    codec: options.normalizeVideoCodec,
    fit: options.normalizeFit,
    forceTranscode: options.normalizeForceTranscode,
    frameRate: options.normalizeFrameRate,
    height: options.normalizeHeight,
    keyFrameInterval: options.normalizeKeyFrameInterval,
    width: options.normalizeWidth,
  });
  const audio = definedOnly({
    bitrate: options.normalizeAudioBitrate,
    codec: options.normalizeAudioCodec,
    discard: options.normalizeDiscardAudio,
  });

  return {
    ...definedOnly({
      container: options.normalizeContainer,
      stream: options.normalizeStream,
    }),
    ...(hasEntries(video) ? { video } : {}),
    ...(hasEntries(audio) ? { audio } : {}),
  };
}

/** The codec the container picks when the panel leaves the codec unset. */
export function resolveNormalizationVideoCodecLabel(
  container: MediaNormalizationContainer,
) {
  return container === MediaNormalizationContainer.Mp4 ? "avc" : "vp9";
}

/**
 * Drops keys whose value is `undefined`: spreading one writes that `undefined`
 * over the value underneath.
 */
function definedOnly<Value extends object>(value: Value): Partial<Value> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<Value>;
}

function hasEntries(value: object) {
  return Object.keys(value).length > 0;
}
