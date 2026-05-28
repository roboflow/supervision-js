import { ControlBar } from "./components/ControlBar";
import { DemoShell } from "./components/DemoShell";
import { RenderControls } from "./components/RenderControls";
import { RendererViewport } from "./components/RendererViewport";
import { StatusPanel } from "./components/StatusPanel";
import { useBasketballDemoRenderer } from "./hooks/useBasketballDemoRenderer";

export function App() {
  const demo = useBasketballDemoRenderer();

  return (
    <DemoShell
      viewport={<RendererViewport containerRef={demo.containerRef} />}
      controlBar={
        <ControlBar
          activeDetectionFrameTime={
            demo.rendererState?.activeDetectionFrameTime ?? null
          }
          canUseRenderer={demo.canUseRenderer}
          currentTime={demo.rendererState?.currentTime ?? null}
          detectionBuffer={demo.rendererState?.detectionBuffer ?? null}
          duration={demo.duration}
          onSeek={demo.onSeek}
          onTogglePlayback={demo.onTogglePlayback}
          playbackState={demo.playbackState}
        />
      }
      renderControls={
        <RenderControls
          onChange={demo.setPresentationSettings}
          settings={demo.presentationSettings}
        />
      }
      statusPanel={
        <StatusPanel
          coldDetectionState={demo.coldDetectionState}
          errorMessage={demo.errorMessage}
          fixtureSummary={demo.fixtureSummary}
          mediaState={demo.mediaState}
          playbackState={demo.playbackState}
          rendererState={demo.rendererState}
          sourceState={demo.sourceState}
        />
      }
    />
  );
}
