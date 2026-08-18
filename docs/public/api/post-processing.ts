/**
 * Ordered detection post-processing, tracking, and browser worker APIs.
 *
 * @module Post Processing
 */

export {
  createByteTrackTracker,
  createCBIoUTracker,
  createDefaultDetectionPostProcessingWorkerFactory,
  createDetectionPostProcessingPipeline,
  createSortTracker,
  createOCSortTracker,
  detectionPostProcessors,
  projectDetectionFrameForTracking,
  DetectionPostProcessingMode,
  TrackingGeometry,
  type ByteTrackTracker,
  type ByteTrackTrackerUpdate,
  type ByteTrackTrackingDetectionPostProcessor,
  type ByteTrackTrackingOptions,
  type CBIoUTracker,
  type CBIoUTrackerUpdate,
  type CBIoUTrackingDetectionPostProcessor,
  type CBIoUTrackingOptions,
  type DetectionPostProcessor,
  type DetectionPostProcessorFactory,
  type DetectionPostProcessingAppendResult,
  type DetectionPostProcessingDiagnostics,
  type DetectionPostProcessingPipeline,
  type DetectionPostProcessingPipelineOptions,
  type DetectionPostProcessingWorkerFactory,
  type OCSortTracker,
  type OCSortTrackerUpdate,
  type OCSortTrackingDetectionPostProcessor,
  type OCSortTrackingOptions,
  type SortTracker,
  type SortTrackerUpdate,
  type SortTrackingOptions,
  type TrackingAssignment,
  type TrackingDetectionPostProcessor,
  type TrackingProjection,
  type TrackingTracker,
} from "supervision";
