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
  type MediaSourceState,
  type RenderPreparationDiagnostics,
} from "supervision-js";
import type { Sam3FixtureSummary } from "../fixtures/sam3-fixtures";
import {
  sam3Fixtures,
  defaultSam3Fixture,
  type Sam3FixtureDefinition,
} from "../fixtures/sam3-fixtures";
import {
  createDemoPresentation,
  defaultDemoPresentationSettings,
  type DemoPresentationSettings,
} from "../presentation/demo-presentation";
import { createFixtureSession } from "../session/fixture-session";
import { DEFAULT_UPLOAD_CLASS_NAMES } from "../session/demo-session-config";
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
  readonly fixtureSummary: Sam3FixtureSummary | null;
  readonly hoveredDetectionPick: DetectionPickResult | null;
  readonly mediaState: DemoMediaState;
  readonly playbackState: MediaRendererPlaybackState | null;
  readonly presentationSettings: DemoPresentationSettings;
  readonly rendererState: MediaRendererState | null;
  readonly renderPreparationDiagnostics: RenderPreparationDiagnostics | null;
  readonly selectedDetectionPick: DetectionPickResult | null;
  readonly sampleFixtureId: string;
  readonly sampleFixtures: readonly Sam3FixtureDefinition[];
  readonly sourceControlsDisabled: boolean;
  readonly sourceMode: DemoSourceMode;
  readonly sessionState: MediaSessionState | null;
  readonly sourceState: MediaSourceState | null;
  readonly uploadApiKey: string;
  readonly uploadClassNames: string;
  readonly uploadFileName: string | null;
  readonly uploadInferenceState: UploadInferenceState;
  readonly onCancelUploadInference: () => void;
  readonly onSeek: (time: number) => void;
  readonly onStartUploadInference: () => void;
  readonly onStepFrame: (frameDelta: number) => void;
  readonly onTogglePlayback: () => void;
  readonly onUploadFileChange: (file: File | null) => void;
  readonly setPresentationSettings: (
    settings: DemoPresentationSettings,
  ) => void;
  readonly setSampleFixtureId: (sampleName: string) => void;
  readonly setSourceMode: (mode: DemoSourceMode) => void;
  readonly setUploadApiKey: (apiKey: string) => void;
  readonly setUploadClassNames: (classNames: string) => void;
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

export function useDemoRenderer(): DemoRendererState {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const effectRunRef = useRef(0);
  const rendererRef = useRef<MediaRenderer | null>(null);
  const seekRunRef = useRef(0);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const uploadFileRef = useRef<File | null>(null);
  const presentationSettingsRef = useRef<DemoPresentationSettings>(
    defaultDemoPresentationSettings,
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
    useState<Sam3FixtureSummary | null>(null);
  const [hoveredDetectionPick, setHoveredDetectionPick] =
    useState<DetectionPickResult | null>(null);
  const [selectedDetectionPick, setSelectedDetectionPick] =
    useState<DetectionPickResult | null>(null);
  const [detectionSourceState, setDetectionSourceState] =
    useState<DemoDetectionSourceState>(initialDetectionSourceState);
  const [mediaState, setMediaState] = useState<DemoMediaState>({
    errorMessage: null,
    status: defaultSam3Fixture.mediaLoadingStatusLabel,
  });
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [presentationSettings, setPresentationSettingsState] =
    useState<DemoPresentationSettings>(defaultDemoPresentationSettings);
  const [sourceMode, setSourceModeState] = useState<DemoSourceMode>(
    DemoSourceMode.Fixture,
  );
  const [sampleFixtureId, setSampleFixtureIdState] = useState(
    defaultSam3Fixture.sampleName,
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
  const activeFixture =
    sam3Fixtures.find((fixture) => fixture.sampleName === sampleFixtureId) ??
    defaultSam3Fixture;

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

    void (async () => {
      try {
        if (sourceMode === DemoSourceMode.Fixture) {
          const session = await createFixtureSession({
            container,
            definition: activeFixture,
            isActive,
            onDetectionHover: setHoveredDetectionPick,
            onDetectionSelect: setSelectedDetectionPick,
            onDetectionSourceState: setDetectionSourceState,
            onFixtureSummary: setFixtureSummary,
            onFrame,
            onMediaState: setMediaState,
            onRenderPreparationDiagnostics: setRenderPreparationDiagnostics,
            onRendererState,
            onSessionState: setSessionState,
            onSourceState: setSourceState,
            presentationSettings: presentationSettingsRef.current,
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
            onRenderPreparationDiagnostics: setRenderPreparationDiagnostics,
            onRendererState,
            onSessionState: setSessionState,
            onSourceState: setSourceState,
            onUploadState: setUploadInferenceState,
            presentationSettings: presentationSettingsRef.current,
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
      abortController?.abort();
      rendererRef.current = null;
      if (activeSession) {
        activeSession.destroy();
      } else {
        renderer?.destroy();
      }
    };
  }, [activeFixture, sourceMode, syncRendererState, uploadRun]);

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

  const onTogglePlayback = useCallback(() => {
    const renderer = rendererRef.current;

    if (!renderer) {
      return;
    }

    const playbackState = renderer.getState().playbackState;

    if (
      playbackState === MediaRendererPlaybackState.Playing ||
      playbackState === MediaRendererPlaybackState.Buffering
    ) {
      renderer.pause();
      syncRendererState(renderer);
      return;
    }

    void renderer
      .play()
      .then(() => syncRendererState(renderer))
      .catch((error: unknown) => {
        setErrorMessage(
          getErrorMessage(error, "Unable to toggle media playback."),
        );
        syncRendererState(renderer);
      });
  }, [syncRendererState]);

  const onSeek = useCallback(
    (time: number) => {
      const renderer = rendererRef.current;

      if (!renderer) {
        return;
      }

      const seekRunId = seekRunRef.current + 1;
      seekRunRef.current = seekRunId;
      setHoveredDetectionPick(null);
      setSelectedDetectionPick(null);
      void renderer
        .seek(time)
        .then(() => {
          if (seekRunRef.current === seekRunId) {
            syncRendererState(renderer);
          }
        })
        .catch((error: unknown) => {
          if (seekRunRef.current === seekRunId) {
            setErrorMessage(getErrorMessage(error, "Unable to seek media."));
            syncRendererState(renderer);
          }
        });
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

  const setPresentationSettings = useCallback(
    (settings: DemoPresentationSettings) => {
      presentationSettingsRef.current = settings;
      setPresentationSettingsState(settings);

      const renderer = rendererRef.current;
      if (!renderer) {
        return;
      }

      renderer.setPresentation(createDemoPresentation(settings));
      syncRendererState(renderer);
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
    hoveredDetectionPick,
    mediaState,
    onCancelUploadInference,
    onSeek,
    onStartUploadInference,
    onStepFrame,
    onTogglePlayback,
    onUploadFileChange,
    playbackState,
    presentationSettings,
    renderPreparationDiagnostics,
    rendererState,
    sampleFixtureId,
    sampleFixtures: sam3Fixtures,
    selectedDetectionPick,
    setSampleFixtureId,
    setPresentationSettings,
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
