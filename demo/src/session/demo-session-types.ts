import type { Dispatch, SetStateAction } from "react";
import type {
  DetectionPickResult,
  MediaRendererSource,
  MediaRendererState,
  MediaSessionState,
  MediaSourceState,
  RenderPreparationDiagnostics,
} from "supervision";
import type {
  DemoFixtureDetectionSourceSummary,
  DemoFixtureSummary,
} from "../fixtures/demo-fixtures";
import type { PreparedUploadMedia } from "../media/upload-media";
import type { PipelineRecorder } from "../pipeline/pipeline-recorder";
import type { DemoPresentationSettings } from "../presentation/demo-presentation";
import type { DemoRenderQuality } from "./render-quality";
import type {
  DemoSessionConfiguration,
  DemoSessionOptions,
} from "./session-options";

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
  readonly sourceSummary: DemoFixtureDetectionSourceSummary | null;
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
  readonly onDetectionHover: (pick: DetectionPickResult | null) => void;
  readonly onDetectionSelect: (pick: DetectionPickResult | null) => void;
  readonly onFixtureSummary: (summary: DemoFixtureSummary) => void;
  readonly onFrame: () => void;
  readonly onMediaState: (state: DemoMediaState) => void;
  readonly onRenderPreparationDiagnostics: (
    diagnostics: RenderPreparationDiagnostics,
  ) => void;
  readonly onRendererState: (state: MediaRendererState) => void;
  readonly onSessionConfiguration: (
    configuration: DemoSessionConfiguration,
  ) => void;
  readonly onSessionState: (state: MediaSessionState) => void;
  readonly onSourceState: (state: MediaSourceState) => void;
  /** Where each step of the session stamps that it ran, for the path diagram. */
  readonly pipeline: PipelineRecorder;
  readonly presentationSettings: DemoPresentationSettings;
  /**
   * The presentation settings as they stand now. The layer toggles change them
   * without reopening the session, so a session that acts on them past its own
   * creation has to ask rather than keep the snapshot above.
   */
  readonly readPresentationSettings?: () => DemoPresentationSettings;
  readonly renderQuality: DemoRenderQuality;
  readonly sessionOptions: DemoSessionOptions;
  readonly tapMediaSource: (source: MediaRendererSource) => MediaRendererSource;
}

export type UploadInferenceStateSetter = Dispatch<
  SetStateAction<UploadInferenceState>
>;
