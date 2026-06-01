import { createMemoryColdDetectionFrameStore } from "#detections/memory-cold-detection-frame-store";
import { createWritableDetectionFrameSource } from "#detections/writable-detection-frame-source";
import { DetectionFrameRetentionMode } from "#types/detection-timeline";
import type {
  DetectionFrameSource,
  WritableDetectionFrameSource,
} from "#types/detection-timeline";
import type {
  MediaSessionDetectionOptions,
  MediaSessionOptions,
} from "#types/media-session";
import type { MediaRendererOptions } from "#types/media-renderer";
import { resolveMediaSessionAppendableRetention } from "./media-session-defaults";

export interface PreparedSessionDetections {
  readonly detectionFrames?: MediaRendererOptions["detectionFrames"];
  readonly detectionSource?:
    | DetectionFrameSource
    | WritableDetectionFrameSource;
  readonly appendableSource?: WritableDetectionFrameSource;
}

export async function prepareSessionDetections(options: {
  readonly detections: MediaSessionDetectionOptions | undefined;
  readonly mode: MediaSessionOptions["mode"];
}): Promise<PreparedSessionDetections> {
  const { detections } = options;

  if (!detections) {
    return {};
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
      detectionSource: writableSource,
    };
  }

  return {
    detectionFrames: detections.frames,
    detectionSource: detections.source,
  };
}
