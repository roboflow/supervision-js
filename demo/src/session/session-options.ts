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
import type {
  SourceResidencyConfig,
  WebVideoEngineOptions,
} from "supervision/web-video-engine";

import { DEMO_SOURCE_RESIDENCY_BUDGET_MB } from "./source-residency";

const BYTES_PER_MEBIBYTE = 1024 * 1024;

/**
 * What the web video engine is asked to do with the clip's bytes and its
 * decoded frames. Only a URL source reads `sourceResidency` and `urlSource`.
 */
export type DemoEngineOptions = Pick<
  WebVideoEngineOptions,
  | "cacheSkipNearMs"
  | "cacheStrategy"
  | "prefer2d"
  | "previewCapacity"
  | "previewWidth"
  | "sourceResidency"
  | "urlSource"
>;

/** How much of the clip's bytes this process keeps once they have been read. */
export enum DemoSourceResidency {
  Off = "off",
  Hold = "hold",
  Prefetch = "prefetch",
}

/**
 * What the web video engine was handed, if anything. The Mediabunny media path
 * leaves the clip to the library's own reader, so no engine opens at all.
 */
export enum DemoEngineSource {
  Url = "url",
  Blob = "blob",
  None = "none",
}

/** Which reader opens the clip, and so which of the option groups can act. */
export enum DemoMediaPath {
  Engine = "engine",
  Mediabunny = "mediabunny",
}

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
  readonly cacheSkipNearMs?: number;
  readonly cacheStrategy?: DemoEngineOptions["cacheStrategy"];
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
  readonly mediaPath?: DemoMediaPath;
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
  readonly prefer2d?: boolean;
  readonly preparationGateEnabled?: boolean;
  readonly preparationGateMinimumAheadSeconds?: number;
  readonly preparationGateRequiredAheadSeconds?: number;
  readonly preparationMode?: RenderPreparationMode;
  readonly previewCapacity?: number;
  readonly previewWidth?: number;
  readonly refreshIntervalSeconds?: number;
  readonly sourceResidency?: DemoSourceResidency;
  readonly sourceResidencyBudgetMb?: number;
  readonly urlSourceMaxCacheMb?: number;
  readonly urlSourceParallelism?: number;
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
  readonly engine: DemoEngineOptions;
  readonly engineSource: DemoEngineSource;
  readonly fit: MediaRendererFit;
  readonly interactionMode: MediaInteractionMode;
  readonly loop: boolean;
  readonly mediaPath: DemoMediaPath;
  readonly mediaPathSupport: DemoOptionSupport;
  readonly mode: MediaSessionMode;
  readonly normalizationSupport: DemoOptionSupport;
  readonly playbackGate: boolean | undefined;
  readonly preparationMode: RenderPreparationMode;
  readonly resolved: ResolvedMediaSessionDefaults;
}

/**
 * Whether a group of options can act on this session, and what to tell a visitor
 * when it cannot. A group that cannot act is shown switched off, never removed.
 */
export interface DemoOptionSupport {
  readonly supported: boolean;
  readonly reason: string | null;
}

export const optionSupported: DemoOptionSupport = {
  reason: null,
  supported: true,
};

export function describeMissingSupport(reason: string): DemoOptionSupport {
  return { reason, supported: false };
}

export function resolveDemoSessionConfiguration(options: {
  readonly detections: MediaSessionDetectionOptions;
  readonly engine: DemoEngineOptions;
  readonly engineSource: DemoEngineSource;
  readonly mediaPath: DemoMediaPath;
  readonly mediaPathSupport: DemoOptionSupport;
  readonly mode: MediaSessionMode;
  readonly normalizationSupport: DemoOptionSupport;
  readonly playbackGate: boolean | undefined;
  readonly renderer: MediaSessionRendererOptions;
}): DemoSessionConfiguration {
  return {
    autoPlay: options.renderer.autoPlay ?? true,
    autoRefresh: options.detections.autoRefresh ?? true,
    engine: options.engine,
    engineSource: options.engineSource,
    fit: options.renderer.fit ?? MediaRendererFit.Contain,
    interactionMode:
      options.renderer.interaction?.mode ?? MediaInteractionMode.PausedOnly,
    loop: options.renderer.loop !== false,
    mediaPath: options.mediaPath,
    mediaPathSupport: options.mediaPathSupport,
    mode: options.mode,
    normalizationSupport: options.normalizationSupport,
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

export function applyDemoMediaPath(options: DemoSessionOptions): DemoMediaPath {
  return options.mediaPath ?? DemoMediaPath.Engine;
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

/**
 * The residency the panel asks for, over whatever the page URL opened with. The
 * budget survives a change of mode, so switching Hold to Prefetch keeps the
 * ceiling the URL or the slider already set.
 */
export function applyDemoSourceResidency(
  base: SourceResidencyConfig | undefined,
  options: DemoSessionOptions,
): SourceResidencyConfig | undefined {
  const mode = options.sourceResidency ?? readDemoSourceResidencyMode(base);

  if (mode === DemoSourceResidency.Off) {
    return undefined;
  }

  return {
    budgetBytes:
      options.sourceResidencyBudgetMb === undefined
        ? (base?.budgetBytes ??
          DEMO_SOURCE_RESIDENCY_BUDGET_MB * BYTES_PER_MEBIBYTE)
        : Math.round(options.sourceResidencyBudgetMb * BYTES_PER_MEBIBYTE),
    prefetch: mode === DemoSourceResidency.Prefetch,
  };
}

export function readDemoSourceResidencyMode(
  residency: SourceResidencyConfig | undefined,
): DemoSourceResidency {
  if (residency === undefined) {
    return DemoSourceResidency.Off;
  }

  return residency.prefetch
    ? DemoSourceResidency.Prefetch
    : DemoSourceResidency.Hold;
}

export function applyDemoEngineOptions(
  base: DemoEngineOptions,
  options: DemoSessionOptions,
): DemoEngineOptions {
  const urlSource = definedOnly({
    maxCacheSize:
      options.urlSourceMaxCacheMb === undefined
        ? undefined
        : Math.round(options.urlSourceMaxCacheMb * BYTES_PER_MEBIBYTE),
    parallelism: options.urlSourceParallelism,
  });

  return definedOnly({
    ...base,
    ...definedOnly({
      cacheSkipNearMs: options.cacheSkipNearMs,
      cacheStrategy: options.cacheStrategy,
      prefer2d: options.prefer2d,
      previewCapacity: options.previewCapacity,
      previewWidth: options.previewWidth,
    }),
    sourceResidency: applyDemoSourceResidency(base.sourceResidency, options),
    urlSource: hasEntries(urlSource)
      ? { ...base.urlSource, ...urlSource }
      : base.urlSource,
  });
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

/**
 * The session plays the conversion in place of the clip, so an engine source
 * opened alongside it would never reach the picture.
 */
export function buildDemoNormalization(
  mediaPath: DemoMediaPath,
  options: DemoSessionOptions,
): MediaSessionNormalizationOptions | undefined {
  if (mediaPath === DemoMediaPath.Engine || options.normalize !== true) {
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
