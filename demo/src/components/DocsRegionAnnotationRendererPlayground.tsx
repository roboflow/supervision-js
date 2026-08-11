import { useCallback, useMemo, useRef, useState } from "react";
import {
  MediaRendererPlaybackState,
  annotationRenderers,
  type MediaRendererPresentation,
} from "supervision";
import playerHatUrl from "../assets/player-hat.svg?url";
import { useDemoRenderer } from "../hooks/useDemoRenderer";
import { RendererViewport } from "./RendererViewport";

interface RegionPlaygroundSettings {
  readonly offsetY: number;
  readonly rotationDegrees: number;
  readonly scale: number;
}

const initialSettings: RegionPlaygroundSettings = {
  offsetY: -0.58,
  rotationDegrees: 0,
  scale: 1.35,
};

export function DocsRegionAnnotationRendererPlayground() {
  const settingsRef = useRef(initialSettings);
  const [settings, setSettings] = useState(initialSettings);
  const presentationTransform = useCallback(
    (presentation: MediaRendererPresentation): MediaRendererPresentation => ({
      ...presentation,
      renderers: [createHatRenderer(settingsRef.current)],
    }),
    [],
  );
  const demo = useDemoRenderer({
    initialFixtureId: "basketball_geometry",
    initialPresentationSettings: {
      boxesEnabled: false,
      focusEnabled: false,
      keypointsEnabled: false,
      labelsEnabled: false,
      masksEnabled: false,
      polygonsEnabled: false,
      polylinesEnabled: false,
    },
    presentationTransform,
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
  const snippet = useMemo(() => createSnippet(settings), [settings]);
  const updateSettings = useCallback(
    (next: RegionPlaygroundSettings) => {
      settingsRef.current = next;
      setSettings(next);
      demo.refreshPresentation();
    },
    [demo],
  );

  return (
    <main
      className="docs-layer-playground"
      aria-label="Asset region annotation renderer playground"
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
            <p>Annotation renderer</p>
            <h1>Asset Regions</h1>
            <span>Hat assets anchored to player keypoints</span>
          </div>
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
        </header>

        <div className="docs-layer-playground__controls">
          <RegionRangeControl
            label="Scale"
            max={2.2}
            min={0.5}
            onChange={(scale) =>
              updateSettings({ ...settingsRef.current, scale })
            }
            step={0.05}
            value={settings.scale}
            valueLabel={`${settings.scale.toFixed(2)}×`}
          />
          <RegionRangeControl
            label="Vertical offset"
            max={0.25}
            min={-1.25}
            onChange={(offsetY) =>
              updateSettings({ ...settingsRef.current, offsetY })
            }
            step={0.05}
            value={settings.offsetY}
            valueLabel={settings.offsetY.toFixed(2)}
          />
          <RegionRangeControl
            label="Rotation"
            max={45}
            min={-45}
            onChange={(rotationDegrees) =>
              updateSettings({ ...settingsRef.current, rotationDegrees })
            }
            step={1}
            value={settings.rotationDegrees}
            valueLabel={`${settings.rotationDegrees}°`}
          />
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

function RegionRangeControl({
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
    <label className="docs-layer-playground__range">
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

function createHatRenderer(settings: RegionPlaygroundSettings) {
  return annotationRenderers.region({
    compose: { mode: "over" },
    id: "player-hat",
    region: { anchor: "head", kind: "keypoint-anchor" },
    source: { asset: { src: playerHatUrl }, kind: "asset" },
    target: {
      className: ["white team player", "yellow team player"],
    },
    transform: {
      offset: { x: 0, y: settings.offsetY },
      rotation: (settings.rotationDegrees * Math.PI) / 180,
      scale: settings.scale,
    },
  });
}

function createSnippet(settings: RegionPlaygroundSettings) {
  return `session.setPresentation({
  renderers: [
    annotationRenderers.region({
      id: "player-hat",
      target: { className: ["white team player", "yellow team player"] },
      source: { kind: "asset", asset: { src: hatUrl } },
      region: { kind: "keypoint-anchor", anchor: "head" },
      transform: {
        scale: ${settings.scale.toFixed(2)},
        offset: { x: 0, y: ${settings.offsetY.toFixed(2)} },
        rotation: ${((settings.rotationDegrees * Math.PI) / 180).toFixed(2)},
      },
      compose: { mode: "over" },
    }),
  ],
});`;
}
