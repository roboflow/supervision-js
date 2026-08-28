import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefCallback,
} from "react";
import {
  MediaRendererPlaybackState,
  type DetectionPickResult,
  type MediaSession,
  type MediaRenderer,
  type MediaRendererState,
  type MediaSessionState,
  type MediaRendererPresentation,
  type MediaRendererSource,
  type MediaSourceState,
  type RenderPreparationDiagnostics,
} from "supervision";
import type { FrameTimelineData } from "supervision-js-web-video-engine";
import {
  createEngineDiagnosticsTap,
  type EngineDiagnosticsTap,
} from "../diagnostics/engine-diagnostics-tap";
import {
  createPresentedFrameTap,
  presentedRateWindowMs,
  type PresentedFrameTap,
} from "../diagnostics/presented-frame-tap";
import {
  samplePresentationDiagnostics,
  type PresentationDiagnosticsSample,
} from "../diagnostics/presentation-diagnostics";
import type {
  DemoFixtureDetectionSourceTransform,
  DemoFixtureFrameTransform,
  DemoFixtureSummary,
} from "../fixtures/demo-fixtures";
import type { PipelineDescriptor } from "../pipeline/pipeline-descriptor";
import { createPipelineRecorder } from "../pipeline/pipeline-recorder";
import {
  clearLiveReadouts,
  publishLiveRenderPreparation,
  publishLiveRendererState,
} from "./live-readouts";
import {
  demoFixtures,
  defaultDemoFixture,
  resolveDemoFixture,
  type DemoFixtureDefinition,
} from "../fixtures/demo-fixtures";
import {
  constrainDemoPresentationSettings,
  createDemoPresentation,
  defaultDemoPresentationSettings,
  demoPresentationDrawsAnnotations,
  type DemoPresentationAvailability,
  type DemoPresentationSettings,
} from "../presentation/demo-presentation";
import { defaultPlaybackRate } from "../session/playback-rate";
import { tapFrameTimeline } from "../session/frame-timeline-source";
import { createFixtureSession } from "../session/fixture-session";
import { DEFAULT_UPLOAD_CLASS_NAMES } from "../session/demo-session-config";
import {
  defaultDemoRenderQuality,
  getDemoMaxDevicePixelRatio,
  type DemoRenderQuality,
} from "../session/render-quality";
import {
  DemoSourceMode,
  type DemoDetectionSourceState,
  type DemoMediaState,
  type UploadInferenceState,
} from "../session/demo-session-types";
import {
  createUploadSession,
  type UploadRunRequest,
} from "../session/upload-session";
import {
  scrubbableDemoSessionOptions,
  type DemoSessionConfiguration,
  type DemoSessionOptions,
} from "../session/session-options";

export { DemoSourceMode };
export type { DemoDetectionSourceState, DemoMediaState, UploadInferenceState };

export interface DemoRendererState {
  readonly canUseRenderer: boolean;
  readonly sessionConfiguration: DemoSessionConfiguration | null;
  readonly sessionOptions: DemoSessionOptions;
  readonly setSessionOptions: (options: DemoSessionOptions) => void;
  readonly detectionSourceState: DemoDetectionSourceState;
  readonly containerRef: RefCallback<HTMLDivElement>;
  readonly duration: number | null;
  readonly errorMessage: string | null;
  readonly fixtureSummary: DemoFixtureSummary | null;
  /**
   * Every real frame of the open source, in presentation order, by the
   * container's own timestamps. Null until a source opens, and again once it
   * closes: a surface holding no table may show a position but never a frame.
   */
  readonly frameTimeline: FrameTimelineData | null;
  readonly hoveredDetectionPick: DetectionPickResult | null;
  readonly mediaState: DemoMediaState;
  readonly playbackRate: number;
  readonly playbackState: MediaRendererPlaybackState | null;
  /** Media seconds the picture covered per wall second, as measured. */
  readonly presentedRate: number | null;
  /** The engine's own diagnostics broadcast, for the parity surface. */
  readonly engineDiagnosticsTap: EngineDiagnosticsTap;
  /**
   * The path this session actually took, stamped as it opened. Null until a
   * session finishes opening, and frozen from then until the next one.
   */
  readonly pipelineDescriptor: PipelineDescriptor | null;
  readonly readPresentationDiagnostics: () => PresentationDiagnosticsSample;
  readonly presentationSettings: DemoPresentationSettings;
  readonly presentationAvailability?: DemoPresentationAvailability;
  readonly renderQuality: DemoRenderQuality;
  readonly rendererState: MediaRendererState | null;
  readonly renderPreparationDiagnostics: RenderPreparationDiagnostics | null;
  readonly selectedDetectionPick: DetectionPickResult | null;
  readonly sampleFixtureId: string;
  readonly sampleFixtures: readonly DemoFixtureDefinition[];
  readonly sourceControlsDisabled: boolean;
  readonly sourceMode: DemoSourceMode;
  readonly sessionState: MediaSessionState | null;
  readonly sourceState: MediaSourceState | null;
  readonly uploadApiKey: string;
  readonly uploadClassNames: string;
  readonly uploadFileName: string | null;
  readonly uploadInferenceState: UploadInferenceState;
  readonly getCurrentTime: () => number;
  readonly onCancelUploadInference: () => void;
  readonly onScrub: (time: number) => void;
  readonly onSeek: (time: number) => Promise<void>;
  readonly onStartUploadInference: () => void;
  readonly onSetPlaybackRate: (rate: number) => void;
  readonly onStepFrame: (direction: 1 | -1) => void;
  readonly onTogglePlayback: () => void;
  readonly onUploadFileChange: (file: File | null) => void;
  readonly onClearSelectedDetection: () => void;
  readonly setPresentationSettings: (
    settings: DemoPresentationSettings,
  ) => void;
  readonly pausePlayback: () => void;
  readonly playPlayback: () => Promise<void>;
  readonly refreshDetections: () => Promise<void>;
  readonly refreshPresentation: () => void;
  readonly reopenSession: () => void;
  readonly setRenderQuality: (quality: DemoRenderQuality) => void;
  readonly setSampleFixtureId: (sampleName: string) => void;
  readonly setSourceMode: (mode: DemoSourceMode) => void;
  readonly setUploadApiKey: (apiKey: string) => void;
  readonly setUploadClassNames: (classNames: string) => void;
}

export interface UseDemoRendererOptions {
  /** Optional docs/demo-only wrap over the fixture's detection source. */
  readonly fixtureDetectionSourceTransform?: DemoFixtureDetectionSourceTransform;
  /** Optional docs/demo-only transformation over loaded fixture frames. */
  readonly fixtureFrameTransform?: DemoFixtureFrameTransform;
  /**
   * Lets focused demo experiences start on a known fixture without first
   * constructing another media session.
   */
  readonly initialFixtureId?: string;
  /** Presentation values applied over that fixture's documented defaults. */
  readonly initialPresentationSettings?: Partial<DemoPresentationSettings>;
  /** Adds focused renderers without widening the general demo settings model. */
  readonly presentationTransform?: (
    presentation: MediaRendererPresentation,
  ) => MediaRendererPresentation;
}

const RENDERER_READOUT_INTERVAL_MS = 250;

const initialDetectionSourceState: DemoDetectionSourceState = {
  datasetId: null,
  errorMessage: null,
  sourceSummary: null,
  status: "loading cold source",
};

const initialUploadInferenceState: UploadInferenceState = {
  completedFrames: 0,
  errorMessage: null,
  inferredDetections: 0,
  preparedMedia: null,
  processedRanges: [],
  processingRanges: [],
  status: "idle",
  statusLabel: "Choose a file, an API key, and prompts",
  totalFrames: 0,
};

export function useDemoRenderer(
  options: UseDemoRendererOptions = {},
): DemoRendererState {
  const [initialFixture] = useState(() =>
    resolveDemoFixture(options.initialFixtureId),
  );
  const [fixtureDetectionSourceTransform] = useState(
    () => options.fixtureDetectionSourceTransform,
  );
  const [fixtureFrameTransform] = useState(() => options.fixtureFrameTransform);
  const [presentationTransform] = useState(() => options.presentationTransform);
  const [initialPresentationSettings] = useState(() =>
    constrainDemoPresentationSettings(
      {
        ...defaultDemoPresentationSettings,
        ...initialFixture.presentationDefaults,
        ...options.initialPresentationSettings,
      },
      initialFixture.presentationAvailability,
    ),
  );
  const [presentedFrameTap] = useState<PresentedFrameTap>(() =>
    createPresentedFrameTap(),
  );
  const [engineDiagnosticsTap] = useState<EngineDiagnosticsTap>(() =>
    createEngineDiagnosticsTap(),
  );
  if (import.meta.env.DEV) {
    (
      globalThis as { __demoEngineDiagnostics?: EngineDiagnosticsTap }
    ).__demoEngineDiagnostics = engineDiagnosticsTap;
  }
  const [frameTimeline, setFrameTimeline] = useState<FrameTimelineData | null>(
    null,
  );
  const tapMediaSource = useCallback(
    (source: MediaRendererSource) =>
      tapFrameTimeline(
        engineDiagnosticsTap.tap(presentedFrameTap.tap(source)),
        setFrameTimeline,
      ),
    [engineDiagnosticsTap, presentedFrameTap],
  );
  /**
   * Never returns to false: the session effect tears the session down whenever
   * it re-runs, and a view-mode switch only takes the viewport off screen.
   */
  const [stageAttached, setStageAttached] = useState(false);
  const [sessionEpoch, setSessionEpoch] = useState(0);
  const [stage] = useState(() =>
    createDemoStage(document.createElement("div"), () => {
      setStageAttached(true);
      // Nothing draws a paused stage: no frame is coming, and putting the
      // canvas back on the page is not a change the scene renders on.
      refreshPresentation();
    }),
  );
  const effectRunRef = useRef(0);
  const rendererRef = useRef<MediaRenderer | null>(null);
  const sessionRef = useRef<MediaSession | null>(null);
  const seekRunRef = useRef(0);
  const rateChangedAtRef = useRef(Number.NEGATIVE_INFINITY);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const uploadFileRef = useRef<File | null>(null);
  /** Where the reopen an option change forces should resume, when it can. */
  const restoreTimeRef = useRef<number | null>(null);
  const presentationSettingsRef = useRef<DemoPresentationSettings>(
    initialPresentationSettings,
  );
  /** The presentation on screen: the settings above plus composed renderers. */
  const presentationRef = useRef<MediaRendererPresentation | null>(null);
  const applyPresentation = useCallback(
    (settings: DemoPresentationSettings) => {
      const base = createDemoPresentation(settings);
      const presentation = presentationTransform?.(base) ?? base;
      presentationRef.current = presentation;
      return presentation;
    },
    [presentationTransform],
  );
  const [rendererState, setRendererState] = useState<MediaRendererState | null>(
    null,
  );
  const [sourceState, setSourceState] = useState<MediaSourceState | null>(null);
  const [presentedRate, setPresentedRate] = useState<number | null>(null);
  const [renderPreparationDiagnostics, setRenderPreparationDiagnostics] =
    useState<RenderPreparationDiagnostics | null>(null);
  const [sessionState, setSessionState] = useState<MediaSessionState | null>(
    null,
  );
  const [fixtureSummary, setFixtureSummary] =
    useState<DemoFixtureSummary | null>(null);
  const [hoveredDetectionPick, setHoveredDetectionPick] =
    useState<DetectionPickResult | null>(null);
  const [selectedDetectionPick, setSelectedDetectionPick] =
    useState<DetectionPickResult | null>(null);
  const [detectionSourceState, setDetectionSourceState] =
    useState<DemoDetectionSourceState>(initialDetectionSourceState);
  const [mediaState, setMediaState] = useState<DemoMediaState>({
    errorMessage: null,
    status: defaultDemoFixture.mediaLoadingStatusLabel,
  });
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [presentationSettings, setPresentationSettingsState] =
    useState<DemoPresentationSettings>(initialPresentationSettings);
  const [renderQuality, setRenderQuality] = useState<DemoRenderQuality>(
    defaultDemoRenderQuality,
  );
  const [sourceMode, setSourceModeState] = useState<DemoSourceMode>(
    DemoSourceMode.Fixture,
  );
  const [sampleFixtureId, setSampleFixtureIdState] = useState(
    initialFixture.sampleName,
  );
  const [uploadApiKey, setUploadApiKey] = useState("");
  const [uploadClassNames, setUploadClassNames] = useState(
    DEFAULT_UPLOAD_CLASS_NAMES,
  );
  const [uploadFileName, setUploadFileName] = useState<string | null>(null);
  const [uploadInferenceState, setUploadInferenceState] =
    useState<UploadInferenceState>(initialUploadInferenceState);
  const [uploadRun, setUploadRun] = useState<
    (UploadRunRequest & { readonly id: number }) | null
  >(null);
  const [sessionOptions, setSessionOptionsState] = useState<DemoSessionOptions>(
    scrubbableDemoSessionOptions,
  );
  const [sessionConfiguration, setSessionConfiguration] =
    useState<DemoSessionConfiguration | null>(null);
  const [pipelineDescriptor, setPipelineDescriptor] =
    useState<PipelineDescriptor | null>(null);
  const activeFixture = resolveDemoFixture(sampleFixtureId);

  const syncRendererState = useCallback((renderer: MediaRenderer) => {
    const state = renderer.getState();

    setRendererState(state);
    setSourceState(state.source);
  }, []);

  useEffect(() => {
    if (!stageAttached) {
      return;
    }

    const container = stage.host;
    const runId = effectRunRef.current + 1;
    effectRunRef.current = runId;
    const pipeline = createPipelineRecorder({ epoch: runId });
    const tapSessionMediaSource = (source: MediaRendererSource) =>
      pipeline.tap(tapMediaSource(source));
    let activeSession: MediaSession | undefined;
    let renderer: MediaRenderer | undefined;
    let lastPlaybackState: MediaRendererPlaybackState | null = null;
    let lastPublishedPlaybackState: MediaRendererPlaybackState | null = null;
    let cleanedUp = false;
    const abortController =
      sourceMode === DemoSourceMode.Upload ? new AbortController() : undefined;
    const isActive = () => !cleanedUp && effectRunRef.current === runId;
    const renderPreparationPublisher = createThrottledPublisher(
      (diagnostics: RenderPreparationDiagnostics) => {
        setRenderPreparationDiagnostics(diagnostics);
        if (import.meta.env.DEV) {
          (
            globalThis as { __demoRenderPrep?: RenderPreparationDiagnostics }
          ).__demoRenderPrep = diagnostics;
        }
      },
      isActive,
      RENDERER_READOUT_INTERVAL_MS,
    );
    const publishRenderPreparation = (
      diagnostics: RenderPreparationDiagnostics,
    ) => {
      if (!isActive()) {
        return;
      }

      publishLiveRenderPreparation(diagnostics);
      renderPreparationPublisher.publish(diagnostics);
    };
    const sessionStatePublisher = createThrottledPublisher(
      (state: MediaSessionState) => {
        setSessionState(state);
        if (import.meta.env.DEV) {
          (
            globalThis as { __demoSessionState?: MediaSessionState }
          ).__demoSessionState = state;
        }
      },
      isActive,
      RENDERER_READOUT_INTERVAL_MS,
    );
    // A window straddling a rate change measures neither rate, and the blend
    // reads as a shortfall the picture is not actually in.
    const readSettledPresentedRate = () =>
      performance.now() - rateChangedAtRef.current >= presentedRateWindowMs
        ? presentedFrameTap.readRate()
        : null;
    const rendererStatePublisher = createThrottledPublisher<MediaRendererState>(
      (state) => {
        setRendererState(state);
        setSourceState(state.source);
        setPresentedRate(readSettledPresentedRate());
      },
      isActive,
      RENDERER_READOUT_INTERVAL_MS,
    );
    // Every emission must eventually reach React: a paused step or seek emits
    // exactly once, and a leading-edge-only throttle that drops it leaves the
    // readouts describing the previous frame until the next emission, which
    // while paused never comes.
    const publishRendererState = (
      state: MediaRendererState,
      options: { readonly force?: boolean } = {},
    ) => {
      if (!isActive()) {
        return;
      }

      publishLiveRendererState(state, readSettledPresentedRate());

      const playbackStateChanged =
        state.playbackState !== lastPublishedPlaybackState;

      lastPublishedPlaybackState = state.playbackState;

      if (options.force || playbackStateChanged) {
        rendererStatePublisher.publishNow(state);
        return;
      }

      rendererStatePublisher.publish(state);
    };
    const onFrame = () => {
      if (!renderer) {
        return;
      }

      publishRendererState(renderer.getState());
    };
    const onRendererState = (state: MediaRendererState) => {
      if (!isActive()) {
        return;
      }

      const wasPlaybackActive =
        lastPlaybackState === MediaRendererPlaybackState.Playing ||
        lastPlaybackState === MediaRendererPlaybackState.Buffering;
      const isPlaybackActive =
        state.playbackState === MediaRendererPlaybackState.Playing ||
        state.playbackState === MediaRendererPlaybackState.Buffering;

      lastPlaybackState = state.playbackState;
      publishRendererState(state);

      if (isPlaybackActive && !wasPlaybackActive) {
        setHoveredDetectionPick(null);
        setSelectedDetectionPick(null);
      }
    };

    if (sourceMode === DemoSourceMode.Upload) {
      uploadAbortRef.current = abortController ?? null;
    }

    resetRendererView(container, sourceMode);

    const presentation = applyPresentation(presentationSettingsRef.current);
    const readPresentation = () => presentationRef.current ?? presentation;

    void (async () => {
      try {
        if (sourceMode === DemoSourceMode.Fixture) {
          const session = await createFixtureSession({
            container,
            definition: activeFixture,
            fixtureDetectionSourceTransform,
            fixtureFrameTransform,
            isActive,
            onDetectionHover: setHoveredDetectionPick,
            onDetectionSelect: setSelectedDetectionPick,
            onDetectionSourceState: setDetectionSourceState,
            onFixtureSummary: setFixtureSummary,
            onFrame,
            onMediaState: setMediaState,
            onRenderPreparationDiagnostics: publishRenderPreparation,
            onRendererState,
            onSessionConfiguration: setSessionConfiguration,
            onSessionState: sessionStatePublisher.publish,
            onSourceState: setSourceState,
            presentation,
            readPresentation,
            renderQuality,
            pipeline,
            sessionOptions,
            tapMediaSource: tapSessionMediaSource,
          });

          activeSession = session;
          renderer = session.renderer;
        } else if (uploadRun) {
          const session = await createUploadSession({
            abortSignal: abortController!.signal,
            container,
            isActive,
            onDetectionHover: setHoveredDetectionPick,
            onDetectionSelect: setSelectedDetectionPick,
            onDetectionSourceState: setDetectionSourceState,
            onFixtureSummary: setFixtureSummary,
            onFrame,
            onMediaState: setMediaState,
            onRenderPreparationDiagnostics: publishRenderPreparation,
            onRendererState,
            onSessionConfiguration: setSessionConfiguration,
            onSessionState: sessionStatePublisher.publish,
            onSourceState: setSourceState,
            onUploadState: setUploadInferenceState,
            presentation,
            pipeline,
            renderQuality,
            sessionOptions,
            tapMediaSource: tapSessionMediaSource,
            uploadRun,
          });

          activeSession = session;
          renderer = session.renderer;
        }

        if (!isActive() || !renderer) {
          if (activeSession) {
            activeSession.destroy();
          } else {
            renderer?.destroy();
          }
          return;
        }

        sessionRef.current = activeSession ?? null;
        rendererRef.current = renderer;
        if (import.meta.env.DEV) {
          (globalThis as { __demoRenderer?: MediaRenderer }).__demoRenderer =
            renderer;
        }
        syncRendererState(renderer);
        // Every stamp has landed by now and none of them moves again, so the
        // diagram is built once and never re-rendered while the picture plays.
        const descriptor = pipeline.seal({
          media: activeSession?.media ?? null,
          rendererState: renderer.getState(),
        });

        setPipelineDescriptor(descriptor);
        if (import.meta.env.DEV) {
          (
            globalThis as { __demoPipeline?: PipelineDescriptor }
          ).__demoPipeline = descriptor;
        }
        await restorePlayhead(renderer, restoreTimeRef);
        await runPlaybackRequest(
          renderer.play(),
          renderer,
          isActive,
          syncRendererState,
          setErrorMessage,
        );
      } catch (error: unknown) {
        if (isActive()) {
          handleSessionError(error, sourceMode);
        }
      }
    })();

    return () => {
      cleanedUp = true;
      pipeline.close();
      clearLiveReadouts();
      renderPreparationPublisher.cancel();
      sessionStatePublisher.cancel();
      rendererStatePublisher.cancel();
      abortController?.abort();
      rendererRef.current = null;
      sessionRef.current = null;
      if (activeSession) {
        activeSession.destroy();
      } else {
        renderer?.destroy();
      }
    };
  }, [
    activeFixture,
    applyPresentation,
    fixtureDetectionSourceTransform,
    fixtureFrameTransform,
    sessionEpoch,
    sessionOptions,
    sourceMode,
    stage,
    stageAttached,
    tapMediaSource,
    syncRendererState,
    uploadRun,
  ]);

  const playbackState = rendererState?.playbackState ?? null;
  const playbackRate = rendererState?.playbackRate ?? defaultPlaybackRate;
  const duration = rendererState?.duration ?? fixtureSummary?.duration ?? null;
  const canUseRenderer =
    !!rendererRef.current &&
    !!rendererState &&
    rendererState.playbackState !== MediaRendererPlaybackState.Destroyed &&
    rendererState.playbackState !== MediaRendererPlaybackState.Error;
  const sourceControlsDisabled =
    uploadInferenceState.status === "preparing" ||
    uploadInferenceState.status === "running";

  const onTogglePlayback = useCallback(() => {
    const renderer = rendererRef.current;

    if (!renderer) {
      return;
    }

    void runPlaybackRequest(
      renderer.togglePlayback(),
      renderer,
      () => rendererRef.current === renderer,
      syncRendererState,
      setErrorMessage,
    );
  }, [syncRendererState]);

  const getCurrentTime = useCallback(
    () => rendererRef.current?.getState().currentTime ?? 0,
    [],
  );

  const playPlayback = useCallback(async () => {
    const renderer = rendererRef.current;

    if (!renderer) {
      return;
    }

    await runPlaybackRequest(
      renderer.play(),
      renderer,
      () => rendererRef.current === renderer,
      syncRendererState,
      setErrorMessage,
    );
  }, [syncRendererState]);

  const pausePlayback = useCallback(() => {
    const renderer = rendererRef.current;

    if (!renderer) {
      return;
    }

    renderer.pause();
    syncRendererState(renderer);
  }, [syncRendererState]);

  const onSeek = useCallback(
    async (time: number) => {
      const renderer = rendererRef.current;

      if (!renderer) {
        return;
      }

      const seekRunId = seekRunRef.current + 1;
      seekRunRef.current = seekRunId;
      setHoveredDetectionPick(null);
      setSelectedDetectionPick(null);

      try {
        await renderer.seek(time);
      } catch (error: unknown) {
        if (seekRunRef.current === seekRunId) {
          setErrorMessage(getErrorMessage(error, "Unable to seek media."));
        }
      } finally {
        if (seekRunRef.current === seekRunId) {
          syncRendererState(renderer);
        }
      }
    },
    [syncRendererState],
  );

  const onScrub = useCallback((time: number) => {
    rendererRef.current?.scrub(time);
  }, []);

  const onSetPlaybackRate = useCallback(
    (rate: number) => {
      const renderer = rendererRef.current;

      if (!renderer || renderer.getState().playbackRate === rate) {
        return;
      }

      renderer.setPlaybackRate(rate);
      rateChangedAtRef.current = performance.now();
      setPresentedRate(null);
      syncRendererState(renderer);
    },
    [syncRendererState],
  );

  const readPresentationDiagnostics = useCallback(
    () =>
      samplePresentationDiagnostics({
        renderer: rendererRef.current,
        tap: presentedFrameTap,
      }),
    [presentedFrameTap],
  );

  const onStepFrame = useCallback(
    (direction: 1 | -1) => {
      const renderer = rendererRef.current;

      if (!renderer) {
        return;
      }

      setHoveredDetectionPick(null);
      setSelectedDetectionPick(null);
      const stepped =
        direction === 1 ? renderer.stepForward() : renderer.stepBackward();

      void stepped
        .then(() => syncRendererState(renderer))
        .catch((error: unknown) => {
          setErrorMessage(getErrorMessage(error, "Unable to step media."));
          syncRendererState(renderer);
        });
    },
    [syncRendererState],
  );

  const onClearSelectedDetection = useCallback(() => {
    const renderer = rendererRef.current;

    if (!renderer) {
      setSelectedDetectionPick(null);
      return;
    }

    renderer.setSelectedDetection(null);
    setSelectedDetectionPick(null);
    syncRendererState(renderer);
  }, [syncRendererState]);

  const setPresentationSettings = useCallback(
    (settings: DemoPresentationSettings) => {
      const constrainedSettings = constrainDemoPresentationSettings(
        settings,
        sourceMode === DemoSourceMode.Fixture
          ? activeFixture.presentationAvailability
          : undefined,
      );

      const drewAnnotations = Boolean(
        presentationRef.current &&
        demoPresentationDrawsAnnotations(presentationRef.current),
      );

      presentationSettingsRef.current = constrainedSettings;
      setPresentationSettingsState(constrainedSettings);

      const renderer = rendererRef.current;
      if (!renderer) {
        return;
      }

      const presentation = applyPresentation(constrainedSettings);
      renderer.setPresentation(presentation);

      // Detections stop loading while no layer draws them, and a paused
      // playhead never asks again on its own, so the first layer switched back
      // on would otherwise annotate nothing until playback resumed.
      if (!drewAnnotations && demoPresentationDrawsAnnotations(presentation)) {
        void renderer.refresh();
      }

      syncRendererState(renderer);
    },
    [
      activeFixture.presentationAvailability,
      applyPresentation,
      sourceMode,
      syncRendererState,
    ],
  );

  const refreshDetections = useCallback(async () => {
    const session = sessionRef.current;

    if (!session) {
      return;
    }

    try {
      await session.refresh();
    } catch (error: unknown) {
      setErrorMessage(getErrorMessage(error, "Unable to refresh detections."));
    } finally {
      syncRendererState(session.renderer);
    }
  }, [syncRendererState]);

  const reopenSession = useCallback(() => {
    setSessionEpoch((current) => current + 1);
  }, []);

  const refreshPresentation = useCallback(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.setPresentation(
      applyPresentation(presentationSettingsRef.current),
    );
    syncRendererState(renderer);
  }, [applyPresentation, syncRendererState]);

  const setRenderQualityLive = useCallback(
    (quality: DemoRenderQuality) => {
      setRenderQuality(quality);

      const session = sessionRef.current;
      if (!session) {
        return;
      }

      session.setRenderQuality({
        maxDevicePixelRatio: getDemoMaxDevicePixelRatio(quality),
      });
      syncRendererState(session.renderer);
    },
    [syncRendererState],
  );

  const setSessionOptions = useCallback((options: DemoSessionOptions) => {
    restoreTimeRef.current = keepsPlayhead(options)
      ? readRestorableTime(rendererRef.current)
      : null;
    setSessionOptionsState(options);
  }, []);

  const setSourceMode = useCallback((mode: DemoSourceMode) => {
    restoreTimeRef.current = null;

    if (mode === DemoSourceMode.Fixture) {
      uploadAbortRef.current?.abort();
      setUploadRun(null);
      setUploadInferenceState(initialUploadInferenceState);
    }

    setSourceModeState(mode);
  }, []);

  const setSampleFixtureId = useCallback((sampleName: string) => {
    restoreTimeRef.current = null;
    uploadAbortRef.current?.abort();
    setUploadRun(null);
    setUploadInferenceState(initialUploadInferenceState);
    const fixture =
      demoFixtures.find((candidate) => candidate.sampleName === sampleName) ??
      defaultDemoFixture;
    const nextPresentationSettings = constrainDemoPresentationSettings(
      {
        ...defaultDemoPresentationSettings,
        ...fixture.presentationDefaults,
      },
      fixture.presentationAvailability,
    );

    presentationSettingsRef.current = nextPresentationSettings;
    setPresentationSettingsState(nextPresentationSettings);
    setSampleFixtureIdState(sampleName);
    setSourceModeState(DemoSourceMode.Fixture);
  }, []);

  const onUploadFileChange = useCallback((file: File | null) => {
    uploadFileRef.current = file;
    setUploadFileName(file?.name ?? null);
    setUploadInferenceState(initialUploadInferenceState);
  }, []);

  const onStartUploadInference = useCallback(() => {
    const file = uploadFileRef.current;
    const classNames = parseClassNames(uploadClassNames);
    const trimmedApiKey = uploadApiKey.trim();

    if (!file) {
      setUploadInferenceState(createUploadErrorState("Choose a media file."));
      return;
    }

    if (!trimmedApiKey) {
      setUploadInferenceState(
        createUploadErrorState("Enter a Roboflow API key."),
      );
      return;
    }

    if (classNames.length === 0) {
      setUploadInferenceState(
        createUploadErrorState("Enter at least one class name or prompt."),
      );
      return;
    }

    setSourceModeState(DemoSourceMode.Upload);
    setUploadInferenceState({
      ...initialUploadInferenceState,
      status: "preparing",
      statusLabel: "Opening media",
    });
    setUploadRun({
      apiKey: trimmedApiKey,
      classNames,
      file,
      id: Date.now(),
    });
  }, [uploadApiKey, uploadClassNames]);

  const onCancelUploadInference = useCallback(() => {
    uploadAbortRef.current?.abort();
    setUploadInferenceState((current) => ({
      ...current,
      status: "idle",
      statusLabel: "Model run canceled",
    }));
  }, []);

  function resetRendererView(
    container: HTMLDivElement,
    nextSourceMode: DemoSourceMode,
  ) {
    container.replaceChildren();
    presentedFrameTap.reset();
    rendererRef.current = null;
    setDetectionSourceState(initialDetectionSourceState);
    setErrorMessage(null);
    setFixtureSummary(null);
    setFrameTimeline(null);
    setHoveredDetectionPick(null);
    setMediaState({
      errorMessage: null,
      status:
        nextSourceMode === DemoSourceMode.Fixture
          ? activeFixture.mediaLoadingStatusLabel
          : "Nothing loaded yet",
    });
    setPresentedRate(null);
    setRendererState(null);
    setRenderPreparationDiagnostics(null);
    setSelectedDetectionPick(null);
    setSessionState(null);
    setSourceState(null);
  }

  function handleSessionError(error: unknown, nextSourceMode: DemoSourceMode) {
    const message = getErrorMessage(
      error,
      "Unable to start the media renderer.",
    );

    setErrorMessage(message);
    setDetectionSourceState((current) =>
      current.sourceSummary
        ? current
        : {
            ...current,
            errorMessage: message,
            status: "error",
          },
    );
    if (nextSourceMode === DemoSourceMode.Upload) {
      setUploadInferenceState((current) => ({
        ...current,
        errorMessage: message,
        status: "error",
        statusLabel: message,
      }));
    }
  }

  return {
    canUseRenderer,
    containerRef: stage.attach,
    detectionSourceState,
    duration,
    errorMessage,
    fixtureSummary,
    frameTimeline,
    hoveredDetectionPick,
    mediaState,
    onCancelUploadInference,
    onClearSelectedDetection,
    onScrub,
    onSeek,
    onSetPlaybackRate,
    onStartUploadInference,
    onStepFrame,
    onTogglePlayback,
    onUploadFileChange,
    playbackRate,
    playbackState,
    presentationSettings,
    engineDiagnosticsTap,
    pipelineDescriptor,
    presentedRate,
    readPresentationDiagnostics,
    getCurrentTime,
    pausePlayback,
    playPlayback,
    refreshDetections,
    refreshPresentation,
    reopenSession,
    presentationAvailability:
      sourceMode === DemoSourceMode.Fixture
        ? activeFixture.presentationAvailability
        : undefined,
    renderPreparationDiagnostics,
    renderQuality,
    rendererState,
    sampleFixtureId,
    sampleFixtures: demoFixtures,
    selectedDetectionPick,
    sessionConfiguration,
    sessionOptions,
    setSampleFixtureId,
    setPresentationSettings,
    setRenderQuality: setRenderQualityLive,
    setSessionOptions,
    setSourceMode,
    setUploadApiKey,
    setUploadClassNames,
    sessionState,
    sourceControlsDisabled,
    sourceMode,
    sourceState,
    uploadApiKey,
    uploadClassNames,
    uploadFileName,
    uploadInferenceState,
  };
}

/**
 * The element the media session draws into. A view-mode switch unmounts the
 * viewport, and the session, its warm decoder and any inference run in flight
 * stay bound to this element, which moves to whichever mount is on screen.
 */
export function createDemoStage(host: HTMLDivElement, onAttached: () => void) {
  host.style.height = "100%";
  host.style.width = "100%";

  return {
    host,
    attach(mount: HTMLDivElement | null) {
      mount?.appendChild(host);
      onAttached();
      return () => host.remove();
    },
  };
}

function createThrottledPublisher<Value>(
  publishValue: (value: Value) => void,
  isActive: () => boolean,
  intervalMs: number,
) {
  let lastPublishedAt = Number.NEGATIVE_INFINITY;
  let pendingValue: Value | undefined;
  let timeoutHandle: number | undefined;

  const clearPendingTimeout = () => {
    if (timeoutHandle === undefined) {
      return;
    }

    window.clearTimeout(timeoutHandle);
    timeoutHandle = undefined;
  };

  const publishPendingValue = () => {
    clearPendingTimeout();

    if (!isActive() || pendingValue === undefined) {
      return;
    }

    const nextValue = pendingValue;

    pendingValue = undefined;
    lastPublishedAt = performance.now();
    publishValue(nextValue);
  };

  return {
    cancel() {
      clearPendingTimeout();
      pendingValue = undefined;
    },
    publish(value: Value) {
      pendingValue = value;

      const elapsedMs = performance.now() - lastPublishedAt;

      if (elapsedMs >= intervalMs) {
        publishPendingValue();
        return;
      }

      if (timeoutHandle !== undefined) {
        return;
      }

      timeoutHandle = window.setTimeout(
        publishPendingValue,
        intervalMs - elapsedMs,
      );
    },
    publishNow(value: Value) {
      pendingValue = value;
      publishPendingValue();
    },
  };
}

/**
 * Progressive normalization opens on output that has only been produced from
 * the start of the clip, so a reopen into it has nowhere to resume to.
 */
function keepsPlayhead(options: DemoSessionOptions) {
  return options.normalize !== true || options.normalizeStream !== true;
}

function readRestorableTime(renderer: MediaRenderer | null) {
  const currentTime = renderer?.getState().currentTime;

  return typeof currentTime === "number" && currentTime > 0
    ? currentTime
    : null;
}

async function restorePlayhead(
  renderer: MediaRenderer,
  restoreTimeRef: { current: number | null },
) {
  const restoreTime = restoreTimeRef.current;

  restoreTimeRef.current = null;

  if (restoreTime === null) {
    return;
  }

  await renderer.seek(restoreTime).catch(() => undefined);
}

/** Says why a playback request the viewer made failed, and settles the readout
 *  however it went. */
async function runPlaybackRequest(
  request: Promise<void>,
  renderer: MediaRenderer,
  isActive: () => boolean,
  syncRendererState: (renderer: MediaRenderer) => void,
  setErrorMessage: (message: string) => void,
) {
  try {
    await request;
  } catch (error: unknown) {
    if (isActive()) {
      setErrorMessage(
        getErrorMessage(error, "Unable to play the media renderer."),
      );
    }
  }

  if (isActive()) {
    syncRendererState(renderer);
  }
}

function createUploadErrorState(message: string): UploadInferenceState {
  return {
    ...initialUploadInferenceState,
    errorMessage: message,
    status: "error",
    statusLabel: message,
  };
}

function parseClassNames(value: string) {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
