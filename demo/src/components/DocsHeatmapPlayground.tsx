import { useMemo } from "react";
import { MediaRendererPlaybackState } from "supervision";
import { useDemoRenderer } from "../hooks/useDemoRenderer";
import { useViewportOverlay } from "../hooks/useViewportOverlay";
import {
  createDemoHeatmapSnippet,
  heatmapPaletteOptions,
  type DemoHeatmapPalette,
} from "../heatmap";
import { RendererViewport } from "./RendererViewport";

export function DocsHeatmapPlayground() {
  const demo = useDemoRenderer({
    initialFixtureId: "pebbles_anomaly",
    initialPresentationSettings: {
      boxesEnabled: false,
      focusEnabled: false,
      heatmapsEnabled: true,
      heatmapThresholdScale: 0.75,
      heatmapOpacity: 1,
      labelsEnabled: false,
      masksEnabled: false,
      polygonsEnabled: false,
      polylinesEnabled: false,
    },
  });
  const isPlaying =
    demo.playbackState === MediaRendererPlaybackState.Playing ||
    demo.playbackState === MediaRendererPlaybackState.Buffering;
  const currentTime = demo.rendererState?.currentTime ?? 0;
  const progress = useMemo(
    () =>
      demo.duration && demo.duration > 0
        ? Math.min(100, Math.max(0, (currentTime / demo.duration) * 100))
        : 0,
    [currentTime, demo.duration],
  );
  const settings = demo.presentationSettings;
  const update = (patch: Partial<typeof settings>) =>
    demo.setPresentationSettings({ ...settings, ...patch });
  const viewportOverlay = useViewportOverlay(
    demo.sessionState,
    null,
    demo.mediaState,
  );
  const snippet = createDemoHeatmapSnippet(settings);

  return (
    <main
      className="docs-layer-playground"
      aria-label="Heatmap annotation renderer playground"
    >
      <section className="docs-layer-playground__stage">
        <RendererViewport
          containerRef={demo.containerRef}
          explained={viewportOverlay.explained}
          overlay={viewportOverlay.overlay}
        />
      </section>
      <section className="docs-layer-playground__panel">
        <header className="docs-layer-playground__header">
          <div>
            <p>Annotation renderer</p>
            <h1>Heatmap</h1>
            <span>Confirmed bolt and stick tracks in the pebbles fixture</span>
          </div>
          <button
            aria-label={
              isPlaying ? "Pause pebbles fixture" : "Play pebbles fixture"
            }
            disabled={!demo.canUseRenderer}
            onClick={demo.onTogglePlayback}
            type="button"
          >
            <span aria-hidden="true">{isPlaying ? "Ⅱ" : "▶"}</span>
            {isPlaying ? "Pause" : "Play"}
          </button>
        </header>
        <div className="docs-layer-playground__controls">
          <label className="docs-layer-playground__range">
            <span>
              <strong>Cutoff relative to model threshold</strong>
              <output>
                {Math.round(settings.heatmapThresholdScale * 100)}%
              </output>
            </span>
            <input
              type="range"
              min="0"
              max="2"
              step="0.05"
              value={settings.heatmapThresholdScale}
              onChange={(event) =>
                update({
                  heatmapThresholdScale: Number(event.currentTarget.value),
                })
              }
            />
          </label>
          <label className="docs-layer-playground__range">
            <span>
              <strong>Minimum alpha above cutoff</strong>
              <output>{Math.round(settings.heatmapMinimumAlpha * 100)}%</output>
            </span>
            <input
              aria-label="Minimum alpha"
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={settings.heatmapMinimumAlpha}
              onChange={(event) =>
                update({
                  heatmapMinimumAlpha: Number(event.currentTarget.value),
                })
              }
            />
          </label>
          <label className="docs-layer-playground__range">
            <span>
              <strong>Opacity</strong>
              <output>{Math.round(settings.heatmapOpacity * 100)}%</output>
            </span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={settings.heatmapOpacity}
              onChange={(event) =>
                update({ heatmapOpacity: Number(event.currentTarget.value) })
              }
            />
          </label>
          <label className="docs-layer-playground__number">
            <strong>Maximum score</strong>
            <input
              aria-label="Maximum score"
              type="number"
              min="0.001"
              step="0.05"
              placeholder="1"
              value={settings.heatmapMaximumScore ?? ""}
              onChange={(event) => {
                const raw = event.currentTarget.value;
                const value = raw === "" ? undefined : Number(raw);
                if (
                  value === undefined ||
                  (Number.isFinite(value) && value > 0)
                ) {
                  update({ heatmapMaximumScore: value });
                }
              }}
            />
          </label>
          <label className="docs-layer-playground__select">
            <strong>Color palette</strong>
            <select
              aria-label="Color palette"
              onChange={(event) =>
                update({
                  heatmapPalette: event.currentTarget
                    .value as DemoHeatmapPalette,
                })
              }
              value={settings.heatmapPalette}
            >
              {heatmapPaletteOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <section
          className="docs-layer-playground__code"
          aria-label="Live presentation code"
        >
          <div>
            <span>Live code</span>
            <small>Values update with the controls</small>
          </div>
          <pre>
            <code>{snippet}</code>
          </pre>
        </section>
        <div aria-hidden="true" className="docs-layer-playground__progress">
          <span style={{ width: `${progress}%` }} />
        </div>
      </section>
    </main>
  );
}
