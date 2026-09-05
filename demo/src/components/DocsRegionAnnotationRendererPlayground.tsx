import { useCallback, useMemo, useRef, useState } from "react";
import {
  MediaRendererPlaybackState,
  type MediaRendererPresentation,
} from "supervision";
import playerFireUrl from "../assets/player-fire.gif?url";
import whiteTeamBadgeUrl from "../assets/white-team-badge.svg?url";
import yellowTeamBadgeUrl from "../assets/yellow-team-badge.svg?url";
import {
  createRegionPlaygroundRenderers,
  createRegionPlaygroundSettings,
  createRegionPlaygroundSnippet,
  initialRegionPlaygroundSettings,
  RegionPlaygroundMode,
  type RegionPlaygroundMode as RegionPlaygroundModeValue,
  type RegionPlaygroundSettings,
} from "../docs-region-annotation-renderer";
import { docsRegionPlaygroundPresentationSettings } from "../docs-annotation-renderer";
import { useDemoRenderer } from "../hooks/useDemoRenderer";
import { RendererViewport } from "./RendererViewport";
import { useViewportOverlay } from "../hooks/useViewportOverlay";

const regionPlaygroundAssets = {
  fireGif: playerFireUrl,
  whiteTeamBadge: whiteTeamBadgeUrl,
  yellowTeamBadge: yellowTeamBadgeUrl,
};

export function DocsRegionAnnotationRendererPlayground() {
  const settingsRef = useRef(initialRegionPlaygroundSettings);
  const [settings, setSettings] = useState(initialRegionPlaygroundSettings);
  const presentationTransform = useCallback(
    (presentation: MediaRendererPresentation): MediaRendererPresentation => ({
      ...presentation,
      renderers: [
        ...createRegionPlaygroundRenderers(
          settingsRef.current,
          regionPlaygroundAssets,
        ),
      ],
    }),
    [],
  );
  const demo = useDemoRenderer({
    initialFixtureId: "basketball_regions",
    initialPresentationSettings: docsRegionPlaygroundPresentationSettings,
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
    () => createRegionPlaygroundSnippet(settings),
    [settings],
  );
  const updateSettings = useCallback(
    (next: RegionPlaygroundSettings) => {
      settingsRef.current = next;
      setSettings(next);
      demo.refreshPresentation();
    },
    [demo],
  );
  const updateMode = useCallback(
    (mode: RegionPlaygroundModeValue) =>
      updateSettings(createRegionPlaygroundSettings(mode)),
    [updateSettings],
  );
  const showsIcons = settings.mode === RegionPlaygroundMode.StaticIcons;
  const showsMediaCrop = settings.mode === RegionPlaygroundMode.MediaCrop;

  const viewportOverlay = useViewportOverlay(
    demo.sessionState,
    null,
    demo.mediaState,
  );

  return (
    <main
      className="docs-layer-playground"
      aria-label="Region annotation renderer playground"
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
            <h1>Regions</h1>
            <span>
              {showsMediaCrop
                ? "Direct SAM3 head crops with transparent coverage"
                : showsIcons
                  ? "Class-specific SVG badges anchored to player keypoints"
                  : "Looping fire GIFs anchored to player keypoints"}
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
          <RegionModeControl onChange={updateMode} value={settings.mode} />
          {showsMediaCrop ? (
            <RegionRangeControl
              label="Head scale"
              max={3.5}
              min={1}
              onChange={(scale) =>
                updateSettings({ ...settingsRef.current, scale })
              }
              step={0.05}
              value={settings.scale}
              valueLabel={`${settings.scale.toFixed(2)}×`}
            />
          ) : (
            <RegionRangeControl
              label={showsIcons ? "Badge size" : "GIF size"}
              max={96}
              min={16}
              onChange={(assetSize) =>
                updateSettings({ ...settingsRef.current, assetSize })
              }
              step={1}
              value={settings.assetSize}
              valueLabel={`${settings.assetSize}px`}
            />
          )}
          <RegionRangeControl
            label="Vertical offset"
            max={0.25}
            min={-1.25}
            onChange={(offsetY) =>
              updateSettings({ ...settingsRef.current, offsetY })
            }
            step={0.01}
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
          {showsMediaCrop ? (
            <RegionFlipControl
              checked={settings.flipHorizontal}
              onChange={(flipHorizontal) =>
                updateSettings({
                  ...settingsRef.current,
                  flipHorizontal,
                })
              }
            />
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

function RegionModeControl({
  onChange,
  value,
}: {
  readonly onChange: (mode: RegionPlaygroundModeValue) => void;
  readonly value: RegionPlaygroundModeValue;
}) {
  return (
    <fieldset className="docs-layer-playground__asset-type docs-layer-playground__asset-type--sources">
      <legend>Region source</legend>
      <div>
        <label>
          <input
            checked={value === RegionPlaygroundMode.MediaCrop}
            name="region-source"
            onChange={() => onChange(RegionPlaygroundMode.MediaCrop)}
            type="radio"
          />
          <span>Big heads</span>
        </label>
        <label>
          <input
            checked={value === RegionPlaygroundMode.StaticIcons}
            name="region-source"
            onChange={() => onChange(RegionPlaygroundMode.StaticIcons)}
            type="radio"
          />
          <span>Team badges</span>
        </label>
        <label>
          <input
            checked={value === RegionPlaygroundMode.AnimatedGif}
            name="region-source"
            onChange={() => onChange(RegionPlaygroundMode.AnimatedGif)}
            type="radio"
          />
          <span>Animated GIF</span>
        </label>
      </div>
    </fieldset>
  );
}

function RegionFlipControl({
  checked,
  onChange,
}: {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <fieldset className="docs-layer-playground__asset-type docs-layer-playground__asset-type--single">
      <legend>Crop transform</legend>
      <div>
        <label>
          <input
            checked={checked}
            onChange={(event) => onChange(event.currentTarget.checked)}
            type="checkbox"
          />
          <span>Mirror horizontally</span>
        </label>
      </div>
    </fieldset>
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
