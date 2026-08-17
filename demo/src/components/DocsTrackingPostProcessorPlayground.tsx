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
  trackedDetectionCount: 0,
};

const RETRACK_DEBOUNCE_MS = 120;

interface TrackingConfiguration {
  readonly geometry: TrackingGeometry;
  readonly lostTrackBuffer: number;
  readonly minimumConsecutiveFrames: number;
  readonly minimumIouThreshold: number;
  readonly trackActivationThreshold: number;
}

type TrackingStatus = "raw" | "running" | "tracked" | "error";

export function DocsTrackingPostProcessorPlayground() {
  const [controller] = useState(createDocsTrackingController);
  const [trackingConfiguration, setTrackingConfiguration] =
    useState<TrackingConfiguration>({
      geometry: TrackingGeometry.Box,
      lostTrackBuffer: 30,
      minimumConsecutiveFrames: 3,
      minimumIouThreshold: 0.3,
      trackActivationThreshold: 0.25,
    });
  const trackingConfigurationRef = useRef(trackingConfiguration);
  const presentationModeRef = useRef<DocsTrackingPresentationMode>("raw");
  const runRequestIdRef = useRef(0);
  const retrackTimeoutRef = useRef<number | undefined>(undefined);
  const statusRef = useRef<TrackingStatus>("raw");
  const [presentationMode, setPresentationMode] =
    useState<DocsTrackingPresentationMode>("raw");
  const [diagnostics, setDiagnostics] = useState(emptyDiagnostics);
  const [processedChunks, setProcessedChunks] = useState(0);
  const [status, setStatus] = useState<TrackingStatus>("raw");
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
        trackingConfigurationRef.current.geometry,
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
  const {
    geometry,
    lostTrackBuffer,
    minimumConsecutiveFrames,
    minimumIouThreshold,
    trackActivationThreshold,
  } = trackingConfiguration;
  const progress = Math.min(
    100,
    totalFrames > 0 ? (diagnostics.processedFrameCount / totalFrames) * 100 : 0,
  );
  const snippet = useMemo(
    () =>
      createDocsTrackingSnippet(
        geometry,
        minimumIouThreshold,
        lostTrackBuffer,
        trackActivationThreshold,
        minimumConsecutiveFrames,
      ),
    [
      geometry,
      lostTrackBuffer,
      minimumConsecutiveFrames,
      minimumIouThreshold,
      trackActivationThreshold,
    ],
  );
  const isPlaying =
    demo.playbackState === MediaRendererPlaybackState.Playing ||
    demo.playbackState === MediaRendererPlaybackState.Buffering;

  const showPresentation = useCallback(
    (mode: DocsTrackingPresentationMode) => {
      presentationModeRef.current = mode;
      setPresentationMode(mode);
      demo.refreshPresentation();
    },
    [demo.refreshPresentation],
  );

  useEffect(
    () => () => {
      runRequestIdRef.current += 1;
      if (retrackTimeoutRef.current !== undefined) {
        window.clearTimeout(retrackTimeoutRef.current);
      }
      controller.destroy?.();
    },
    [controller],
  );

  useEffect(() => {
    demo.refreshPresentation();
  }, [demo.refreshPresentation, geometry]);

  const applyTracking = useCallback(
    (
      configuration: TrackingConfiguration = trackingConfigurationRef.current,
      delayMs = 0,
    ) => {
      const requestId = runRequestIdRef.current + 1;
      runRequestIdRef.current = requestId;
      controller.cancel();
      if (retrackTimeoutRef.current !== undefined) {
        window.clearTimeout(retrackTimeoutRef.current);
        retrackTimeoutRef.current = undefined;
      }

      showPresentation("tracked");
      if (isPlaying && statusRef.current !== "running") {
        demo.onTogglePlayback();
      }
      statusRef.current = "running";
      setStatus("running");
      setErrorMessage(null);
      setProcessedChunks(0);
      setDiagnostics(emptyDiagnostics);
      demo.onSeek(0);

      const run = async () => {
        try {
          await controller.run({
            ...configuration,
            onChunk(chunkIndex) {
              if (requestId !== runRequestIdRef.current) return;
              setProcessedChunks(chunkIndex + 1);
              demo.refreshDetections();
            },
            onDiagnostics(nextDiagnostics) {
              if (requestId === runRequestIdRef.current) {
                setDiagnostics(nextDiagnostics);
              }
            },
          });
          if (requestId !== runRequestIdRef.current) return;
          demo.refreshDetections();
          // Python SORT intentionally leaves the first observations unconfirmed.
          // Land on the first likely confirmed frame so the completed playground
          // does not look empty even though tracking succeeded.
          demo.onSeek((configuration.minimumConsecutiveFrames + 1) / 30);
          statusRef.current = "tracked";
          setStatus("tracked");
        } catch (error) {
          if (requestId !== runRequestIdRef.current) return;
          showPresentation("tracked");
          setErrorMessage(
            error instanceof Error
              ? error.message
              : "Unable to apply tracking.",
          );
          statusRef.current = "error";
          setStatus("error");
        }
      };

      if (delayMs > 0) {
        retrackTimeoutRef.current = window.setTimeout(() => {
          retrackTimeoutRef.current = undefined;
          void run();
        }, delayMs);
      } else {
        void run();
      }
    },
    [controller, demo, isPlaying, showPresentation],
  );

  const updateTrackingConfiguration = useCallback(
    (change: Partial<TrackingConfiguration>) => {
      const nextConfiguration = {
        ...trackingConfigurationRef.current,
        ...change,
      };
      trackingConfigurationRef.current = nextConfiguration;
      setTrackingConfiguration(nextConfiguration);

      if (change.geometry !== undefined) {
        demo.refreshPresentation();
        demo.refreshDetections();
      }

      if (
        presentationModeRef.current === "tracked" ||
        statusRef.current === "running"
      ) {
        applyTracking(nextConfiguration, RETRACK_DEBOUNCE_MS);
      }
    },
    [applyTracking, demo],
  );

  const showRaw = useCallback(() => {
    runRequestIdRef.current += 1;
    if (retrackTimeoutRef.current !== undefined) {
      window.clearTimeout(retrackTimeoutRef.current);
      retrackTimeoutRef.current = undefined;
    }
    controller.showRaw();
    showPresentation("raw");
    statusRef.current = "raw";
    setStatus("raw");
    setErrorMessage(null);
    setProcessedChunks(0);
    setDiagnostics(emptyDiagnostics);
    demo.refreshDetections();
    demo.onSeek(0);
  }, [controller, demo, showPresentation]);

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
        <div aria-live="polite" className="docs-tracking-playground__badge">
          <span>
            {presentationMode === "raw"
              ? "Raw detections"
              : "Tracked detections"}
          </span>
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
          </div>
        </header>

        <div className="docs-layer-playground__controls">
          <label className="docs-layer-playground__select">
            <strong>Annotation</strong>
            <select
              onChange={(event) => {
                const nextGeometry = event.currentTarget
                  .value as TrackingGeometry;
                updateTrackingConfiguration({ geometry: nextGeometry });
              }}
              value={geometry}
            >
              <option value={TrackingGeometry.Box}>Boxes</option>
              <option value={TrackingGeometry.Mask}>Masks</option>
              <option value={TrackingGeometry.Keypoints}>Keypoints</option>
            </select>
          </label>
          <TrackingRange
            label="Minimum IoU"
            max={0.8}
            min={0.05}
            onChange={(value) =>
              updateTrackingConfiguration({ minimumIouThreshold: value })
            }
            step={0.05}
            value={minimumIouThreshold}
            valueLabel={minimumIouThreshold.toFixed(2)}
          />
          <TrackingRange
            label="Lost track buffer"
            max={90}
            min={0}
            onChange={(value) =>
              updateTrackingConfiguration({ lostTrackBuffer: value })
            }
            step={1}
            value={lostTrackBuffer}
            valueLabel={`${lostTrackBuffer}f`}
          />
          <TrackingRange
            label="Activation threshold"
            max={1}
            min={0}
            onChange={(value) =>
              updateTrackingConfiguration({ trackActivationThreshold: value })
            }
            step={0.05}
            value={trackActivationThreshold}
            valueLabel={trackActivationThreshold.toFixed(2)}
          />
          <TrackingRange
            label="Frames to confirm"
            max={8}
            min={1}
            onChange={(value) =>
              updateTrackingConfiguration({ minimumConsecutiveFrames: value })
            }
            step={1}
            value={minimumConsecutiveFrames}
            valueLabel={`${minimumConsecutiveFrames}f`}
          />
          <button
            className={`docs-tracking-playground__mode-button${
              presentationMode === "tracked" && status !== "running"
                ? " docs-tracking-playground__mode-button--secondary"
                : ""
            }`}
            disabled={!demo.canUseRenderer || status === "running"}
            onClick={
              presentationMode === "tracked" ? showRaw : () => applyTracking()
            }
            type="button"
          >
            {status === "running"
              ? "Tracking detections…"
              : presentationMode === "tracked"
                ? "Show raw detections"
                : "Track detections"}
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
