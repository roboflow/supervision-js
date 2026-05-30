import { ControlBar } from "./components/ControlBar";
import { DemoShell } from "./components/DemoShell";
import { RenderControls } from "./components/RenderControls";
import { RendererViewport } from "./components/RendererViewport";
import { SourceControls } from "./components/SourceControls";
import { StatusPanel } from "./components/StatusPanel";
import {
  DemoSourceMode,
  useBasketballDemoRenderer,
} from "./hooks/useBasketballDemoRenderer";
import { defaultBasketballClassNames } from "./presentation/basketball-presentation";

export function App() {
  const demo = useBasketballDemoRenderer();
  const processedRanges =
    demo.sourceMode === DemoSourceMode.Basketball && demo.duration !== null
      ? [{ endTime: demo.duration, startTime: 0 }]
      : demo.uploadInferenceState.processedRanges;
  const processingRanges =
    demo.sourceMode === DemoSourceMode.Upload
      ? demo.uploadInferenceState.processingRanges
      : [];
  const normalizedRanges =
    demo.sourceMode === DemoSourceMode.Upload
      ? demo.uploadInferenceState.normalizedRanges
      : [];
  const styleClassNames =
    demo.sourceMode === DemoSourceMode.Upload
      ? parseClassNames(demo.uploadClassNames)
      : defaultBasketballClassNames;

  return (
    <DemoShell
      viewport={
        <RendererViewport
          containerRef={demo.containerRef}
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
          classNames={demo.uploadClassNames}
          disabled={demo.sourceControlsDisabled}
          mode={demo.sourceMode}
          onApiKeyChange={demo.setUploadApiKey}
          onCancelUploadInference={demo.onCancelUploadInference}
          onClassNamesChange={demo.setUploadClassNames}
          onFileChange={demo.onUploadFileChange}
          onModeChange={demo.setSourceMode}
          onStartUploadInference={demo.onStartUploadInference}
          selectedFileName={demo.uploadFileName}
          uploadState={demo.uploadInferenceState}
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
        />
      }
      renderControls={
        <RenderControls
          classNames={styleClassNames}
          onChange={demo.setPresentationSettings}
          settings={demo.presentationSettings}
        />
      }
      statusPanel={
        <StatusPanel
          detectionSourceState={demo.detectionSourceState}
          errorMessage={demo.errorMessage}
          fixtureSummary={demo.fixtureSummary}
          mediaState={demo.mediaState}
          playbackState={demo.playbackState}
          renderPreparationDiagnostics={demo.renderPreparationDiagnostics}
          rendererState={demo.rendererState}
          sessionState={demo.sessionState}
          sourceState={demo.sourceState}
        />
      }
    />
  );
}

function parseClassNames(value: string) {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}
