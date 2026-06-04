/**
 * Detection data, frame sources, buffering, cold storage, and retention APIs.
 *
 * @module Detections
 */

export {
  createArrayDetectionFrameSource,
  createBrowserColdDetectionFrameStore,
  createBufferedDetectionTimeline,
  createChunkedDetectionFrameSource,
  createColdDetectionFrameSource,
  createMemoryColdDetectionFrameStore,
  createWritableDetectionFrameSource,
  DetectionBufferStatus,
  DetectionFrameRetentionMode,
  DetectionFrameSelectionMode,
  DetectionMaskEncoding,
  type BufferedDetectionTimeline,
  type ColdDetectionFrameStore,
  type ColdDetectionFrameStoreLoadOptions,
  type ColdDetectionFrameStoreWriteOptions,
  type ColdDetectionFrameStoreWriteSummary,
  type CompressedRleDetectionMask,
  type ChunkedDetectionFrameSourceOptions,
  type Detection,
  type DetectionBufferOptions,
  type DetectionBufferPrepareOptions,
  type DetectionBufferState,
  type DetectionFrame,
  type DetectionFrameChunk,
  type DetectionFrameChunkDescriptor,
  type DetectionFrameChunkFetch,
  type DetectionFrameChunkManifest,
  type DetectionFrameRetentionOptions,
  type DetectionFrameSelectionOptions,
  type DetectionFrameSource,
  type DetectionFrameSourceVersionRange,
  type DetectionMask,
  type DetectionPlaybackGateOptions,
  type DetectionTimelineContext,
  type Rect,
  type WritableDetectionFrameSource,
} from "../../../src/index";
