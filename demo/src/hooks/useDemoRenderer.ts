import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  MediaRendererPlaybackState,
  type DetectionPickResult,
  type MediaSession,
  type MediaRenderer,
  type MediaRendererState,
  type MediaSessionState,
  type MediaRendererPresentation,
  type MediaSourceState,
  type RenderPreparationDiagnostics,
} from "supervision";
import type {
  DemoFixtureFrameTransform,
  DemoFixtureDetectionSourceTransform,
  DemoFixtureSummary,
} from "../fixtures/demo-fixtures";
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
  type DemoPresentationAvailability,
  type DemoPresentationSettings,
} from "../presentation/demo-presentation";
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

export { DemoSourceMode };
export type { DemoDetectionSourceState, DemoMediaState, UploadInferenceState };

export interface DemoRendererState {
  readonly canUseRenderer: boolean;
  readonly detectionSourceState: DemoDetectionSourceState;
  readonly containerRef: RefObject<HTMLDivElement | null>;
  readonly duration: number | null;
  readonly errorMessage: string | null;
  readonly fixtureSummary: DemoFixtureSummary | null;
  readonly hoveredDetectionPick: DetectionPickResult | null;
  readonly mediaState: DemoMediaState;
  readonly playbackState: MediaRendererPlaybackState | null;
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
  readonly onSeek: (time: number) => Promise<void>;
  readonly onStartUploadInference: () => void;
  readonly onStepFrame: (frameDelta: number) => void;
  readonly onTogglePlayback: () => Promise<void>;
  readonly onUploadFileChange: (file: File | null) => void;
  readonly onClearSelectedDetection: () => void;
  readonly pausePlayback: () => void;
  readonly playPlayback: () => Promise<void>;
  readonly setPresentationSettings: (
    settings: DemoPresentationSettings,
  ) => void;
  readonly refreshPresentation: () => void;
  readonly refreshDetections: () => Promise<void>;
  readonly setRenderQuality: (quality: DemoRenderQuality) => void;
  readonly setSampleFixtureId: (sampleName: string) => void;
  readonly setSourceMode: (mode: DemoSourceMode) => void;
  readonly setUploadApiKey: (apiKey: string) => void;
  readonly setUploadClassNames: (classNames: string) => void;
}

export interface UseDemoRendererOptions {
  /** Optional docs/demo-only transformation over loaded fixture frames. */
  readonly fixtureFrameTransform?: DemoFixtureFrameTransform;
  /** Optional docs/demo-only source wrapper, such as a post-processor view. */
  readonly fixtureDetectionSourceTransform?: DemoFixtureDetectionSourceTransform;
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
  normalizedRanges: [],
  preparedMedia: null,
  processedRanges: [],
  processingRanges: [],
  status: "idle",
  statusLabel: "choose media, API key, and prompts",
  totalFrames: 0,
};

export function useDemoRenderer(
  options: UseDemoRendererOptions = {},
): DemoRendererState {
  const [initialFixture] = useState(() =>
    resolveDemoFixture(options.initialFixtureId),
  );
  const [fixtureFrameTransform] = useState(() => options.fixtureFrameTransform);
  const [fixtureDetectionSourceTransform] = useState(
    () => options.fixtureDetectionSourceTransform,
  );
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
  const containerRef = useRef<HTMLDivElement | null>(null);
  const effectRunRef = useRef(0);
  const rendererRef = useRef<MediaRenderer | null>(null);
  const sessionRef = useRef<MediaSession | null>(null);
  const seekRunRef = useRef(0);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const uploadFileRef = useRef<File | null>(null);
  const presentationSettingsRef = useRef<DemoPresentationSettings>(
    initialPresentationSettings,
  );
  const [rendererState, setRendererState] = useState<MediaRendererState | null>(
    null,
  );
  const [sourceState, setSourceState] = useState<MediaSourceState | null>(null);
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
  const activeFixture = resolveDemoFixture(sampleFixtureId);

  const syncRendererState = useCallback((renderer: MediaRenderer) => {
    const state = renderer.getState();

    setRendererState(state);
    setSourceState(state.source);
  }, []);

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    const runId = effectRunRef.current + 1;
    effectRunRef.current = runId;
    let activeSession: MediaSession | undefined;
    let renderer: MediaRenderer | undefined;
    let lastReadoutAt = 0;
    let lastPlaybackState: MediaRendererPlaybackState | null = null;
    let lastPublishedPlaybackState: MediaRendererPlaybackState | null = null;
    let cleanedUp = false;
    const abortController =
      sourceMode === DemoSourceMode.Upload ? new AbortController() : undefined;
    const isActive = () => !cleanedUp && effectRunRef.current === runId;
    const renderPreparationPublisher = createThrottledPublisher(
      setRenderPreparationDiagnostics,
      isActive,
      RENDERER_READOUT_INTERVAL_MS,
    );
    const sessionStatePublisher = createThrottledPublisher(
      setSessionState,
      isActive,
      RENDERER_READOUT_INTERVAL_MS,
    );
    const publishRendererState = (
      state: MediaRendererState,
      options: { readonly force?: boolean } = {},
    ) => {
      const now = performance.now();
      const playbackStateChanged =
        state.playbackState !== lastPublishedPlaybackState;

      if (
        !isActive() ||
        (!options.force &&
          !playbackStateChanged &&
          now - lastReadoutAt < RENDERER_READOUT_INTERVAL_MS)
      ) {
        return;
      }

      lastReadoutAt = now;
      lastPublishedPlaybackState = state.playbackState;
      setRendererState(state);
      setSourceState(state.source);
    };
    const onFrame = () => {
      if (
        !renderer ||
        performance.now() - lastReadoutAt < RENDERER_READOUT_INTERVAL_MS
      ) {
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

    void (async () => {
      try {
        if (sourceMode === DemoSourceMode.Fixture) {
          const session = await createFixtureSession({
            container,
            definition: activeFixture,
            fixtureFrameTransform,
            fixtureDetectionSourceTransform,
            isActive,
            onDetectionHover: setHoveredDetectionPick,
            onDetectionSelect: setSelectedDetectionPick,
            onDetectionSourceState: setDetectionSourceState,
            onFixtureSummary: setFixtureSummary,
            onFrame,
            onMediaState: setMediaState,
            onRenderPreparationDiagnostics: renderPreparationPublisher.publish,
            onRendererState,
            onSessionState: sessionStatePublisher.publish,
            onSourceState: setSourceState,
            presentationSettings: presentationSettingsRef.current,
            presentationTransform,
            renderQuality,
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
            onRenderPreparationDiagnostics: renderPreparationPublisher.publish,
            onRendererState,
            onSessionState: sessionStatePublisher.publish,
            onSourceState: setSourceState,
            onUploadState: setUploadInferenceState,
            presentationSettings: presentationSettingsRef.current,
            renderQuality,
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
        syncRendererState(renderer);
        await playRenderer(
          renderer,
          isActive,
          setErrorMessage,
          syncRendererState,
        );
      } catch (error: unknown) {
        if (isActive()) {
          handleSessionError(error, sourceMode);
        }
      }
    })();

    return () => {
      cleanedUp = true;
      renderPreparationPublisher.cancel();
      sessionStatePublisher.cancel();
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
    fixtureFrameTransform,
    fixtureDetectionSourceTransform,
    presentationTransform,
    sourceMode,
    syncRendererState,
    uploadRun,
  ]);

  const playbackState = rendererState?.playbackState ?? null;
  const duration = rendererState?.duration ?? fixtureSummary?.duration ?? null;
  const canUseRenderer =
    !!rendererRef.current &&
    !!rendererState &&
    rendererState.playbackState !== MediaRendererPlaybackState.Destroyed &&
    rendererState.playbackState !== MediaRendererPlaybackState.Error;
  const sourceControlsDisabled =
    uploadInferenceState.status === "preparing" ||
    uploadInferenceState.status === "running";

  const getCurrentTime = useCallback(
    () => rendererRef.current?.getState().currentTime ?? 0,
    [],
  );

  const pausePlayback = useCallback(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.pause();
    syncRendererState(renderer);
  }, [syncRendererState]);

  const playPlayback = useCallback(async () => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const playbackState = renderer.getState().playbackState;
    if (
      playbackState === MediaRendererPlaybackState.Playing ||
      playbackState === MediaRendererPlaybackState.Buffering
    ) {
      return;
    }

    try {
      await renderer.play();
    } catch (error: unknown) {
      setErrorMessage(
        getErrorMessage(error, "Unable to start media playback."),
      );
    } finally {
      syncRendererState(renderer);
    }
  }, [syncRendererState]);

  const onTogglePlayback = useCallback(async () => {
    const renderer = rendererRef.current;

    if (!renderer) {
      return;
    }

    const playbackState = renderer.getState().playbackState;

    if (
      playbackState === MediaRendererPlaybackState.Playing ||
      playbackState === MediaRendererPlaybackState.Buffering
    ) {
      pausePlayback();
      return;
    }

    await playPlayback();
  }, [pausePlayback, playPlayback]);

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

  const onStepFrame = useCallback(
    (frameDelta: number) => {
      const renderer = rendererRef.current;

      if (!renderer) {
        return;
      }

      const state = renderer.getState();
      const frameRate = fixtureSummary?.inferenceFrameRate ?? 30;
      const currentFrameIndex =
        state.activeDetectionFrameIndex ??
        Math.round(Math.max(0, state.currentTime) * frameRate);
      const duration = state.duration ?? fixtureSummary?.duration ?? null;
      const targetTime = Math.max(
        0,
        Math.min(
          (currentFrameIndex + frameDelta) / frameRate,
          duration ?? Number.POSITIVE_INFINITY,
        ),
      );

      onSeek(targetTime);
    },
    [fixtureSummary, onSeek],
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

      presentationSettingsRef.current = constrainedSettings;
      setPresentationSettingsState(constrainedSettings);

      const renderer = rendererRef.current;
      if (!renderer) {
        return;
      }

      const presentation = createDemoPresentation(constrainedSettings);
      renderer.setPresentation(
        presentationTransform?.(presentation) ?? presentation,
      );
      syncRendererState(renderer);
    },
    [
      activeFixture.presentationAvailability,
      presentationTransform,
      sourceMode,
      syncRendererState,
    ],
  );

  const refreshPresentation = useCallback(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const presentation = createDemoPresentation(
      presentationSettingsRef.current,
    );
    renderer.setPresentation(
      presentationTransform?.(presentation) ?? presentation,
    );
    syncRendererState(renderer);
  }, [presentationTransform, syncRendererState]);

  const refreshDetections = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return;
    try {
      await session.refresh();
    } catch (error: unknown) {
      setErrorMessage(getErrorMessage(error, "Unable to refresh detections."));
    } finally {
      syncRendererState(session.renderer);
    }
  }, [syncRendererState]);

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

  const setSourceMode = useCallback((mode: DemoSourceMode) => {
    if (mode === DemoSourceMode.Fixture) {
      uploadAbortRef.current?.abort();
      setUploadRun(null);
      setUploadInferenceState(initialUploadInferenceState);
    }

    setSourceModeState(mode);
  }, []);

  const setSampleFixtureId = useCallback((sampleName: string) => {
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
      statusLabel: "preparing uploaded media",
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
      statusLabel: "upload inference canceled",
    }));
  }, []);

  function resetRendererView(
    container: HTMLDivElement,
    nextSourceMode: DemoSourceMode,
  ) {
    container.replaceChildren();
    rendererRef.current = null;
    setDetectionSourceState(initialDetectionSourceState);
    setErrorMessage(null);
    setFixtureSummary(null);
    setHoveredDetectionPick(null);
    setMediaState({
      errorMessage: null,
      status:
        nextSourceMode === DemoSourceMode.Fixture
          ? activeFixture.mediaLoadingStatusLabel
          : "waiting for upload inference",
    });
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
    containerRef,
    detectionSourceState,
    duration,
    errorMessage,
    fixtureSummary,
    getCurrentTime,
    hoveredDetectionPick,
    mediaState,
    onCancelUploadInference,
    onClearSelectedDetection,
    onSeek,
    onStartUploadInference,
    onStepFrame,
    onTogglePlayback,
    onUploadFileChange,
    pausePlayback,
    playbackState,
    playPlayback,
    presentationSettings,
    refreshPresentation,
    refreshDetections,
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
    setSampleFixtureId,
    setPresentationSettings,
    setRenderQuality: setRenderQualityLive,
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
  };
}

async function playRenderer(
  renderer: MediaRenderer,
  isActive: () => boolean,
  setErrorMessage: (message: string) => void,
  syncRendererState: (renderer: MediaRenderer) => void,
) {
  try {
    await renderer.play();
    if (isActive()) {
      syncRendererState(renderer);
    }
  } catch (error: unknown) {
    if (isActive()) {
      syncRendererState(renderer);
      setErrorMessage(
        getErrorMessage(error, "Unable to play the media renderer."),
      );
    }
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
