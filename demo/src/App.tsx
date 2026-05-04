import { useEffect, useRef, useState } from "react";
import {
  createMediaRendererProof,
  type MediaDemuxProbeState,
  type MediaRendererProof,
  type MediaRendererProofState,
} from "supervision-js";

const sampleVideoSrc = "/media/proof.mp4";

export function App() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const effectRunRef = useRef(0);
  const [rendererState, setRendererState] =
    useState<MediaRendererProofState | null>(null);
  const [demuxState, setDemuxState] = useState<MediaDemuxProbeState | null>(
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
      onDemux: (state) => {
        if (isActive()) {
          setDemuxState(state);
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
        setDemuxState(createdRenderer.getState().demux);

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
          label="Media"
          value={
            rendererState?.mediaWidth && rendererState.mediaHeight
              ? `${rendererState.mediaWidth} x ${rendererState.mediaHeight}`
              : "-"
          }
        />
        <Readout
          label="Decode"
          value={
            demuxState
              ? [
                  demuxState.status,
                  demuxState.formatName,
                  demuxState.duration === null
                    ? null
                    : `${demuxState.duration.toFixed(2)}s`,
                  demuxState.primaryVideoWidth && demuxState.primaryVideoHeight
                    ? `${demuxState.primaryVideoWidth} x ${demuxState.primaryVideoHeight}`
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
              rendererState.demux.errorMessage ??
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
