import type {
  ColdDetectionFrameStore,
  DetectionFrameSource,
} from "#types/detection-timeline";

export function createColdDetectionFrameSource(options: {
  readonly store: ColdDetectionFrameStore;
  readonly datasetId: string;
}): DetectionFrameSource {
  return {
    loadFrames(startTime, endTime) {
      return options.store.loadFrames({
        datasetId: options.datasetId,
        endTime,
        startTime,
      });
    },
  };
}
