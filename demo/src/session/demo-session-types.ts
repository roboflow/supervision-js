import type { Dispatch, SetStateAction } from "react";
import type { MediaSourceState } from "supervision-js";
import type {
  BasketballSampleDetectionSourceSummary,
  BasketballSampleSummary,
} from "../fixtures/basketball-sample";
import type { PreparedUploadMedia } from "../media/upload-media";
import type { BasketballPresentationSettings } from "../presentation/basketball-presentation";

export enum DemoSourceMode {
  Basketball = "basketball",
  Upload = "upload",
}

export interface DemoMediaState {
  readonly errorMessage: string | null;
  readonly status: string;
}

export interface DemoDetectionSourceState {
  readonly datasetId: string | null;
  readonly errorMessage: string | null;
  readonly sourceSummary: BasketballSampleDetectionSourceSummary | null;
  readonly status: string;
}

export interface UploadInferenceState {
  readonly completedFrames: number;
  readonly errorMessage: string | null;
  readonly inferredDetections: number;
  readonly preparedMedia: PreparedUploadMedia | null;
  readonly processedRanges: readonly TimelineRange[];
  readonly processingRanges: readonly TimelineRange[];
  readonly status: "idle" | "preparing" | "running" | "ready" | "error";
  readonly statusLabel: string;
  readonly totalFrames: number;
}

export interface TimelineRange {
  readonly startTime: number;
  readonly endTime: number;
}

export interface DemoSessionCallbacks {
  readonly isActive: () => boolean;
  readonly onDetectionSourceState: (state: DemoDetectionSourceState) => void;
  readonly onFixtureSummary: (summary: BasketballSampleSummary) => void;
  readonly onFrame: () => void;
  readonly onMediaState: (state: DemoMediaState) => void;
  readonly onSourceState: (state: MediaSourceState) => void;
  readonly presentationSettings: BasketballPresentationSettings;
}

export type UploadInferenceStateSetter = Dispatch<
  SetStateAction<UploadInferenceState>
>;
