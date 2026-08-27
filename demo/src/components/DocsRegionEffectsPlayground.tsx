import { useCallback, useMemo, useRef, useState } from "react";
import {
  MediaRendererPlaybackState,
  type MediaRendererPresentation,
} from "supervision";
import {
  createRegionEffectsPlaygroundPresentation,
  createRegionEffectsPlaygroundSettings,
  createRegionEffectsPlaygroundSnippet,
  initialRegionEffectsPlaygroundSettings,
  RegionEffectsPlaygroundMode,
  RegionEffectsPlaygroundTarget,
  type RegionEffectsPlaygroundMode as RegionEffectsPlaygroundModeValue,
  type RegionEffectsPlaygroundSettings,
  type RegionEffectsPlaygroundTarget as RegionEffectsPlaygroundTargetValue,
} from "../docs-region-effects";
import { useDemoRenderer } from "../hooks/useDemoRenderer";
import { RendererViewport } from "./RendererViewport";

export function DocsRegionEffectsPlayground() {
  const settingsRef = useRef(initialRegionEffectsPlaygroundSettings);
  const [settings, setSettings] = useState(
    initialRegionEffectsPlaygroundSettings,
  );
  const presentationTransform = useCallback(
    (presentation: MediaRendererPresentation) =>
      createRegionEffectsPlaygroundPresentation(
        settingsRef.current,
        presentation,
      ),
    [],
  );
  const demo = useDemoRenderer({
    initialFixtureId: "basketball_sam3",
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
  const snippet = useMemo(
    () => createRegionEffectsPlaygroundSnippet(settings),
    [settings],
  );
  const updateSettings = useCallback(
    (next: RegionEffectsPlaygroundSettings) => {
      settingsRef.current = next;
      setSettings(next);
      demo.refreshPresentation();
    },
    [demo],
  );
  const updateMode = useCallback(
    (mode: RegionEffectsPlaygroundModeValue) =>
      updateSettings(
        createRegionEffectsPlaygroundSettings(
          mode,
          settingsRef.current.targetClassName,
        ),
      ),
    [updateSettings],
  );
  const updateTarget = useCallback(
    (targetClassName: RegionEffectsPlaygroundTargetValue) =>
      updateSettings({
        ...settingsRef.current,
        targetClassName,
      }),
    [updateSettings],
  );
  const controlLabel =
    settings.mode === RegionEffectsPlaygroundMode.Blur
      ? "Blur strength"
      : "Pixel block size";
  const valueLabel = `${settings.intensity.toFixed(0)}px`;

  return (
    <main
      aria-label="Region effects annotation renderer playground"
      className="docs-layer-playground"
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
            <h1>Region effects</h1>
            <span>
              Prepared, exact-mask media effects on selected basketball players
            </span>
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
          <fieldset className="docs-layer-playground__asset-type docs-layer-playground__asset-type--sources">
            <legend>Effect</legend>
            <div>
              <EffectModeControl
                checked={settings.mode === RegionEffectsPlaygroundMode.Blur}
                label="Blur"
                onChange={() => updateMode(RegionEffectsPlaygroundMode.Blur)}
                value={RegionEffectsPlaygroundMode.Blur}
              />
              <EffectModeControl
                checked={settings.mode === RegionEffectsPlaygroundMode.Pixelate}
                label="Pixelate"
                onChange={() =>
                  updateMode(RegionEffectsPlaygroundMode.Pixelate)
                }
                value={RegionEffectsPlaygroundMode.Pixelate}
              />
            </div>
          </fieldset>
          <fieldset className="docs-layer-playground__asset-type docs-layer-playground__asset-type--sources">
            <legend>Apply to</legend>
            <div>
              <TargetControl
                checked={
                  settings.targetClassName ===
                  RegionEffectsPlaygroundTarget.YellowTeam
                }
                label="Yellow team"
                onChange={() =>
                  updateTarget(RegionEffectsPlaygroundTarget.YellowTeam)
                }
                value={RegionEffectsPlaygroundTarget.YellowTeam}
              />
              <TargetControl
                checked={
                  settings.targetClassName ===
                  RegionEffectsPlaygroundTarget.WhiteTeam
                }
                label="White team"
                onChange={() =>
                  updateTarget(RegionEffectsPlaygroundTarget.WhiteTeam)
                }
                value={RegionEffectsPlaygroundTarget.WhiteTeam}
              />
            </div>
          </fieldset>
          <label className="docs-layer-playground__range">
            <span>
              <strong>{controlLabel}</strong>
              <output>{valueLabel}</output>
            </span>
            <input
              max={32}
              min={2}
              onChange={(event) =>
                updateSettings({
                  ...settingsRef.current,
                  intensity: Number(event.currentTarget.value),
                })
              }
              step={1}
              type="range"
              value={settings.intensity}
            />
          </label>
        </div>

        <section
          aria-label="Live presentation code"
          className="docs-layer-playground__code"
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

function TargetControl({
  checked,
  label,
  onChange,
  value,
}: {
  readonly checked: boolean;
  readonly label: string;
  readonly onChange: () => void;
  readonly value: RegionEffectsPlaygroundTargetValue;
}) {
  return (
    <label>
      <input
        checked={checked}
        name="region-effect-target"
        onChange={onChange}
        type="radio"
        value={value}
      />
      <span>{label}</span>
    </label>
  );
}

function EffectModeControl({
  checked,
  label,
  onChange,
  value,
}: {
  readonly checked: boolean;
  readonly label: string;
  readonly onChange: () => void;
  readonly value: RegionEffectsPlaygroundModeValue;
}) {
  return (
    <label>
      <input
        checked={checked}
        name="region-effect"
        onChange={onChange}
        type="radio"
        value={value}
      />
      <span>{label}</span>
    </label>
  );
}
