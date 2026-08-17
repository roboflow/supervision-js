/**
 * Ordered detection post-processing, tracking, and browser worker APIs.
 *
 * @module Post Processing
 */

export {
  createByteTrackTracker,
  createDefaultDetectionPostProcessingWorkerFactory,
  createDetectionPostProcessingPipeline,
  createSortTracker,
  detectionPostProcessors,
  projectDetectionFrameForTracking,
  DetectionPostProcessingMode,
  TrackingGeometry,
  type ByteTrackTracker,
  type ByteTrackTrackerUpdate,
  type ByteTrackTrackingDetectionPostProcessor,
  type ByteTrackTrackingOptions,
  type DetectionPostProcessor,
  type DetectionPostProcessorFactory,
  type DetectionPostProcessingAppendResult,
  type DetectionPostProcessingDiagnostics,
  type DetectionPostProcessingPipeline,
  type DetectionPostProcessingPipelineOptions,
  type DetectionPostProcessingWorkerFactory,
  type SortTracker,
  type SortTrackerUpdate,
  type SortTrackingOptions,
  type TrackingAssignment,
  type TrackingDetectionPostProcessor,
  type TrackingProjection,
  type TrackingTracker,
} from "supervision";
