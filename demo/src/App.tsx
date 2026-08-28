import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { MediaRendererPlaybackState } from "supervision";
import { BenchmarksPanel } from "./components/BenchmarksPanel";
import { ControlBar } from "./components/ControlBar";
import { DemoShell } from "./components/DemoShell";
import { EngineDiagnostics } from "./components/EngineDiagnostics";
import { DocsBasketballPlayground } from "./components/DocsBasketballPlayground";
import { DocsAnnotationRendererPlayground } from "./components/DocsAnnotationRendererPlayground";
import { DocsTrackingPostProcessorPlayground } from "./components/DocsTrackingPostProcessorPlayground";
import { PerformanceStrip } from "./components/PerformanceStrip";
import { PipelinePanel } from "./components/PipelinePanel";
import { PlayerHotkeys } from "./components/PlayerHotkeys";
import { PresentationDiagnostics } from "./components/PresentationDiagnostics";
import { QualityControls } from "./components/QualityControls";
import { RenderControls } from "./components/RenderControls";
import { RendererViewport } from "./components/RendererViewport";
import { useViewportOverlay } from "./hooks/useViewportOverlay";
import { selectViewportSessionState } from "./components/viewport-overlay";
import { SelectionPanel } from "./components/SelectionPanel";
import { SessionOptionsPanel } from "./components/SessionOptionsPanel";
import { SlowWorkPanel } from "./components/SlowWorkPanel";
import { SourceControls } from "./components/SourceControls";
import { StatusPanel } from "./components/StatusPanel";
import { resolveDemoDocsUrl } from "./docs-url";
import { parseDocsAnnotationRenderer } from "./docs-annotation-renderer";
import { DemoSourceMode, useDemoRenderer } from "./hooks/useDemoRenderer";
import { useSourceResidency } from "./hooks/useSourceResidency";
import { readDemoSourceResidency } from "./session/source-residency";
import { applyDemoSourceResidency } from "./session/session-options";
import { defaultDemoClassNames } from "./presentation/demo-presentation";
import {
  DemoViewMode,
  readStoredDemoViewMode,
  writeStoredDemoViewMode,
} from "./session/demo-view-mode";

const docsUrl = resolveDemoDocsUrl(
  import.meta.env.VITE_SUPERVISION_DOCS_URL,
  globalThis.location,
);
const allowUpload = import.meta.env.VITE_DEMO_ALLOW_UPLOAD !== "false";
const urlSourceResidency = readDemoSourceResidency(
  globalThis.location?.search ?? "",
);

export function App() {
  const searchParams = new URLSearchParams(globalThis.location.search);
  const embeddedView = searchParams.get("embed");

  if (embeddedView === "docs-playground") {
    return (
      <EmbeddedPlaygroundFrame>
        <DocsBasketballPlayground />
      </EmbeddedPlaygroundFrame>
    );
  }

  if (embeddedView === "annotation-renderer") {
    return (
      <EmbeddedPlaygroundFrame>
        <DocsAnnotationRendererPlayground
          renderer={parseDocsAnnotationRenderer(searchParams.get("renderer"))}
        />
      </EmbeddedPlaygroundFrame>
    );
  }

  if (embeddedView === "post-processor") {
    return (
      <EmbeddedPlaygroundFrame>
        <DocsTrackingPostProcessorPlayground />
      </EmbeddedPlaygroundFrame>
    );
  }

  return <DemoApp />;
}

function EmbeddedPlaygroundFrame({
  children,
}: {
  readonly children: ReactNode;
}) {
  useEffect(() => {
    const root = document.getElementById("root");
    const previous = {
      bodyHeight: document.body.style.height,
      bodyOverflow: document.body.style.overflow,
      htmlHeight: document.documentElement.style.height,
      rootHeight: root?.style.height ?? "",
    };

    document.documentElement.style.height = "auto";
    document.body.style.height = "auto";
    document.body.style.overflow = "visible";
    root?.style.setProperty("height", "auto");

    const publishHeight = () => {
      const height = Math.max(
        document.documentElement.scrollHeight,
        document.body.scrollHeight,
        root?.scrollHeight ?? 0,
      );
      window.parent.postMessage(
        { height, type: "supervision-js:playground-height" },
        "*",
      );
    };

    const observer = new ResizeObserver(publishHeight);
    observer.observe(document.documentElement);
    if (root) {
      observer.observe(root);
    }
    publishHeight();

    return () => {
      observer.disconnect();
      document.documentElement.style.height = previous.htmlHeight;
      document.body.style.height = previous.bodyHeight;
      document.body.style.overflow = previous.bodyOverflow;
      root?.style.setProperty("height", previous.rootHeight);
    };
  }, []);

  return children;
}

function DemoApp() {
  const demo = useDemoRenderer();
  const [viewMode, setViewMode] = useState(() =>
    readStoredDemoViewMode(DemoViewMode.Demo),
  );
  const onViewModeChange = useCallback((mode: DemoViewMode) => {
    setViewMode(mode);
    writeStoredDemoViewMode(mode);
  }, []);
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
  const sourceResidency = useSourceResidency(
    demo.engineDiagnosticsTap,
    applyDemoSourceResidency(urlSourceResidency, demo.sessionOptions) !==
      undefined,
  );
  const viewportSessionState = useMemo(
    () => selectViewportSessionState(demo.sessionState),
    [demo.sessionState],
  );
  const viewportOverlay = useViewportOverlay(
    viewportSessionState,
    demo.sourceMode === DemoSourceMode.Upload
      ? demo.uploadInferenceState
      : null,
    demo.mediaState,
  );
  const styleClassNames = useMemo(
    () =>
      demo.sourceMode === DemoSourceMode.Upload
        ? parseClassNames(demo.uploadClassNames)
        : (demo.fixtureSummary?.classNames ?? defaultDemoClassNames),
    [demo.fixtureSummary?.classNames, demo.sourceMode, demo.uploadClassNames],
  );

  return (
    <>
      <PlayerHotkeys
        currentTime={demo.rendererState?.currentTime ?? null}
        disabled={!demo.canUseRenderer}
        duration={demo.duration}
        isPlaying={demo.playbackState === MediaRendererPlaybackState.Playing}
        onPause={demo.pausePlayback}
        onPlay={() => void demo.playPlayback()}
        onSeek={demo.onSeek}
        onSetPlaybackRate={demo.onSetPlaybackRate}
        onStepFrame={demo.onStepFrame}
        onTogglePlayback={demo.onTogglePlayback}
        playbackRate={demo.playbackRate}
      />
      <DemoShell
        benchmarksPanel={<BenchmarksPanel />}
        docsUrl={docsUrl}
        mode={viewMode}
        onModeChange={onViewModeChange}
        viewport={
          <RendererViewport
            containerRef={demo.containerRef}
            explained={viewportOverlay.explained}
            overlay={viewportOverlay.overlay}
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
        pipelinePanel={
          <PipelinePanel
            descriptor={demo.pipelineDescriptor}
            engineDiagnosticsTap={demo.engineDiagnosticsTap}
          />
        }
        sessionOptionsPanel={
          <>
            <SessionOptionsPanel
              configuration={demo.sessionConfiguration}
              onChange={demo.setSessionOptions}
              options={demo.sessionOptions}
              playbackGateReach={demo.rendererState?.playbackGateReach ?? null}
            />
            <SlowWorkPanel onReopenSession={demo.reopenSession} />
          </>
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
            canUseRenderer={demo.canUseRenderer}
            duration={demo.duration}
            frameTimeline={demo.frameTimeline}
            onScrub={demo.onScrub}
            onSeek={demo.onSeek}
            onSetPlaybackRate={demo.onSetPlaybackRate}
            onStepFrame={demo.onStepFrame}
            onTogglePlayback={demo.onTogglePlayback}
            playbackRate={demo.playbackRate}
            playbackState={demo.playbackState}
            presentedRate={demo.presentedRate}
            processedRanges={processedRanges}
            processingRanges={processingRanges}
            sourceResidency={sourceResidency}
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
            sourceFrameRate={demo.sourceState?.estimatedFrameRate ?? null}
          />
        }
        presentationDiagnostics={
          <>
            <EngineDiagnostics tap={demo.engineDiagnosticsTap} />
            <PresentationDiagnostics
              detectionRanges={processedRanges}
              duration={demo.duration}
              readSample={demo.readPresentationDiagnostics}
            />
          </>
        }
        statusPanel={
          <StatusPanel
            detectionSourceState={demo.detectionSourceState}
            errorMessage={demo.errorMessage}
            fixtureSummary={demo.fixtureSummary}
            hoveredDetectionPick={demo.hoveredDetectionPick}
            mediaState={demo.mediaState}
            playbackState={demo.playbackState}
            presentedRate={demo.presentedRate}
            renderPreparationDiagnostics={demo.renderPreparationDiagnostics}
            rendererState={demo.rendererState}
            selectedDetectionPick={demo.selectedDetectionPick}
            sessionState={demo.sessionState}
            sourceState={demo.sourceState}
          />
        }
      />
    </>
  );
}

function parseClassNames(value: string) {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}
