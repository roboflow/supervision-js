import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { MediaRendererPlaybackState } from "supervision";
import { BenchmarksPanel } from "./components/BenchmarksPanel";
import { CanvasPresentationView } from "./components/CanvasPresentationView";
import { ControlBar } from "./components/ControlBar";
import { DemoShell } from "./components/DemoShell";
import { EngineDiagnostics } from "./components/EngineDiagnostics";
import { DocsBasketballPlayground } from "./components/DocsBasketballPlayground";
import { DocsAnnotationRendererPlayground } from "./components/DocsAnnotationRendererPlayground";
import { DocsDepthPlayground } from "./components/DocsDepthPlayground";
import { DocsHeatmapPlayground } from "./components/DocsHeatmapPlayground";
import { DocsTrackingPostProcessorPlayground } from "./components/DocsTrackingPostProcessorPlayground";
import { PerformanceStrip } from "./components/PerformanceStrip";
import { PipelinePanel } from "./components/PipelinePanel";
import { PlayerHotkeys } from "./components/PlayerHotkeys";
import { PresentationDiagnostics } from "./components/PresentationDiagnostics";
import { QualityControls } from "./components/QualityControls";
import { RenderControls } from "./components/RenderControls";
import { RendererViewport } from "./components/RendererViewport";
import { DepthReadoutPanel } from "./components/DepthReadoutPanel";
import type { WorkbenchDepth } from "./components/DepthStyleSection";
import { DEPTH_VIDEO_OFF_WHILE_CONVERTING } from "./components/media-path-copy";
import { createDepthProbe } from "./hooks/depth-probe";
import { useViewportOverlay } from "./hooks/useViewportOverlay";
import { selectViewportSessionState } from "./components/viewport-overlay";
import { SelectionPanel } from "./components/SelectionPanel";
import { LibraryDeparturesPanel } from "./components/LibraryDeparturesPanel";
import { MediaPathPanel } from "./components/MediaPathPanel";
import { SessionOptionsPanel } from "./components/SessionOptionsPanel";
import { SlowWorkPanel } from "./components/SlowWorkPanel";
import { SourceControls } from "./components/SourceControls";
import { StatusPanel } from "./components/StatusPanel";
import { resolveDemoDocsUrl } from "./docs-url";
import { parseDocsAnnotationRenderer } from "./docs-annotation-renderer";
import { DemoSourceMode, useDemoRenderer } from "./hooks/useDemoRenderer";
import { useSourceResidency } from "./hooks/useSourceResidency";
import { readDemoPresentationMode } from "./session/presentation-mode";
import { readDemoSourceResidency } from "./session/source-residency";
import { applyDemoSourceResidency } from "./session/session-options";
import { defaultDemoClassNames } from "./presentation/demo-presentation";
import { resolveDemoFixture } from "./fixtures/demo-fixtures";
import {
  DemoViewMode,
  readStoredDemoViewMode,
  writeStoredDemoViewMode,
} from "./session/demo-view-mode";
import {
  DemoInspectorTab,
  readStoredDemoInspectorTab,
  writeStoredDemoInspectorTab,
} from "./session/inspector-tabs";
import { listDemoLibraryDepartures } from "./session/library-defaults";

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

  if (embeddedView === "heatmap") {
    return (
      <EmbeddedPlaygroundFrame>
        <DocsHeatmapPlayground />
      </EmbeddedPlaygroundFrame>
    );
  }

  if (embeddedView === "depth") {
    return (
      <EmbeddedPlaygroundFrame>
        <DocsDepthPlayground />
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

  if (readDemoPresentationMode() === "canvas") {
    return <CanvasPresentationView />;
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
  const [inspectorTab, setInspectorTab] = useState(() =>
    readStoredDemoInspectorTab(DemoInspectorTab.Clip),
  );
  const onInspectorTabChange = useCallback((tab: DemoInspectorTab) => {
    setInspectorTab(tab);
    writeStoredDemoInspectorTab(tab);
  }, []);
  const libraryDepartures = useMemo(
    () =>
      demo.sessionConfiguration === null
        ? null
        : listDemoLibraryDepartures({
            configuration: demo.sessionConfiguration,
            renderQuality: demo.renderQuality,
            search: globalThis.location?.search ?? "",
          }),
    [demo.renderQuality, demo.sessionConfiguration],
  );
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
  const clip = useMemo(() => {
    if (demo.sourceMode !== DemoSourceMode.Fixture) return null;
    const fixture = resolveDemoFixture(demo.sampleFixtureId);
    return { id: fixture.sampleName, label: fixture.displayName };
  }, [demo.sampleFixtureId, demo.sourceMode]);
  const [depthProbe] = useState(() => createDepthProbe(demo.getRenderer));
  const depthLayers = useMemo(
    () =>
      demo.sourceMode === DemoSourceMode.Fixture
        ? (resolveDemoFixture(demo.sampleFixtureId).depth?.layers ?? [])
        : [],
    [demo.sampleFixtureId, demo.sourceMode],
  );
  const depthBlocked =
    depthLayers.length > 0 &&
    demo.presentationAvailability?.depthEnabled === false;
  const depthShown =
    demo.presentationSettings.depthEnabled &&
    demo.presentationAvailability?.depthEnabled !== false;
  const workbenchDepth = useMemo<WorkbenchDepth>(
    () => ({
      blockedReason: depthBlocked ? DEPTH_VIDEO_OFF_WHILE_CONVERTING : null,
      layerId: demo.depthLayerId,
      layerLoad: demo.depthLayerLoad,
      layers: depthLayers,
      onLayerChange: demo.setDepthLayer,
      probe: depthProbe,
    }),
    [
      demo.depthLayerId,
      demo.depthLayerLoad,
      demo.setDepthLayer,
      depthBlocked,
      depthLayers,
      depthProbe,
    ],
  );
  const depthReadout = useMemo(
    () => (depthShown ? <DepthReadoutPanel probe={depthProbe} /> : null),
    [depthProbe, depthShown],
  );

  // Steps, seeks, playback and depth landing late each change the depth on
  // screen without the pointer moving.
  useEffect(() => {
    depthProbe.refresh();
  }, [depthProbe, demo.rendererState, demo.sessionState]);
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
        clip={clip}
        departureCount={libraryDepartures?.length ?? null}
        docsUrl={docsUrl}
        libraryDeparturesPanel={
          <LibraryDeparturesPanel departures={libraryDepartures} />
        }
        mediaPath={demo.sessionConfiguration?.mediaPath ?? null}
        mediaPathPanel={
          demo.sessionConfiguration === null ? null : (
            <MediaPathPanel
              onChange={(path) =>
                demo.setSessionOptions({
                  ...demo.sessionOptions,
                  mediaPath: path,
                })
              }
              path={demo.sessionConfiguration.mediaPath}
              support={demo.sessionConfiguration.mediaPathSupport}
            />
          )
        }
        mode={viewMode}
        onModeChange={onViewModeChange}
        onTabChange={onInspectorTabChange}
        tab={inspectorTab}
        viewport={
          <RendererViewport
            containerRef={demo.containerRef}
            explained={viewportOverlay.explained}
            onPointerLeave={depthProbe.onPointerLeave}
            onPointerMove={depthProbe.onPointerMove}
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
            annotationAntialiasing={
              demo.presentationSettings.annotationAntialiasing
            }
            disabled={!demo.canUseRenderer}
            onAnnotationAntialiasingChange={(annotationAntialiasing) =>
              demo.setPresentationSettings({
                ...demo.presentationSettings,
                annotationAntialiasing,
              })
            }
            onChange={demo.setRenderQuality}
            quality={demo.renderQuality}
          />
        }
        pipelinePanel={
          <PipelinePanel
            configuration={demo.sessionConfiguration}
            descriptor={demo.pipelineDescriptor}
            engineDiagnosticsTap={demo.engineDiagnosticsTap}
            onChangeOptions={demo.setSessionOptions}
            options={demo.sessionOptions}
          />
        }
        sessionOptionsPanel={
          <SessionOptionsPanel
            configuration={demo.sessionConfiguration}
            onChange={demo.setSessionOptions}
            options={demo.sessionOptions}
            playbackGateReach={demo.rendererState?.playbackGateReach ?? null}
          />
        }
        slowWorkPanel={<SlowWorkPanel onReopenSession={demo.reopenSession} />}
        selectionPanel={
          <SelectionPanel
            depthReadout={depthReadout}
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
            waitLabel={viewportOverlay.overlay?.label ?? null}
          />
        }
        renderControls={
          <RenderControls
            availability={demo.presentationAvailability}
            classNames={styleClassNames}
            configuration={demo.sessionConfiguration}
            depth={workbenchDepth}
            onChange={demo.setPresentationSettings}
            onSessionOptionsChange={demo.setSessionOptions}
            sessionOptions={demo.sessionOptions}
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
              renderPreparationDiagnostics={demo.renderPreparationDiagnostics}
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
