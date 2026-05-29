import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  DetectionFrameSelectionMode,
  MediaRendererFit,
  MediaRendererPlaybackState,
  createMediaRenderer,
  type MediaRenderer,
  type MediaRendererState,
  type MediaSourceState,
} from "supervision-js";
import type {
  BasketballSampleDetectionSource,
  BasketballSampleDetectionSourceSummary,
  BasketballSampleSummary,
} from "../fixtures/basketball-sample";
import {
  createBasketballSampleDetectionSource,
  defaultBasketballSampleFixture,
  loadBasketballSampleMedia,
  loadBasketballSampleDetectionManifest,
} from "../fixtures/basketball-sample";
import {
  createBasketballSamplePresentation,
  defaultBasketballPresentationSettings,
  type BasketballPresentationSettings,
} from "../presentation/basketball-presentation";

export interface DemoMediaState {
  readonly errorMessage: string | null;
  readonly status: string;
}

export interface DemoDetectionSourceState {
  readonly datasetId: string | null;
  readonly errorMessage: string | null;
  readonly sourceSummary: BasketballSampleDetectionSourceSummary | null;
  readonly status: string;
}

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
  readonly sourceState: MediaSourceState | null;
  readonly onSeek: (time: number) => void;
  readonly onTogglePlayback: () => void;
  readonly setPresentationSettings: (
    settings: BasketballPresentationSettings,
  ) => void;
}

const initialDetectionSourceState: DemoDetectionSourceState = {
  datasetId: null,
  errorMessage: null,
  sourceSummary: null,
  status: "loading cold source",
};

const activeBasketballFixture = defaultBasketballSampleFixture;

export function useBasketballDemoRenderer(): BasketballDemoRendererState {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const effectRunRef = useRef(0);
  const rendererRef = useRef<MediaRenderer | null>(null);
  const seekRunRef = useRef(0);
  const presentationSettingsRef = useRef<BasketballPresentationSettings>(
    defaultBasketballPresentationSettings,
  );
  const [rendererState, setRendererState] = useState<MediaRendererState | null>(
    null,
  );
  const [sourceState, setSourceState] = useState<MediaSourceState | null>(null);
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
    let detectionSource: BasketballSampleDetectionSource | undefined;
    let renderer: MediaRenderer | undefined;
    let lastReadoutAt = 0;
    let cleanedUp = false;
    const isActive = () => !cleanedUp && effectRunRef.current === runId;

    container.replaceChildren();
    rendererRef.current = null;
    setDetectionSourceState(initialDetectionSourceState);
    setErrorMessage(null);
    setFixtureSummary(null);
    setMediaState({
      errorMessage: null,
      status: activeBasketballFixture.mediaLoadingStatusLabel,
    });
    setRendererState(null);
    setSourceState(null);

    void (async () => {
      try {
        const manifest = await loadBasketballSampleDetectionManifest(
          activeBasketballFixture,
        );
        const createdDetectionSource = createBasketballSampleDetectionSource(
          manifest,
          activeBasketballFixture,
        );
        detectionSource = createdDetectionSource;

        if (!isActive()) {
          createdDetectionSource.destroy();
          return;
        }

        setFixtureSummary(createdDetectionSource.fixtureSummary);
        setDetectionSourceState({
          datasetId: createdDetectionSource.datasetId,
          errorMessage: null,
          sourceSummary: createdDetectionSource.sourceSummary,
          status: createdDetectionSource.status,
        });

        const mediaSource = await loadBasketballSampleMedia(
          activeBasketballFixture,
        );

        if (!isActive()) {
          createdDetectionSource.destroy();
          return;
        }

        setMediaState({
          errorMessage: mediaSource.error?.message ?? null,
          status: mediaSource.statusLabel,
        });

        const presentation = createBasketballSamplePresentation(
          presentationSettingsRef.current,
        );
        const createdRenderer = await createMediaRenderer({
          autoPlay: false,
          boxStyle: presentation.boxStyle ?? undefined,
          container,
          detectionBuffer: {
            bufferAheadSeconds: 2,
            bufferBehindSeconds: 0.5,
            frameIndexOriginTime: 0,
            frameRate: manifest.inference.frameRate,
            selectionMode: DetectionFrameSelectionMode.NearestFrameIndex,
          },
          detectionSource: createdDetectionSource.detectionSource,
          fit: MediaRendererFit.Contain,
          loop: true,
          maskStyle: presentation.maskStyle ?? undefined,
          onSource: (state) => {
            if (isActive()) {
              setSourceState(state);
            }
          },
          onFrame: () => {
            const now = performance.now();

            if (!isActive() || now - lastReadoutAt < 250 || !renderer) {
              return;
            }

            lastReadoutAt = now;
            syncRendererState(renderer);
          },
          src: mediaSource.src,
        });

        if (!isActive()) {
          createdRenderer.destroy();
          return;
        }

        renderer = createdRenderer;
        rendererRef.current = createdRenderer;
        syncRendererState(createdRenderer);

        try {
          await createdRenderer.play();
          if (isActive()) {
            syncRendererState(createdRenderer);
          }
        } catch (error: unknown) {
          if (isActive()) {
            syncRendererState(createdRenderer);
            setErrorMessage(
              getErrorMessage(error, "Unable to play the media renderer."),
            );
          }
        }
      } catch (error: unknown) {
        if (isActive()) {
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
        }
      }
    })();

    return () => {
      cleanedUp = true;
      rendererRef.current = null;
      renderer?.destroy();
      detectionSource?.destroy();
    };
  }, [syncRendererState]);

  const playbackState = rendererState?.playbackState ?? null;
  const duration = rendererState?.duration ?? fixtureSummary?.duration ?? null;
  const canUseRenderer =
    playbackState !== null &&
    playbackState !== MediaRendererPlaybackState.Loading &&
    playbackState !== MediaRendererPlaybackState.Error &&
    playbackState !== MediaRendererPlaybackState.Destroyed;

  const handleSetPresentationSettings = useCallback(
    (settings: BasketballPresentationSettings) => {
      presentationSettingsRef.current = settings;
      setPresentationSettingsState(settings);
      rendererRef.current?.setPresentation(
        createBasketballSamplePresentation(settings),
      );
    },
    [],
  );

  const handleTogglePlayback = useCallback(() => {
    const renderer = rendererRef.current;

    if (!renderer || !canUseRenderer) {
      return;
    }

    setErrorMessage(null);

    if (
      renderer.getState().playbackState === MediaRendererPlaybackState.Playing
    ) {
      renderer.pause();
      syncRendererState(renderer);
      return;
    }

    void renderer
      .play()
      .then(() => {
        syncRendererState(renderer);
      })
      .catch((error: unknown) => {
        syncRendererState(renderer);
        setErrorMessage(
          getErrorMessage(error, "Unable to play the media renderer."),
        );
      });
  }, [canUseRenderer, syncRendererState]);

  const handleSeek = useCallback(
    (time: number) => {
      const renderer = rendererRef.current;

      if (!renderer || !canUseRenderer) {
        return;
      }

      const currentSeekRun = seekRunRef.current + 1;
      seekRunRef.current = currentSeekRun;
      setErrorMessage(null);

      void renderer
        .seek(time)
        .then(() => {
          if (seekRunRef.current === currentSeekRun) {
            syncRendererState(renderer);
          }
        })
        .catch((error: unknown) => {
          if (seekRunRef.current === currentSeekRun) {
            syncRendererState(renderer);
            setErrorMessage(
              getErrorMessage(error, "Unable to seek the media renderer."),
            );
          }
        });
    },
    [canUseRenderer, syncRendererState],
  );

  return {
    canUseRenderer,
    containerRef,
    detectionSourceState,
    duration,
    errorMessage,
    fixtureSummary,
    mediaState,
    onSeek: handleSeek,
    onTogglePlayback: handleTogglePlayback,
    playbackState,
    presentationSettings,
    rendererState,
    setPresentationSettings: handleSetPresentationSettings,
    sourceState,
  };
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
