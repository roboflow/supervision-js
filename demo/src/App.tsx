import { useEffect, useMemo, useState, type ReactNode } from "react";
import { MediaSessionActivityKind } from "supervision";
import { BenchmarksPanel } from "./components/BenchmarksPanel";
import { ControlBar } from "./components/ControlBar";
import { DemoShell } from "./components/DemoShell";
import { DocsBasketballPlayground } from "./components/DocsBasketballPlayground";
import { DocsAnnotationRendererPlayground } from "./components/DocsAnnotationRendererPlayground";
import { PerformanceStrip } from "./components/PerformanceStrip";
import { PlayerHotkeys } from "./components/PlayerHotkeys";
import { PresentationDiagnostics } from "./components/PresentationDiagnostics";
import { QualityControls } from "./components/QualityControls";
import { RenderControls } from "./components/RenderControls";
import { RendererViewport } from "./components/RendererViewport";
import { SelectionPanel } from "./components/SelectionPanel";
import { SourceControls } from "./components/SourceControls";
import { StatusPanel } from "./components/StatusPanel";
import { resolveDemoDocsUrl } from "./docs-url";
import { parseDocsAnnotationRenderer } from "./docs-annotation-renderer";
import { DemoSourceMode, useDemoRenderer } from "./hooks/useDemoRenderer";
import { defaultDemoClassNames } from "./presentation/demo-presentation";
import { DemoViewMode } from "./session/demo-view-mode";

const docsUrl = resolveDemoDocsUrl(
  import.meta.env.VITE_SUPERVISION_DOCS_URL,
  globalThis.location,
);
const allowUpload = import.meta.env.VITE_DEMO_ALLOW_UPLOAD !== "false";

/**
 * The picture never waits for annotations, so these read as background progress
 * rather than as conditions the viewer has to sit through. The control bar
 * reports them: buffering on the play button and in the state chip, the
 * prepared window and the detection buffer in their own timeline lanes.
 */
const BACKGROUND_ACTIVITY_KINDS: ReadonlySet<MediaSessionActivityKind> =
  new Set([
    MediaSessionActivityKind.DetectionsBuffering,
    MediaSessionActivityKind.DetectionsLoading,
    MediaSessionActivityKind.PlaybackBuffering,
    MediaSessionActivityKind.RenderPreparing,
  ]);

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
  const viewportSessionState = useMemo(() => {
    const sessionState = demo.sessionState;

    if (sessionState === null) {
      return null;
    }

    const activities = sessionState.activities.filter(
      (activity) => !BACKGROUND_ACTIVITY_KINDS.has(activity.kind),
    );

    return activities.length === sessionState.activities.length
      ? sessionState
      : { ...sessionState, activities };
  }, [demo.sessionState]);
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
        onSeek={demo.onSeek}
        onStepFrame={demo.onStepFrame}
        onTogglePlayback={demo.onTogglePlayback}
      />
      <DemoShell
        benchmarksPanel={<BenchmarksPanel />}
        docsUrl={docsUrl}
        mode={viewMode}
        onModeChange={setViewMode}
        viewport={
          <RendererViewport
            containerRef={demo.containerRef}
            mediaState={demo.mediaState}
            sessionState={viewportSessionState}
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
            onScrub={demo.onScrub}
            onSeek={demo.onSeek}
            onStepFrame={demo.onStepFrame}
            onTogglePlayback={demo.onTogglePlayback}
            playbackState={demo.playbackState}
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
        presentationDiagnostics={
          <PresentationDiagnostics
            detectionRanges={processedRanges}
            duration={demo.duration}
            readSample={demo.readPresentationDiagnostics}
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
    </>
  );
}

function parseClassNames(value: string) {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}
