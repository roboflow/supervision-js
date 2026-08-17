/**
 * Ordered detection post-processing, tracking, and browser worker APIs.
 *
 * @module Post Processing
 */

export {
  createDefaultDetectionPostProcessingWorkerFactory,
  createDetectionPostProcessingPipeline,
  createSortTracker,
  detectionPostProcessors,
  projectDetectionFrameForTracking,
  DetectionPostProcessingMode,
  TrackingGeometry,
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
} from "supervision";
