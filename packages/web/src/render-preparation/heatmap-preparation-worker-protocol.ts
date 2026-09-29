import type {
  DetectionHeatmap,
  HeatmapAnnotationRenderer,
} from "supervision-js-core";

export enum HeatmapPreparationWorkerMessageType {
  Prepare = "heatmap-prepare",
  Complete = "heatmap-complete",
  Error = "heatmap-error",
}

export interface HeatmapPreparationWorkerRequest {
  readonly map: DetectionHeatmap;
  readonly renderer: HeatmapAnnotationRenderer;
  readonly requestId: number;
  readonly type: HeatmapPreparationWorkerMessageType.Prepare;
}

export type HeatmapPreparationWorkerResponse =
  | {
      readonly imageBitmap?: ImageBitmap;
      readonly imageData?: ImageData;
      readonly requestId: number;
      readonly type: HeatmapPreparationWorkerMessageType.Complete;
    }
  | {
      readonly error: string;
      readonly requestId: number;
      readonly type: HeatmapPreparationWorkerMessageType.Error;
    };
