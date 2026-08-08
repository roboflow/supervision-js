import { useCallback, useMemo } from "react";
import { MediaRendererPlaybackState } from "supervision";
import {
  createDocsVisualizationLayerPresentation,
  createDocsVisualizationLayerSnippet,
  docsVisualizationLayers,
  type DocsVisualizationLayerControl,
  type DocsVisualizationLayerId,
  type NumericPresentationSetting,
} from "../docs-visualization-layer";
import { useDemoRenderer } from "../hooks/useDemoRenderer";
import type { DemoPresentationSettings } from "../presentation/demo-presentation";
import { RendererViewport } from "./RendererViewport";

export function DocsVisualizationLayerPlayground({
  layer,
}: {
  readonly layer: DocsVisualizationLayerId;
}) {
  const definition = docsVisualizationLayers[layer];
  const fixtureName =
    layer === "polylines" ? "pedestrian paths fixture" : "basketball fixture";
  const demo = useDemoRenderer({
    initialFixtureId:
      layer === "polylines"
        ? "people_walking_detection_v1"
        : "basketball_geometry",
    initialPresentationSettings:
      createDocsVisualizationLayerPresentation(layer),
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
  const snippet = useMemo(
    () => createDocsVisualizationLayerSnippet(layer, demo.presentationSettings),
    [demo.presentationSettings, layer],
  );
  const updatePresentation = useCallback(
    <Key extends keyof DemoPresentationSettings>(
      key: Key,
      value: DemoPresentationSettings[Key],
    ) => {
      demo.setPresentationSettings({
        ...demo.presentationSettings,
        [key]: value,
      });
    },
    [demo.presentationSettings, demo.setPresentationSettings],
  );
  const updateNumericPresentation = useCallback(
    (key: NumericPresentationSetting, value: number) => {
      demo.setPresentationSettings({
        ...demo.presentationSettings,
        [key]: value,
      });
    },
    [demo.presentationSettings, demo.setPresentationSettings],
  );

  return (
    <main
      className="docs-layer-playground"
      aria-label={`${definition.title} visualization playground`}
    >
      <section className="docs-layer-playground__stage">
        <RendererViewport
          containerRef={demo.containerRef}
          mediaState={demo.mediaState}
          sessionState={demo.sessionState}
          uploadInferenceState={null}
        />
      </section>

      <section className="docs-layer-playground__panel">
        <header className="docs-layer-playground__header">
          <div>
            <p>Visualization layer</p>
            <h1>{definition.title}</h1>
            <span>{definition.description}</span>
          </div>
          <button
            aria-label={
              isPlaying ? `Pause ${fixtureName}` : `Play ${fixtureName}`
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
          {definition.controls.map((control) => (
            <LayerRangeControl
              control={control}
              key={control.key}
              onChange={(value) =>
                updateNumericPresentation(control.key, value)
              }
              value={demo.presentationSettings[control.key]}
            />
          ))}
          {layer === "labels" ? (
            <label className="docs-layer-playground__toggle">
              <span>
                <strong>Confidence</strong>
                <small>Append prediction score</small>
              </span>
              <input
                checked={demo.presentationSettings.labelIncludeConfidence}
                onChange={(event) =>
                  updatePresentation(
                    "labelIncludeConfidence",
                    event.currentTarget.checked,
                  )
                }
                type="checkbox"
              />
            </label>
          ) : null}
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

function LayerRangeControl({
  control,
  onChange,
  value,
}: {
  readonly control: DocsVisualizationLayerControl;
  readonly onChange: (value: number) => void;
  readonly value: number;
}) {
  const valueLabel =
    control.unit === "percent"
      ? `${Math.round(value * 100)}%`
      : `${Number(value.toFixed(1))}px`;

  return (
    <label className="docs-layer-playground__range">
      <span>
        <strong>{control.label}</strong>
        <output>{valueLabel}</output>
      </span>
      <input
        max={control.max}
        min={control.min}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
        step={control.step}
        type="range"
        value={value}
      />
    </label>
  );
}
