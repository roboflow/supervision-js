import { useCallback, useMemo } from "react";
import { MediaRendererPlaybackState } from "supervision";
import {
  createDocsAnnotationRendererPresentation,
  createDocsAnnotationRendererSnippet,
  docsAnnotationRenderers,
  filterDocsAnnotationRendererFrames,
  type DocsAnnotationRendererControl,
  type DocsAnnotationRendererId,
  type DocsAnnotationRendererSelectControl,
  type DocsAnnotationRendererSelectSetting,
  type NumericPresentationSetting,
} from "../docs-annotation-renderer";
import { useDemoRenderer } from "../hooks/useDemoRenderer";
import type { DemoPresentationSettings } from "../presentation/demo-presentation";
import { RendererViewport } from "./RendererViewport";
import { useViewportOverlay } from "../hooks/useViewportOverlay";
import { DocsRegionAnnotationRendererPlayground } from "./DocsRegionAnnotationRendererPlayground";

export function DocsAnnotationRendererPlayground({
  renderer,
}: {
  readonly renderer: DocsAnnotationRendererId;
}) {
  if (renderer === "regions") {
    return <DocsRegionAnnotationRendererPlayground />;
  }

  return <DocsStyleAnnotationRendererPlayground renderer={renderer} />;
}

function DocsStyleAnnotationRendererPlayground({
  renderer,
}: {
  readonly renderer: Exclude<DocsAnnotationRendererId, "regions">;
}) {
  const definition = docsAnnotationRenderers[renderer];
  const fixtureName = "basketball fixture";
  const demo = useDemoRenderer({
    fixtureFrameTransform: (frames) =>
      filterDocsAnnotationRendererFrames(renderer, frames),
    initialFixtureId: "basketball_sam3",
    initialPresentationSettings:
      createDocsAnnotationRendererPresentation(renderer),
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
    () =>
      createDocsAnnotationRendererSnippet(renderer, demo.presentationSettings),
    [demo.presentationSettings, renderer],
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
  const updateSelectPresentation = useCallback(
    (
      key: DocsAnnotationRendererSelectSetting,
      value: DemoPresentationSettings[DocsAnnotationRendererSelectSetting],
    ) => {
      demo.setPresentationSettings({
        ...demo.presentationSettings,
        [key]: value,
      });
    },
    [demo.presentationSettings, demo.setPresentationSettings],
  );

  const viewportOverlay = useViewportOverlay(
    demo.sessionState,
    null,
    demo.mediaState,
  );

  return (
    <main
      className="docs-layer-playground"
      aria-label={`${definition.title} annotation renderer playground`}
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
          {definition.selects?.map((control) => (
            <RendererSelectControl
              control={control}
              key={control.key}
              onChange={(value) => updateSelectPresentation(control.key, value)}
              value={demo.presentationSettings[control.key]}
            />
          ))}
          {definition.controls.map((control) => (
            <RendererRangeControl
              control={control}
              key={control.key}
              onChange={(value) =>
                updateNumericPresentation(control.key, value)
              }
              value={demo.presentationSettings[control.key]}
            />
          ))}
          {renderer === "labels" ? (
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

function RendererSelectControl({
  control,
  onChange,
  value,
}: {
  readonly control: DocsAnnotationRendererSelectControl;
  readonly onChange: (
    value: DemoPresentationSettings[DocsAnnotationRendererSelectSetting],
  ) => void;
  readonly value: DemoPresentationSettings[DocsAnnotationRendererSelectSetting];
}) {
  return (
    <label className="docs-layer-playground__select">
      <strong>{control.label}</strong>
      <select
        onChange={(event) =>
          onChange(
            event.currentTarget
              .value as DemoPresentationSettings[DocsAnnotationRendererSelectSetting],
          )
        }
        value={value}
      >
        {control.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function RendererRangeControl({
  control,
  onChange,
  value,
}: {
  readonly control: DocsAnnotationRendererControl;
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
