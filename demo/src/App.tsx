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

  return (
    <DemoShell
      viewport={<RendererViewport containerRef={demo.containerRef} />}
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
          onTogglePlayback={demo.onTogglePlayback}
          playbackState={demo.playbackState}
          normalizedRanges={normalizedRanges}
          processedRanges={processedRanges}
          processingRanges={processingRanges}
        />
      }
      renderControls={
        <RenderControls
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
          sourceState={demo.sourceState}
        />
      }
    />
  );
}
