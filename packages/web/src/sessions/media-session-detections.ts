import { createMemoryColdDetectionFrameStore } from "supervision-js-core";
import { createCompositeDetectionFrameSource } from "supervision-js-core";
import { createWritableDetectionFrameSource } from "supervision-js-core";
import { DetectionFrameRetentionMode } from "supervision-js-core";
import type {
  CompositeDetectionFrameSourceEntry,
  DetectionFrameSource,
  WritableDetectionFrameSource,
} from "supervision-js-core";
import type {
  MediaSessionAppendableDetectionOptions,
  MediaSessionDetectionOptions,
  MediaSessionDetectionSourceOptions,
  MediaSessionOptions,
} from "#types/media-session";
import type { MediaRendererOptions } from "#types/media-renderer";
import type { SourcePresentationEntry } from "supervision-js-core";
import { resolveMediaSessionAppendableRetention } from "./media-session-defaults";

export interface PreparedSessionDetections {
  readonly detectionFrames?: MediaRendererOptions["detectionFrames"];
  readonly detectionSource?:
    DetectionFrameSource | WritableDetectionFrameSource;
  readonly appendableSource?: WritableDetectionFrameSource;
  readonly appendableSources: ReadonlyMap<string, WritableDetectionFrameSource>;
  readonly sourcePresentations: readonly SourcePresentationEntry[];
}

export async function prepareSessionDetections(options: {
  readonly detections: MediaSessionDetectionOptions | undefined;
  readonly mode: MediaSessionOptions["mode"];
}): Promise<PreparedSessionDetections> {
  const { detections } = options;

  if (!detections) {
    return {
      appendableSources: new Map(),
      sourcePresentations: [],
    };
  }

  if (detections.sources !== undefined) {
    return prepareMultiSourceSessionDetections({
      detections,
      mode: options.mode,
    });
  }

  if (detections.appendable && detections.writable) {
    throw new Error(
      "Provide only one media session appendable detection option.",
    );
  }

  const appendableDetections = detections.appendable ?? detections.writable;
  const detectionInputCount = [
    detections.frames !== undefined,
    detections.source !== undefined,
    appendableDetections !== undefined,
  ].filter(Boolean).length;

  if (detectionInputCount > 1) {
    throw new Error(
      "Provide only one media session detection input: frames, source, or appendable.",
    );
  }

  if (appendableDetections) {
    const retention = resolveMediaSessionAppendableRetention({
      appendable: appendableDetections,
      mode: options.mode,
    });
    const store =
      retention.mode === DetectionFrameRetentionMode.MemoryOnly
        ? createMemoryColdDetectionFrameStore()
        : (appendableDetections.store ?? createMemoryColdDetectionFrameStore());
    const writableSource = createWritableDetectionFrameSource({
      chunkDurationSeconds: appendableDetections.chunkDurationSeconds,
      datasetId: appendableDetections.datasetId,
      live: appendableDetections.live,
      retention,
      store,
    });

    try {
      if (appendableDetections.clearOnCreate) {
        await writableSource.clear();
      }
    } catch (error) {
      writableSource.destroy?.();
      throw error;
    }

    return {
      appendableSource: writableSource,
      appendableSources: new Map([[writableSource.datasetId, writableSource]]),
      detectionSource: writableSource,
      sourcePresentations: [],
    };
  }

  const writableSource = isWritableSource(detections.source)
    ? detections.source
    : undefined;
  return {
    appendableSource: writableSource,
    appendableSources: new Map(
      writableSource ? [[writableSource.datasetId, writableSource]] : [],
    ),
    detectionFrames: detections.frames,
    detectionSource: detections.source
      ? borrowDetectionSource(detections.source)
      : undefined,
    sourcePresentations: [],
  };
}

async function prepareMultiSourceSessionDetections(options: {
  readonly detections: MediaSessionDetectionOptions;
  readonly mode: MediaSessionOptions["mode"];
}): Promise<PreparedSessionDetections> {
  const { detections } = options;
  const legacyInputCount = [
    detections.frames !== undefined,
    detections.source !== undefined,
    detections.appendable !== undefined,
    detections.writable !== undefined,
  ].filter(Boolean).length;

  if (legacyInputCount > 0) {
    throw new Error(
      "Provide either detections.sources or one legacy detection input.",
    );
  }

  if (!detections.sources || detections.sources.length === 0) {
    throw new Error("detections.sources must include at least one source.");
  }

  const appendableSources = new Map<string, WritableDetectionFrameSource>();
  const ownedSources: WritableDetectionFrameSource[] = [];
  const compositeEntries: CompositeDetectionFrameSourceEntry[] = [];

  validateMediaSessionDetectionSources(detections.sources);

  try {
    for (const sourceOptions of detections.sources) {
      const appendableSource = sourceOptions.appendable
        ? await createSessionWritableDetectionSource({
            appendable: sourceOptions.appendable,
            mode: options.mode,
          })
        : isWritableSource(sourceOptions.source)
          ? sourceOptions.source
          : undefined;

      if (sourceOptions.appendable && appendableSource) {
        ownedSources.push(appendableSource);
      }

      if (appendableSource) {
        appendableSources.set(sourceOptions.id, appendableSource);
      }

      compositeEntries.push({
        frames: sourceOptions.frames,
        id: sourceOptions.id,
        order: sourceOptions.order,
        requiredForCoverage: sourceOptions.requiredForCoverage,
        source: sourceOptions.source
          ? borrowDetectionSource(sourceOptions.source)
          : appendableSource,
        sync: sourceOptions.sync,
      });
    }
  } catch (error) {
    for (const source of ownedSources) {
      source.destroy?.();
    }

    throw error;
  }

  return {
    appendableSources,
    detectionSource: createCompositeDetectionFrameSource({
      ...detections.sync,
      sources: compositeEntries,
    }),
    sourcePresentations: detections.sources.map((source) => ({
      id: source.id,
      presentation: source.presentation,
    })),
  };
}

function isWritableSource(
  source: DetectionFrameSource | undefined,
): source is WritableDetectionFrameSource {
  const candidate = source as Partial<WritableDetectionFrameSource> | undefined;
  return (
    typeof candidate?.datasetId === "string" &&
    (
      [
        "appendFrames",
        "replaceFrames",
        "clear",
        "getVersion",
        "getSummary",
        "waitForRange",
        "getAvailableRanges",
      ] as const
    ).every((method) => typeof candidate[method] === "function")
  );
}

function borrowDetectionSource(
  source: DetectionFrameSource,
): DetectionFrameSource {
  return {
    loadFrames: source.loadFrames.bind(source),
    ...(source.getVersion
      ? { getVersion: source.getVersion.bind(source) }
      : {}),
    ...(source.getChangesSince
      ? { getChangesSince: source.getChangesSince.bind(source) }
      : {}),
    ...(source.getAvailableRanges
      ? { getAvailableRanges: source.getAvailableRanges.bind(source) }
      : {}),
    ...(source.waitForRange
      ? { waitForRange: source.waitForRange.bind(source) }
      : {}),
  };
}

function validateMediaSessionDetectionSources(
  sources: readonly MediaSessionDetectionSourceOptions[],
) {
  const sourceIds = new Set<string>();

  for (const source of sources) {
    if (sourceIds.has(source.id)) {
      throw new Error(`Duplicate detection source id: ${source.id}.`);
    }

    sourceIds.add(source.id);

    const inputCount = [
      source.frames !== undefined,
      source.source !== undefined,
      source.appendable !== undefined,
    ].filter(Boolean).length;

    if (inputCount !== 1) {
      throw new Error(
        `Detection source ${source.id} must provide exactly one input: frames, source, or appendable.`,
      );
    }
  }
}

async function createSessionWritableDetectionSource(options: {
  readonly appendable: MediaSessionAppendableDetectionOptions;
  readonly mode: MediaSessionOptions["mode"];
}) {
  const retention = resolveMediaSessionAppendableRetention({
    appendable: options.appendable,
    mode: options.mode,
  });
  const store =
    retention.mode === DetectionFrameRetentionMode.MemoryOnly
      ? createMemoryColdDetectionFrameStore()
      : (options.appendable.store ?? createMemoryColdDetectionFrameStore());
  const writableSource = createWritableDetectionFrameSource({
    chunkDurationSeconds: options.appendable.chunkDurationSeconds,
    datasetId: options.appendable.datasetId,
    live: options.appendable.live,
    retention,
    store,
  });

  try {
    if (options.appendable.clearOnCreate) {
      await writableSource.clear();
    }
  } catch (error) {
    writableSource.destroy?.();
    throw error;
  }

  return writableSource;
}
