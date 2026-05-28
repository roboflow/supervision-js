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
  type ColdDetectionFrameStoreWriteSummary,
  type MediaRenderer,
  type MediaRendererState,
  type MediaSourceState,
} from "supervision-js";
import type {
  BasketballSampleColdDetectionSource,
  BasketballSampleSummary,
} from "../fixtures/basketball-sample";
import {
  createBasketballSampleColdDetectionSource,
  loadBasketballSampleFixture,
  loadNormalizedBasketballSampleMedia,
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

export interface DemoColdDetectionState {
  readonly datasetId: string | null;
  readonly errorMessage: string | null;
  readonly status: string;
  readonly writeSummary: ColdDetectionFrameStoreWriteSummary | null;
}

export interface BasketballDemoRendererState {
  readonly canUseRenderer: boolean;
  readonly coldDetectionState: DemoColdDetectionState;
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

const initialColdDetectionState: DemoColdDetectionState = {
  datasetId: null,
  errorMessage: null,
  status: "loading cold store",
  writeSummary: null,
};

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
  const [coldDetectionState, setColdDetectionState] =
    useState<DemoColdDetectionState>(initialColdDetectionState);
  const [mediaState, setMediaState] = useState<DemoMediaState>({
    errorMessage: null,
    status: "normalizing WebM 30fps",
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
    let coldDetectionSource: BasketballSampleColdDetectionSource | undefined;
    let renderer: MediaRenderer | undefined;
    let revokeMediaSource: (() => void) | undefined;
    let lastReadoutAt = 0;
    let cleanedUp = false;
    const isActive = () => !cleanedUp && effectRunRef.current === runId;

    container.replaceChildren();
    rendererRef.current = null;
    setColdDetectionState(initialColdDetectionState);
    setErrorMessage(null);
    setFixtureSummary(null);
    setMediaState({
      errorMessage: null,
      status: "normalizing WebM 30fps",
    });
    setRendererState(null);
    setSourceState(null);

    void (async () => {
      try {
        const fixture = await loadBasketballSampleFixture();
        const createdColdDetectionSource =
          await createBasketballSampleColdDetectionSource(fixture);
        coldDetectionSource = createdColdDetectionSource;

        if (!isActive()) {
          createdColdDetectionSource.destroy();
          return;
        }

        setFixtureSummary(createdColdDetectionSource.fixtureSummary);
        setColdDetectionState({
          datasetId: createdColdDetectionSource.datasetId,
          errorMessage: null,
          status: createdColdDetectionSource.status,
          writeSummary: createdColdDetectionSource.writeSummary,
        });

        const mediaSource = await loadNormalizedBasketballSampleMedia({
          onProgress: ({ progress }) => {
            if (isActive()) {
              setMediaState({
                errorMessage: null,
                status: `normalizing WebM 30fps ${Math.round(progress * 100)}%`,
              });
            }
          },
        });

        if (!isActive()) {
          mediaSource.revoke?.();
          createdColdDetectionSource.destroy();
          return;
        }

        revokeMediaSource = mediaSource.revoke;
        setMediaState(
          mediaSource.normalized
            ? {
                errorMessage: null,
                status: "normalized WebM 30fps",
              }
            : {
                errorMessage:
                  mediaSource.error?.message ??
                  "Media normalization is unavailable in this browser.",
                status: "source MP4 fallback",
              },
        );

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
            frameRate: fixture.inference.frameRate,
            selectionMode: DetectionFrameSelectionMode.NearestFrameIndex,
          },
          detectionSource: createdColdDetectionSource.detectionSource,
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
          setColdDetectionState((current) =>
            current.writeSummary
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
      coldDetectionSource?.destroy();
      revokeMediaSource?.();
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
    coldDetectionState,
    containerRef,
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
