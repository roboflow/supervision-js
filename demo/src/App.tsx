import { useEffect, useRef, useState } from "react";
import {
  RoundedBoxStyle,
  createMediaRenderer,
  MediaRendererFit,
  MediaRendererPlaybackState,
  type DetectionFrame,
  type MediaRenderer,
  type MediaRendererState,
  type MediaSourceState,
} from "supervision-js";

const sampleVideoSrc = "/media/sample.mp4";
const sampleBoxStyle = new RoundedBoxStyle({
  cornerRadius: 8,
  fill: { alpha: 0.08, color: 0x00ff66 },
  stroke: { alpha: 0.95, color: 0x00ff66, width: 4 },
});
const sampleDetectionFrames: readonly DetectionFrame[] = [
  {
    detections: [
      {
        className: "sample-object",
        confidence: 0.92,
        rect: {
          height: 168,
          width: 224,
          x: 88,
          y: 72,
        },
      },
    ],
    mediaTime: 0,
  },
  {
    detections: [
      {
        className: "sample-object",
        confidence: 0.88,
        rect: {
          height: 164,
          width: 224,
          x: 320,
          y: 128,
        },
      },
    ],
    mediaTime: 1.25,
  },
  {
    detections: [
      {
        className: "sample-object",
        confidence: 0.84,
        rect: {
          height: 180,
          width: 280,
          x: 560,
          y: 240,
        },
      },
    ],
    mediaTime: 2.5,
  },
  {
    detections: [
      {
        className: "sample-object",
        confidence: 0.9,
        rect: {
          height: 220,
          width: 360,
          x: 760,
          y: 340,
        },
      },
    ],
    mediaTime: 3.75,
  },
];

export function App() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const effectRunRef = useRef(0);
  const [rendererState, setRendererState] = useState<MediaRendererState | null>(
    null,
  );
  const [sourceState, setSourceState] = useState<MediaSourceState | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    const runId = effectRunRef.current + 1;
    effectRunRef.current = runId;
    let renderer: MediaRenderer | undefined;
    let lastReadoutAt = 0;
    let cleanedUp = false;
    const isActive = () => !cleanedUp && effectRunRef.current === runId;

    container.replaceChildren();
    setErrorMessage(null);
    setRendererState(null);
    setSourceState(null);

    void createMediaRenderer({
      autoPlay: false,
      boxStyle: sampleBoxStyle,
      container,
      detectionFrames: sampleDetectionFrames,
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
      src: sampleVideoSrc,
    })
      .then(async (createdRenderer) => {
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
      })
      .catch((error: unknown) => {
        if (isActive()) {
          setErrorMessage(
            error instanceof Error
              ? error.message
              : "Unable to start the media renderer.",
          );
        }
      });

    return () => {
      cleanedUp = true;
      renderer?.destroy();
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
        <Readout label="Audio" value="video-only" />
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
