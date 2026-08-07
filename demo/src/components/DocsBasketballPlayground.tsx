import { useCallback, useMemo } from "react";
import { MediaRendererPlaybackState } from "supervision";
import {
  type DemoPresentationSettings,
  type DemoPresentationLayerSetting,
} from "../presentation/demo-presentation";
import { useDemoRenderer } from "../hooks/useDemoRenderer";
import { RendererViewport } from "./RendererViewport";

const docsUrl =
  import.meta.env.VITE_SUPERVISION_DOCS_URL ??
  (globalThis.location.hostname === "localhost" ||
  globalThis.location.hostname === "127.0.0.1"
    ? "http://127.0.0.1:5175"
    : `${import.meta.env.BASE_URL}docs/`);

const annotationLayers: readonly {
  readonly key: DemoPresentationLayerSetting;
  readonly label: string;
  readonly description: string;
}[] = [
  { key: "masksEnabled", label: "Masks", description: "Segmentation" },
  { key: "boxesEnabled", label: "Boxes", description: "Detection bounds" },
  {
    key: "keypointsEnabled",
    label: "Skeletons",
    description: "Pose keypoints",
  },
  { key: "labelsEnabled", label: "Labels", description: "Class names" },
];

/** A compact, embeddable consumer of the browser demo for the docs homepage. */
export function DocsBasketballPlayground() {
  const demo = useDemoRenderer({
    initialFixtureId: "basketball_geometry",
    initialPresentationSettings: {
      boxesEnabled: true,
      focusEnabled: false,
      keypointsEnabled: true,
      labelsEnabled: true,
      masksEnabled: true,
      maskOpacity: 0.78,
      polygonsEnabled: false,
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
  const updatePresentation = useCallback(
    (patch: Partial<DemoPresentationSettings>) => {
      demo.setPresentationSettings({ ...demo.presentationSettings, ...patch });
    },
    [demo.presentationSettings, demo.setPresentationSettings],
  );

  return (
    <main
      className="docs-playground"
      aria-label="Basketball annotation playground"
    >
      <div className="docs-playground__stage">
        <RendererViewport
          containerRef={demo.containerRef}
          mediaState={demo.mediaState}
          sessionState={demo.sessionState}
          uploadInferenceState={null}
        />
        <div className="docs-playground__stage-copy">
          <span>Live fixture</span>
          <strong>Segmentation + pose</strong>
        </div>
      </div>

      <section
        className="docs-playground__controls"
        aria-labelledby="playground-controls-title"
      >
        <div className="docs-playground__controls-heading">
          <div>
            <p>Try the renderer</p>
            <h1 id="playground-controls-title">Style the scene</h1>
          </div>
          <a href={docsUrl} target="_parent">
            Explore the API <span aria-hidden="true">→</span>
          </a>
        </div>

        <fieldset className="docs-playground__layer-list">
          <legend>Visible annotations</legend>
          {annotationLayers.map(({ key, label, description }) => (
            <label className="docs-playground__layer" key={key}>
              <input
                checked={demo.presentationSettings[key]}
                onChange={() =>
                  updatePresentation({ [key]: !demo.presentationSettings[key] })
                }
                type="checkbox"
              />
              <span>
                <strong>{label}</strong>
                <small>{description}</small>
              </span>
            </label>
          ))}
        </fieldset>

        <fieldset className="docs-playground__style-list">
          <legend>Presentation</legend>
          <RangeControl
            label="Mask opacity"
            max={1}
            min={0.15}
            onChange={(maskOpacity) => updatePresentation({ maskOpacity })}
            step={0.05}
            value={demo.presentationSettings.maskOpacity}
            valueLabel={`${Math.round(demo.presentationSettings.maskOpacity * 100)}%`}
          />
          <RangeControl
            label="Box stroke"
            max={6}
            min={1}
            onChange={(boxStrokeWidth) =>
              updatePresentation({ boxStrokeWidth })
            }
            step={0.5}
            value={demo.presentationSettings.boxStrokeWidth}
            valueLabel={`${demo.presentationSettings.boxStrokeWidth}px`}
          />
          <RangeControl
            label="Keypoint size"
            max={8}
            min={2}
            onChange={(keypointRadius) =>
              updatePresentation({ keypointRadius })
            }
            step={0.5}
            value={demo.presentationSettings.keypointRadius}
            valueLabel={`${demo.presentationSettings.keypointRadius}px`}
          />
        </fieldset>

        <div className="docs-playground__playback">
          <button
            aria-label={
              isPlaying ? "Pause basketball fixture" : "Play basketball fixture"
            }
            disabled={!demo.canUseRenderer}
            onClick={demo.onTogglePlayback}
            type="button"
          >
            <span aria-hidden="true">{isPlaying ? "Ⅱ" : "▶"}</span>
            {isPlaying ? "Pause" : "Play"}
          </button>
          <div aria-hidden="true" className="docs-playground__progress">
            <span style={{ width: `${progress}%` }} />
          </div>
          <span className="docs-playground__loop">Loops continuously</span>
        </div>
      </section>
    </main>
  );
}

function RangeControl({
  label,
  max,
  min,
  onChange,
  step,
  value,
  valueLabel,
}: {
  readonly label: string;
  readonly max: number;
  readonly min: number;
  readonly onChange: (value: number) => void;
  readonly step: number;
  readonly value: number;
  readonly valueLabel: string;
}) {
  return (
    <label className="docs-playground__range">
      <span>
        <strong>{label}</strong>
        <output>{valueLabel}</output>
      </span>
      <input
        max={max}
        min={min}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
        step={step}
        type="range"
        value={value}
      />
    </label>
  );
}
