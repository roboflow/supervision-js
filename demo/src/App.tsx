import { useEffect, useRef, useState } from "react";
import {
  createMediaRendererProof,
  type MediaRendererProof,
  type MediaRendererProofOverlayFrame,
  type MediaRendererProofState,
  type MediaSourceProbeState,
} from "supervision-js";

const sampleVideoSrc = "/media/proof.mp4";
const proofOverlayFrames: readonly MediaRendererProofOverlayFrame[] = [
  {
    mediaTime: 0,
    rects: [
      {
        height: 168,
        strokeAlpha: 0.9,
        strokeColor: 0x00ff66,
        strokeWidth: 4,
        width: 224,
        x: 88,
        y: 72,
      },
    ],
  },
  {
    mediaTime: 1.25,
    rects: [
      {
        height: 164,
        strokeAlpha: 0.9,
        strokeColor: 0x38bdf8,
        strokeWidth: 4,
        width: 224,
        x: 320,
        y: 128,
      },
    ],
  },
  {
    mediaTime: 2.5,
    rects: [
      {
        height: 180,
        strokeAlpha: 0.95,
        strokeColor: 0xfacc15,
        strokeWidth: 5,
        width: 280,
        x: 560,
        y: 240,
      },
    ],
  },
  {
    mediaTime: 3.75,
    rects: [
      {
        height: 220,
        strokeAlpha: 0.9,
        strokeColor: 0xfb7185,
        strokeWidth: 4,
        width: 360,
        x: 760,
        y: 340,
      },
    ],
  },
];

export function App() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const effectRunRef = useRef(0);
  const [rendererState, setRendererState] =
    useState<MediaRendererProofState | null>(null);
  const [sourceState, setSourceState] = useState<MediaSourceProbeState | null>(
    null,
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    const runId = effectRunRef.current + 1;
    effectRunRef.current = runId;
    let renderer: MediaRendererProof | undefined;
    let lastReadoutAt = 0;
    let cleanedUp = false;
    const isActive = () => !cleanedUp && effectRunRef.current === runId;

    container.replaceChildren();
    setErrorMessage(null);

    void createMediaRendererProof({
      autoPlay: false,
      container,
      fit: "contain",
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
      overlayFrames: proofOverlayFrames,
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
                : "Unable to play the media renderer proof.",
            );
          }
        }
      })
      .catch((error: unknown) => {
        if (isActive()) {
          setErrorMessage(
            error instanceof Error
              ? error.message
              : "Unable to start the media renderer proof.",
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
          label="Overlay"
          value={
            rendererState
              ? rendererState.activeOverlayFrameTime === null
                ? `none | ${rendererState.activeOverlayRectCount} rects`
                : `${rendererState.activeOverlayFrameTime.toFixed(2)}s | ${rendererState.activeOverlayRectCount} rects`
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
        {!errorMessage && rendererState?.playbackState === "error" ? (
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
