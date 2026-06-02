import type { Dispatch, SetStateAction } from "react";
import type {
  DetectionPickResult,
  MediaRendererState,
  MediaSessionState,
  MediaSourceState,
  RenderPreparationDiagnostics,
} from "supervision-js";
import type {
  Sam3FixtureDetectionSourceSummary,
  Sam3FixtureSummary,
} from "../fixtures/sam3-fixtures";
import type { PreparedUploadMedia } from "../media/upload-media";
import type { BasketballPresentationSettings } from "../presentation/basketball-presentation";

export enum DemoSourceMode {
  Fixture = "fixture",
  Upload = "upload",
}

export interface DemoMediaState {
  readonly errorMessage: string | null;
  readonly status: string;
}

export interface DemoDetectionSourceState {
  readonly datasetId: string | null;
  readonly errorMessage: string | null;
  readonly sourceSummary: Sam3FixtureDetectionSourceSummary | null;
  readonly status: string;
}

export interface UploadInferenceState {
  readonly completedFrames: number;
  readonly errorMessage: string | null;
  readonly inferredDetections: number;
  readonly normalizedRanges: readonly TimelineRange[];
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
  readonly onDetectionHover: (pick: DetectionPickResult | null) => void;
  readonly onDetectionSelect: (pick: DetectionPickResult | null) => void;
  readonly onFixtureSummary: (summary: Sam3FixtureSummary) => void;
  readonly onFrame: () => void;
  readonly onMediaState: (state: DemoMediaState) => void;
  readonly onRenderPreparationDiagnostics: (
    diagnostics: RenderPreparationDiagnostics,
  ) => void;
  readonly onRendererState: (state: MediaRendererState) => void;
  readonly onSessionState: (state: MediaSessionState) => void;
  readonly onSourceState: (state: MediaSourceState) => void;
  readonly presentationSettings: BasketballPresentationSettings;
}

export type UploadInferenceStateSetter = Dispatch<
  SetStateAction<UploadInferenceState>
>;
