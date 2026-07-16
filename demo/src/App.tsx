import { useMemo, useState } from "react";
import { BenchmarksPanel } from "./components/BenchmarksPanel";
import { ControlBar } from "./components/ControlBar";
import { DemoShell } from "./components/DemoShell";
import { PerformanceStrip } from "./components/PerformanceStrip";
import { QualityControls } from "./components/QualityControls";
import { RenderControls } from "./components/RenderControls";
import { RendererViewport } from "./components/RendererViewport";
import { SelectionPanel } from "./components/SelectionPanel";
import { SourceControls } from "./components/SourceControls";
import { StatusPanel } from "./components/StatusPanel";
import { DemoSourceMode, useDemoRenderer } from "./hooks/useDemoRenderer";
import { defaultDemoClassNames } from "./presentation/demo-presentation";
import { DemoViewMode } from "./session/demo-view-mode";
import type { TimelineRange } from "./session/demo-session-types";

const docsUrl =
  import.meta.env.VITE_SUPERVISION_DOCS_URL ??
  (globalThis.location.hostname === "localhost" ||
  globalThis.location.hostname === "127.0.0.1"
    ? "http://127.0.0.1:5175"
    : `${import.meta.env.BASE_URL}docs/`);
const allowUpload = import.meta.env.VITE_DEMO_ALLOW_UPLOAD !== "false";

export function App() {
  const demo = useDemoRenderer();
  const [viewMode, setViewMode] = useState(DemoViewMode.Demo);
  const processedRanges = useMemo(
    () =>
      demo.sourceMode === DemoSourceMode.Fixture && demo.duration !== null
        ? [{ endTime: demo.duration, startTime: 0 }]
        : demo.uploadInferenceState.processedRanges,
    [demo.duration, demo.sourceMode, demo.uploadInferenceState.processedRanges],
  );
  const processingRanges = useMemo(
    () =>
      demo.sourceMode === DemoSourceMode.Upload
        ? demo.uploadInferenceState.processingRanges
        : [],
    [demo.sourceMode, demo.uploadInferenceState.processingRanges],
  );
  const normalizedRanges = useMemo(
    () =>
      demo.sourceMode === DemoSourceMode.Upload
        ? demo.uploadInferenceState.normalizedRanges
        : createSampleNormalizationRanges({
            duration: demo.duration,
            progress: demo.sessionState?.normalization?.progress ?? null,
          }),
    [
      demo.duration,
      demo.sessionState?.normalization?.progress,
      demo.sourceMode,
      demo.uploadInferenceState.normalizedRanges,
    ],
  );
  const styleClassNames = useMemo(
    () =>
      demo.sourceMode === DemoSourceMode.Upload
        ? parseClassNames(demo.uploadClassNames)
        : (demo.fixtureSummary?.classNames ?? defaultDemoClassNames),
    [demo.fixtureSummary?.classNames, demo.sourceMode, demo.uploadClassNames],
  );

  return (
    <DemoShell
      benchmarksPanel={<BenchmarksPanel />}
      docsUrl={docsUrl}
      mode={viewMode}
      onModeChange={setViewMode}
      viewport={
        <RendererViewport
          containerRef={demo.containerRef}
          mediaState={demo.mediaState}
          sessionState={demo.sessionState}
          uploadInferenceState={
            demo.sourceMode === DemoSourceMode.Upload
              ? demo.uploadInferenceState
              : null
          }
        />
      }
      sourceControls={
        <SourceControls
          apiKey={demo.uploadApiKey}
          allowUpload={allowUpload}
          classNames={demo.uploadClassNames}
          disabled={demo.sourceControlsDisabled}
          mode={demo.sourceMode}
          onApiKeyChange={demo.setUploadApiKey}
          onCancelUploadInference={demo.onCancelUploadInference}
          onClassNamesChange={demo.setUploadClassNames}
          onFileChange={demo.onUploadFileChange}
          onModeChange={demo.setSourceMode}
          onSampleChange={demo.setSampleFixtureId}
          onStartUploadInference={demo.onStartUploadInference}
          sampleFixtureId={demo.sampleFixtureId}
          sampleFixtures={demo.sampleFixtures}
          selectedFileName={demo.uploadFileName}
          uploadState={demo.uploadInferenceState}
        />
      }
      qualityControls={
        <QualityControls
          disabled={!demo.canUseRenderer}
          onChange={demo.setRenderQuality}
          quality={demo.renderQuality}
        />
      }
      selectionPanel={
        <SelectionPanel
          hoveredDetectionPick={demo.hoveredDetectionPick}
          onClearSelection={demo.onClearSelectedDetection}
          playbackState={demo.playbackState}
          selectedDetectionPick={demo.selectedDetectionPick}
        />
      }
      controlBar={
        <ControlBar
          activeDetectionFrameTime={
            demo.rendererState?.activeDetectionFrameTime ?? null
          }
          canUseRenderer={demo.canUseRenderer}
          currentTime={demo.rendererState?.currentTime ?? null}
          detectionBuffer={demo.rendererState?.detectionBuffer ?? null}
          duration={demo.duration}
          onSeek={demo.onSeek}
          onStepFrame={demo.onStepFrame}
          onTogglePlayback={demo.onTogglePlayback}
          playbackState={demo.playbackState}
          normalizedRanges={normalizedRanges}
          processedRanges={processedRanges}
          processingRanges={processingRanges}
          renderPreparationDiagnostics={demo.renderPreparationDiagnostics}
        />
      }
      renderControls={
        <RenderControls
          availability={demo.presentationAvailability}
          classNames={styleClassNames}
          onChange={demo.setPresentationSettings}
          settings={demo.presentationSettings}
        />
      }
      performanceStrip={
        <PerformanceStrip
          renderPreparationDiagnostics={demo.renderPreparationDiagnostics}
          rendererState={demo.rendererState}
        />
      }
      statusPanel={
        <StatusPanel
          detectionSourceState={demo.detectionSourceState}
          errorMessage={demo.errorMessage}
          fixtureSummary={demo.fixtureSummary}
          hoveredDetectionPick={demo.hoveredDetectionPick}
          mediaState={demo.mediaState}
          playbackState={demo.playbackState}
          renderPreparationDiagnostics={demo.renderPreparationDiagnostics}
          rendererState={demo.rendererState}
          selectedDetectionPick={demo.selectedDetectionPick}
          sessionState={demo.sessionState}
          sourceState={demo.sourceState}
        />
      }
    />
  );
}

function createSampleNormalizationRanges({
  duration,
  progress,
}: {
  readonly duration: number | null;
  readonly progress: {
    readonly processedTime: number;
    readonly progress: number;
  } | null;
}): readonly TimelineRange[] {
  if (duration === null || duration <= 0) {
    return [];
  }

  if (progress === null) {
    return [];
  }

  const endTime =
    progress.progress >= 0.999
      ? duration
      : Math.min(Math.max(progress.processedTime, 0), duration);

  return [
    {
      endTime,
      startTime: 0,
    },
  ];
}

function parseClassNames(value: string) {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}
