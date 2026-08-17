import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MediaRendererPlaybackState,
  TrackingGeometry,
  type DetectionPostProcessingDiagnostics,
} from "supervision";
import {
  createDocsTrackingController,
  createDocsTrackingPresentation,
  createDocsTrackingSnippet,
  type DocsTrackingPresentationMode,
} from "../docs-tracking";
import { useDemoRenderer } from "../hooks/useDemoRenderer";
import { RendererViewport } from "./RendererViewport";

const emptyDiagnostics: DetectionPostProcessingDiagnostics = {
  activeTrackCount: 0,
  confirmedTrackCount: 0,
  errorMessage: null,
  executionMode: null,
  lastFrameDurationMs: null,
  nextFrameIndex: 0,
  pendingFrameCount: 0,
  processedFrameCount: 0,
  predictedDetectionCount: 0,
  trackedDetectionCount: 0,
};

export function DocsTrackingPostProcessorPlayground() {
  const [controller] = useState(createDocsTrackingController);
  const [geometry, setGeometry] = useState(TrackingGeometry.Box);
  const geometryRef = useRef(geometry);
  const presentationModeRef = useRef<DocsTrackingPresentationMode>("raw");
  geometryRef.current = geometry;
  const [iouThreshold, setIouThreshold] = useState(0.3);
  const [maxAge, setMaxAge] = useState(30);
  const [diagnostics, setDiagnostics] = useState(emptyDiagnostics);
  const [processedChunks, setProcessedChunks] = useState(0);
  const [status, setStatus] = useState<"raw" | "running" | "tracked" | "error">(
    "raw",
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const sourceTransform = useCallback(
    (
      source: Parameters<typeof controller.attach>[0],
      manifest: Parameters<typeof controller.attach>[1],
    ) => {
      controller.attach(source, manifest);
      return controller;
    },
    [controller],
  );
  const [presentationTransform] = useState(
    () => () =>
      createDocsTrackingPresentation(
        geometryRef.current,
        presentationModeRef.current,
      ),
  );
  const demo = useDemoRenderer({
    fixtureDetectionSourceTransform: sourceTransform,
    initialFixtureId: "basketball_geometry",
    initialPresentationSettings: {
      boxesEnabled: true,
      focusEnabled: false,
      keypointsEnabled: false,
      labelsEnabled: true,
      masksEnabled: false,
      polygonsEnabled: false,
      polylinesEnabled: false,
    },
    presentationTransform,
  });
  const totalFrames = demo.fixtureSummary?.frameCount ?? 270;
  const totalChunks = Math.ceil((demo.fixtureSummary?.duration ?? 9) / 1);
  const progress = Math.min(
    100,
    totalFrames > 0 ? (diagnostics.processedFrameCount / totalFrames) * 100 : 0,
  );
  const snippet = useMemo(
    () => createDocsTrackingSnippet(geometry, iouThreshold, maxAge),
    [geometry, iouThreshold, maxAge],
  );
  const isPlaying =
    demo.playbackState === MediaRendererPlaybackState.Playing ||
    demo.playbackState === MediaRendererPlaybackState.Buffering;

  useEffect(() => () => controller.destroy?.(), [controller]);

  useEffect(() => {
    demo.refreshPresentation();
  }, [demo.refreshPresentation, geometry]);

  const applyTracking = useCallback(async () => {
    setStatus("running");
    setErrorMessage(null);
    setProcessedChunks(0);
    setDiagnostics(emptyDiagnostics);
    if (isPlaying) demo.onTogglePlayback();
    demo.onSeek(0);

    try {
      await controller.run({
        geometry,
        iouThreshold,
        maxAge,
        onChunk(chunkIndex) {
          presentationModeRef.current = "tracked";
          setProcessedChunks(chunkIndex + 1);
          demo.refreshPresentation();
          demo.refreshDetections();
        },
        onDiagnostics: setDiagnostics,
      });
      demo.refreshDetections();
      demo.onSeek(0);
      setStatus("tracked");
    } catch (error) {
      presentationModeRef.current = "tracked";
      demo.refreshPresentation();
      setErrorMessage(
        error instanceof Error ? error.message : "Unable to apply tracking.",
      );
      setStatus("error");
    }
  }, [controller, demo, geometry, iouThreshold, isPlaying, maxAge]);

  const showRaw = useCallback(() => {
    presentationModeRef.current = "raw";
    controller.showRaw();
    setStatus("raw");
    setErrorMessage(null);
    setProcessedChunks(0);
    setDiagnostics(emptyDiagnostics);
    demo.refreshPresentation();
    demo.refreshDetections();
    demo.onSeek(0);
  }, [controller, demo]);

  return (
    <main
      className="docs-layer-playground docs-tracking-playground"
      aria-label="Tracking post-processor playground"
    >
      <section className="docs-layer-playground__stage">
        <RendererViewport
          containerRef={demo.containerRef}
          mediaState={demo.mediaState}
          sessionState={demo.sessionState}
          uploadInferenceState={null}
        />
        <div className="docs-tracking-playground__badge">
          <span>{status === "raw" ? "Raw detections" : "SORT tracking"}</span>
          <strong>{geometryLabel(geometry)}</strong>
        </div>
      </section>

      <section className="docs-layer-playground__panel">
        <header className="docs-layer-playground__header">
          <div>
            <p>Post processor</p>
            <h1>Tracking</h1>
            <span>Ordered SORT in a browser worker</span>
          </div>
          <div className="docs-tracking-playground__header-actions">
            <button
              aria-label={
                isPlaying
                  ? "Pause basketball fixture"
                  : "Play basketball fixture"
              }
              disabled={!demo.canUseRenderer || status === "running"}
              onClick={demo.onTogglePlayback}
              type="button"
            >
              <span aria-hidden="true">{isPlaying ? "Ⅱ" : "▶"}</span>
              {isPlaying ? "Pause" : "Play"}
            </button>
            <button
              disabled={!demo.canUseRenderer || status === "running"}
              onClick={() => void applyTracking()}
              type="button"
            >
              {status === "running" ? "Tracking…" : "Apply tracking"}
            </button>
          </div>
        </header>

        <div className="docs-layer-playground__controls">
          <label className="docs-layer-playground__select">
            <strong>Annotation</strong>
            <select
              disabled={status === "running"}
              onChange={(event) => {
                const nextGeometry = event.currentTarget
                  .value as TrackingGeometry;
                presentationModeRef.current = "raw";
                geometryRef.current = nextGeometry;
                controller.cancel();
                controller.showRaw();
                setStatus("raw");
                setGeometry(nextGeometry);
                setErrorMessage(null);
                setProcessedChunks(0);
                setDiagnostics(emptyDiagnostics);
                demo.refreshPresentation();
                demo.refreshDetections();
                demo.onSeek(0);
              }}
              value={geometry}
            >
              <option value={TrackingGeometry.Box}>Boxes</option>
              <option value={TrackingGeometry.Mask}>Masks</option>
              <option value={TrackingGeometry.Keypoints}>Keypoints</option>
            </select>
          </label>
          <TrackingRange
            label="IoU threshold"
            max={0.8}
            min={0.05}
            onChange={setIouThreshold}
            step={0.05}
            value={iouThreshold}
            valueLabel={iouThreshold.toFixed(2)}
          />
          <TrackingRange
            label="Max age"
            max={90}
            min={1}
            onChange={setMaxAge}
            step={1}
            value={maxAge}
            valueLabel={`${maxAge}f`}
          />
          <button
            className="docs-tracking-playground__raw-button"
            disabled={status === "running" || status === "raw"}
            onClick={showRaw}
            type="button"
          >
            Show raw detections
          </button>
        </div>

        <dl className="docs-tracking-playground__metrics">
          <div>
            <dt>Worker</dt>
            <dd>{diagnostics.executionMode ?? "idle"}</dd>
          </div>
          <div>
            <dt>Frames</dt>
            <dd>
              {diagnostics.processedFrameCount}/{totalFrames}
            </dd>
          </div>
          <div>
            <dt>Pending</dt>
            <dd>{diagnostics.pendingFrameCount}</dd>
          </div>
          <div>
            <dt>Tracks</dt>
            <dd>{diagnostics.activeTrackCount}</dd>
          </div>
          <div>
            <dt>Confirmed</dt>
            <dd>{diagnostics.confirmedTrackCount}</dd>
          </div>
          <div>
            <dt>Predicted</dt>
            <dd>{diagnostics.predictedDetectionCount}</dd>
          </div>
          <div>
            <dt>Worker time</dt>
            <dd>
              {diagnostics.lastFrameDurationMs === null
                ? "—"
                : `${diagnostics.lastFrameDurationMs.toFixed(1)}ms`}
            </dd>
          </div>
          <div>
            <dt>Chunks</dt>
            <dd>
              {processedChunks}/{totalChunks}
            </dd>
          </div>
        </dl>

        {errorMessage ? (
          <p className="docs-tracking-playground__error">{errorMessage}</p>
        ) : null}

        <section
          className="docs-layer-playground__code"
          aria-label="Live post-processing code"
        >
          <div>
            <span>Live code</span>
            <small>Values update with the controls</small>
          </div>
          <pre>
            <code>{snippet}</code>
          </pre>
        </section>

        <div aria-hidden="true" className="docs-layer-playground__progress">
          <span style={{ width: `${progress}%` }} />
        </div>
      </section>
    </main>
  );
}

function TrackingRange({
  label,
  max,
  min,
  onChange,
  step,
  value,
  valueLabel,
}: {
  readonly label: string;
  readonly max: number;
  readonly min: number;
  readonly onChange: (value: number) => void;
  readonly step: number;
  readonly value: number;
  readonly valueLabel: string;
}) {
  return (
    <label className="docs-layer-playground__range">
      <span>
        <strong>{label}</strong>
        <output>{valueLabel}</output>
      </span>
      <input
        max={max}
        min={min}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
        step={step}
        type="range"
        value={value}
      />
    </label>
  );
}

function geometryLabel(geometry: TrackingGeometry) {
  if (geometry === TrackingGeometry.Mask) return "Masks";
  if (geometry === TrackingGeometry.Keypoints) return "Poses";
  return "Boxes + gap predictions";
}
