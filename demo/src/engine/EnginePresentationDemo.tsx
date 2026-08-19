import { useEffect, useRef, useState } from "react";
import {
  MediaInteractionMode,
  MediaRendererFit,
  createMediaRenderer,
  type MediaRenderer,
} from "supervision";
import {
  createDemoFixtureDetectionSource,
  defaultDemoFixture,
  loadDemoFixtureDetectionManifest,
} from "../fixtures/demo-fixtures";
import { createDemoPresentation } from "../presentation/demo-presentation";
import { defaultDemoPresentationSettings } from "../presentation/demo-presentation";
import { createEngineMediaSource } from "./engine-media-source";

const RENDER_COUNT_POLL_MS = 250;

/**
 * Runs the Pixi scene against the video engine's presented frames: the engine
 * owns the playhead, the scene composites what it announces, and the render
 * count shows how many renders that cost.
 */
export function EnginePresentationDemo() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<MediaRenderer | null>(null);
  const [engineControls, setEngineControls] = useState<{
    play(): void;
    pause(): void;
    step(): void;
  } | null>(null);
  const [renderCount, setRenderCount] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let active = true;
    const source = createEngineMediaSource(defaultDemoFixture.videoSrc);

    const start = async () => {
      const manifest =
        await loadDemoFixtureDetectionManifest(defaultDemoFixture);
      const detections = createDemoFixtureDetectionSource(
        manifest,
        defaultDemoFixture,
      );
      const presentation = createDemoPresentation(
        defaultDemoPresentationSettings,
      );
      const renderer = await createMediaRenderer({
        ...presentation,
        autoPlay: false,
        container,
        detectionSource: detections.detectionSource,
        fit: MediaRendererFit.Contain,
        interaction: { mode: MediaInteractionMode.Always },
        source,
      });

      if (!active) {
        renderer.destroy();
        detections.destroy();
        return;
      }

      rendererRef.current = renderer;
      const engine = source.getEngine();

      setEngineControls(
        engine
          ? {
              pause: () => engine.pause(),
              play: () => void engine.play(),
              step: () => void engine.step(1),
            }
          : null,
      );
    };

    void start().catch((error: unknown) => {
      if (active) setErrorMessage(String(error));
    });

    const readRenderCount = window.setInterval(() => {
      setRenderCount(rendererRef.current?.getRenderCount() ?? 0);
    }, RENDER_COUNT_POLL_MS);

    return () => {
      active = false;
      window.clearInterval(readRenderCount);
      rendererRef.current?.destroy();
      rendererRef.current = null;
    };
  }, []);

  return (
    <div style={{ display: "grid", gap: 12, padding: 16 }}>
      <div
        ref={containerRef}
        style={{ background: "#111", height: 480, width: "100%" }}
      />
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={() => engineControls?.play()} type="button">
          Play
        </button>
        <button onClick={() => engineControls?.pause()} type="button">
          Pause
        </button>
        <button onClick={() => engineControls?.step()} type="button">
          Step
        </button>
        <span>Renders: {renderCount}</span>
      </div>
      {errorMessage ? <pre>{errorMessage}</pre> : null}
    </div>
  );
}
