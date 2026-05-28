import { useEffect, useRef, useState } from "react";
import {
  createMediaRenderer,
  MediaRendererFit,
  MediaRendererPlaybackState,
  type MediaRenderer,
  type MediaRendererState,
  type MediaSourceState,
} from "supervision-js";
import {
  basketballSampleBoxStyle,
  loadNormalizedBasketballSampleMedia,
  loadBasketballSampleFixture,
  summarizeBasketballSampleFixture,
  toDetectionFrames,
  type BasketballSampleSummary,
} from "./fixtures/basketball-sample";

interface DemoMediaState {
  readonly status: string;
  readonly errorMessage: string | null;
}

export function App() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const effectRunRef = useRef(0);
  const [rendererState, setRendererState] = useState<MediaRendererState | null>(
    null,
  );
  const [sourceState, setSourceState] = useState<MediaSourceState | null>(null);
  const [fixtureSummary, setFixtureSummary] =
    useState<BasketballSampleSummary | null>(null);
  const [mediaState, setMediaState] = useState<DemoMediaState>({
    errorMessage: null,
    status: "normalizing WebM 30fps",
  });
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    const runId = effectRunRef.current + 1;
    effectRunRef.current = runId;
    let renderer: MediaRenderer | undefined;
    let revokeMediaSource: (() => void) | undefined;
    let lastReadoutAt = 0;
    let cleanedUp = false;
    const isActive = () => !cleanedUp && effectRunRef.current === runId;

    container.replaceChildren();
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
        const detectionFrames = toDetectionFrames(fixture);

        if (!isActive()) {
          return;
        }

        setFixtureSummary(summarizeBasketballSampleFixture(fixture));

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
          detectionFrames,
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
            setRendererState(renderer.getState());
          },
          src: mediaSource.src,
        });

        if (!isActive()) {
          createdRenderer.destroy();
          return;
        }

        renderer = createdRenderer;
        setRendererState(createdRenderer.getState());
        setSourceState(createdRenderer.getState().source);

        try {
          await createdRenderer.play();
          if (isActive()) {
            setRendererState(createdRenderer.getState());
          }
        } catch (error: unknown) {
          if (isActive()) {
            setRendererState(createdRenderer.getState());
            setErrorMessage(
              error instanceof Error
                ? error.message
                : "Unable to play the media renderer.",
            );
          }
        }
      } catch (error: unknown) {
        if (isActive()) {
          setErrorMessage(
            error instanceof Error
              ? error.message
              : "Unable to start the media renderer.",
          );
        }
      }
    })();

    return () => {
      cleanedUp = true;
      renderer?.destroy();
      revokeMediaSource?.();
    };
  }, []);

  return (
    <main
      style={{
        background: "#101114",
        color: "#f5f7fb",
        display: "grid",
        gridTemplateRows: "1fr auto",
        minHeight: "100vh",
      }}
    >
      <div
        ref={containerRef}
        style={{
          minHeight: 0,
          overflow: "hidden",
        }}
      />
      <aside
        style={{
          alignItems: "center",
          background: "#1a1d23",
          borderTop: "1px solid #2c3038",
          display: "flex",
          flexWrap: "wrap",
          gap: 16,
          minHeight: 48,
          padding: "8px 12px",
        }}
      >
        <Readout label="Fixture" value="Basketball / Rapid" />
        <Readout label="State" value={rendererState?.playbackState ?? "-"} />
        <Readout
          label="Frames"
          value={String(rendererState?.presentedFrames ?? "-")}
        />
        <Readout
          label="Time"
          value={
            rendererState ? `${rendererState.currentTime.toFixed(2)}s` : "-"
          }
        />
        <Readout
          label="Detections"
          value={
            rendererState
              ? rendererState.activeDetectionFrameTime === null
                ? `none | ${rendererState.activeDetectionCount} detections`
                : `${rendererState.activeDetectionFrameTime.toFixed(2)}s | ${rendererState.activeDetectionCount} detections`
              : "-"
          }
        />
        <Readout
          label="Fixture Boxes"
          value={
            fixtureSummary
              ? `${formatInteger(fixtureSummary.frameCount)} frames | ${formatInteger(
                  fixtureSummary.detectionCount,
                )} boxes`
              : "loading"
          }
        />
        <Readout
          label="Missing"
          value={
            fixtureSummary
              ? fixtureSummary.missingFrameIndexes.length === 0
                ? "none"
                : fixtureSummary.missingFrameIndexes.join(", ")
              : "-"
          }
        />
        <Readout
          label="Size"
          value={
            rendererState?.mediaWidth && rendererState.mediaHeight
              ? `${rendererState.mediaWidth} x ${rendererState.mediaHeight}`
              : "-"
          }
        />
        <Readout
          label="Source"
          value={
            sourceState
              ? [
                  sourceState.status,
                  sourceState.formatName,
                  sourceState.duration === null
                    ? null
                    : `${sourceState.duration.toFixed(2)}s`,
                  sourceState.primaryVideoWidth &&
                  sourceState.primaryVideoHeight
                    ? `${sourceState.primaryVideoWidth} x ${sourceState.primaryVideoHeight}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" | ")
              : "-"
          }
        />
        <Readout label="Media" value={mediaState.status} />
        {mediaState.errorMessage ? (
          <Readout label="Media Error" value={mediaState.errorMessage} />
        ) : null}
        <Readout label="Inference" value="Rapid 30 fps | masks to boxes" />
        <Readout label="Audio" value="video-only fixture" />
        {errorMessage ? <Readout label="Error" value={errorMessage} /> : null}
        {!errorMessage &&
        rendererState?.playbackState === MediaRendererPlaybackState.Error ? (
          <Readout
            label="Error"
            value={
              rendererState.source.errorMessage ??
              "Unable to decode media with Mediabunny."
            }
          />
        ) : null}
      </aside>
    </main>
  );
}

function formatInteger(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        gap: 6,
        lineHeight: 1.4,
        whiteSpace: "nowrap",
      }}
    >
      <strong style={{ color: "#9ca3af", fontWeight: 600 }}>{label}</strong>
      <span>{value}</span>
    </span>
  );
}
