import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  MediaRendererPlaybackState,
  type MediaSession,
  type MediaRenderer,
  type MediaRendererState,
  type MediaSourceState,
  type RenderPreparationDiagnostics,
} from "supervision-js";
import type { BasketballSampleSummary } from "../fixtures/basketball-sample";
import { defaultBasketballSampleFixture } from "../fixtures/basketball-sample";
import {
  createBasketballSamplePresentation,
  defaultBasketballPresentationSettings,
  type BasketballPresentationSettings,
} from "../presentation/basketball-presentation";
import { createBasketballSession } from "../session/basketball-session";
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

export interface BasketballDemoRendererState {
  readonly canUseRenderer: boolean;
  readonly detectionSourceState: DemoDetectionSourceState;
  readonly containerRef: RefObject<HTMLDivElement | null>;
  readonly duration: number | null;
  readonly errorMessage: string | null;
  readonly fixtureSummary: BasketballSampleSummary | null;
  readonly mediaState: DemoMediaState;
  readonly playbackState: MediaRendererPlaybackState | null;
  readonly presentationSettings: BasketballPresentationSettings;
  readonly rendererState: MediaRendererState | null;
  readonly renderPreparationDiagnostics: RenderPreparationDiagnostics | null;
  readonly sourceControlsDisabled: boolean;
  readonly sourceMode: DemoSourceMode;
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
    settings: BasketballPresentationSettings,
  ) => void;
  readonly setSourceMode: (mode: DemoSourceMode) => void;
  readonly setUploadApiKey: (apiKey: string) => void;
  readonly setUploadClassNames: (classNames: string) => void;
}

const activeBasketballFixture = defaultBasketballSampleFixture;

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

export function useBasketballDemoRenderer(): BasketballDemoRendererState {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const effectRunRef = useRef(0);
  const rendererRef = useRef<MediaRenderer | null>(null);
  const seekRunRef = useRef(0);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const uploadFileRef = useRef<File | null>(null);
  const presentationSettingsRef = useRef<BasketballPresentationSettings>(
    defaultBasketballPresentationSettings,
  );
  const [rendererState, setRendererState] = useState<MediaRendererState | null>(
    null,
  );
  const [sourceState, setSourceState] = useState<MediaSourceState | null>(null);
  const [renderPreparationDiagnostics, setRenderPreparationDiagnostics] =
    useState<RenderPreparationDiagnostics | null>(null);
  const [fixtureSummary, setFixtureSummary] =
    useState<BasketballSampleSummary | null>(null);
  const [detectionSourceState, setDetectionSourceState] =
    useState<DemoDetectionSourceState>(initialDetectionSourceState);
  const [mediaState, setMediaState] = useState<DemoMediaState>({
    errorMessage: null,
    status: activeBasketballFixture.mediaLoadingStatusLabel,
  });
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [presentationSettings, setPresentationSettingsState] =
    useState<BasketballPresentationSettings>(
      defaultBasketballPresentationSettings,
    );
  const [sourceMode, setSourceModeState] = useState<DemoSourceMode>(
    DemoSourceMode.Basketball,
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
    let cleanedUp = false;
    const abortController =
      sourceMode === DemoSourceMode.Upload ? new AbortController() : undefined;
    const isActive = () => !cleanedUp && effectRunRef.current === runId;
    const onFrame = () => {
      const now = performance.now();

      if (!isActive() || now - lastReadoutAt < 250 || !renderer) {
        return;
      }

      lastReadoutAt = now;
      syncRendererState(renderer);
    };
    const onRendererState = (state: MediaRendererState) => {
      if (!isActive()) {
        return;
      }

      setRendererState(state);
      setSourceState(state.source);
    };

    if (sourceMode === DemoSourceMode.Upload) {
      uploadAbortRef.current = abortController ?? null;
    }

    resetRendererView(container, sourceMode);

    void (async () => {
      try {
        if (sourceMode === DemoSourceMode.Basketball) {
          const session = await createBasketballSession({
            container,
            definition: activeBasketballFixture,
            isActive,
            onDetectionSourceState: setDetectionSourceState,
            onFixtureSummary: setFixtureSummary,
            onFrame,
            onMediaState: setMediaState,
            onRenderPreparationDiagnostics: setRenderPreparationDiagnostics,
            onRendererState,
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
            onDetectionSourceState: setDetectionSourceState,
            onFixtureSummary: setFixtureSummary,
            onFrame,
            onMediaState: setMediaState,
            onRenderPreparationDiagnostics: setRenderPreparationDiagnostics,
            onRendererState,
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
  }, [sourceMode, syncRendererState, uploadRun]);

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
    (settings: BasketballPresentationSettings) => {
      presentationSettingsRef.current = settings;
      setPresentationSettingsState(settings);

      const renderer = rendererRef.current;
      if (!renderer) {
        return;
      }

      renderer.setPresentation(createBasketballSamplePresentation(settings));
      syncRendererState(renderer);
    },
    [syncRendererState],
  );

  const setSourceMode = useCallback((mode: DemoSourceMode) => {
    if (mode === DemoSourceMode.Basketball) {
      uploadAbortRef.current?.abort();
      setUploadRun(null);
      setUploadInferenceState(initialUploadInferenceState);
    }

    setSourceModeState(mode);
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
    setMediaState({
      errorMessage: null,
      status:
        nextSourceMode === DemoSourceMode.Basketball
          ? activeBasketballFixture.mediaLoadingStatusLabel
          : "waiting for upload inference",
    });
    setRendererState(null);
    setRenderPreparationDiagnostics(null);
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
    setPresentationSettings,
    setSourceMode,
    setUploadApiKey,
    setUploadClassNames,
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
