import { useEffect, useRef, useState } from "react";
import {
  MediaRendererFit,
  MediaRendererPlaybackState,
  createMediaRenderer,
  type MediaRenderer,
  type MediaRendererState,
  type MediaSourceState,
} from "supervision-js";
import { ControlBar } from "./components/ControlBar";
import { DemoShell } from "./components/DemoShell";
import { RendererViewport } from "./components/RendererViewport";
import {
  StatusPanel,
  type StatusPanelColdDetectionState,
  type StatusPanelMediaState,
} from "./components/StatusPanel";
import {
  basketballSampleBoxStyle,
  createBasketballSampleColdDetectionSource,
  loadBasketballSampleFixture,
  loadNormalizedBasketballSampleMedia,
  type BasketballSampleColdDetectionSource,
  type BasketballSampleSummary,
} from "./fixtures/basketball-sample";

type DemoMediaState = StatusPanelMediaState;
type DemoColdDetectionState = StatusPanelColdDetectionState;

const initialColdDetectionState: DemoColdDetectionState = {
  datasetId: null,
  errorMessage: null,
  status: "loading cold store",
  writeSummary: null,
};

export function App() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const effectRunRef = useRef(0);
  const rendererRef = useRef<MediaRenderer | null>(null);
  const seekRunRef = useRef(0);
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

  const syncRendererState = (renderer: MediaRenderer) => {
    const state = renderer.getState();

    setRendererState(state);
    setSourceState(state.source);
  };

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

        const createdRenderer = await createMediaRenderer({
          autoPlay: false,
          boxStyle: basketballSampleBoxStyle,
          container,
          detectionBuffer: {
            bufferAheadSeconds: 2,
            bufferBehindSeconds: 0.5,
          },
          detectionSource: createdColdDetectionSource.detectionSource,
          fit: MediaRendererFit.Contain,
          loop: true,
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
  }, []);

  const duration = rendererState?.duration ?? fixtureSummary?.duration ?? null;
  const playbackState = rendererState?.playbackState ?? null;
  const canUseRenderer =
    playbackState !== null &&
    playbackState !== MediaRendererPlaybackState.Loading &&
    playbackState !== MediaRendererPlaybackState.Error &&
    playbackState !== MediaRendererPlaybackState.Destroyed;

  const handleTogglePlayback = () => {
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
  };

  const handleSeek = (time: number) => {
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
  };

  return (
    <DemoShell
      viewport={<RendererViewport containerRef={containerRef} />}
      controlBar={
        <ControlBar
          activeDetectionFrameTime={
            rendererState?.activeDetectionFrameTime ?? null
          }
          canUseRenderer={canUseRenderer}
          currentTime={rendererState?.currentTime ?? null}
          detectionBuffer={rendererState?.detectionBuffer ?? null}
          duration={duration}
          onSeek={handleSeek}
          onTogglePlayback={handleTogglePlayback}
          playbackState={playbackState}
        />
      }
      statusPanel={
        <StatusPanel
          coldDetectionState={coldDetectionState}
          errorMessage={errorMessage}
          fixtureSummary={fixtureSummary}
          mediaState={mediaState}
          playbackState={playbackState}
          rendererState={rendererState}
          sourceState={sourceState}
        />
      }
    />
  );
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
