import { useEffect, useMemo, useRef, useState } from "react";
import {
  createMediaSession,
  MediaRendererPlaybackState,
  type DepthPlaybackSource,
  type MediaRendererState,
  type MediaSession,
} from "supervision";
import {
  createDepthLayerLoader,
  createDepthRenderer,
  createDepthSnippet,
  initialDepthSettings,
  type DepthLayerLoad,
  type DepthSettings,
} from "../depth";
import {
  createDemoFixtureMedia,
  demoFixtureCatalog,
  findDepthLayer,
  type DemoFixtureDefinition,
  type DemoFixtureDepthDefinition,
} from "../fixtures/demo-fixtures";
import { createDepthProbe, useDepthProbe } from "../hooks/depth-probe";
import { DepthControls, type DepthControlKit } from "./DepthControls";
import { DepthReadoutPanel } from "./DepthReadoutPanel";
import { toHexColor } from "./InspectorControls";
import "./depth-playground.css";

const DEPTH_FIXTURE = "spring_stereo_depth";

/**
 * The clip opens without depth and plays at once; each layer's depth loads
 * through `setDepth()`, whose promise says when it is up or why it is not.
 */
export function DocsDepthPlayground() {
  const fixture = useMemo(requireDepthFixture, []);
  const depth = fixture.depth;
  const mountRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<MediaSession | null>(null);
  const [layerId, setLayerId] = useState(depth.defaultLayer);
  const [settings, setSettings] = useState(initialDepthSettings);
  const [failure, setFailure] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [depthLoad, setDepthLoad] = useState<DepthLayerLoad>({
    status: "loading",
  });
  const [depthLoader] = useState(() => createDepthLayerLoader(setDepthLoad));
  const [depthNotice, setDepthNotice] = useState<string | null>(null);
  /** The preview is off: nothing is prepared ahead, and the reason is given. */
  const [previewOff, setPreviewOff] = useState(false);
  const [rendererState, setRendererState] = useState<MediaRendererState | null>(
    null,
  );
  const [probe] = useState(() =>
    createDepthProbe(() => sessionRef.current?.renderer ?? null),
  );
  const { active } = useDepthProbe(probe);
  const settingsRef = useRef(settings);
  const sessionLayerRef = useRef<string | null>(null);

  settingsRef.current = settings;

  useEffect(() => {
    const container = mountRef.current;
    let cancelled = false;
    let session: MediaSession | null = null;

    if (!container) return;

    void (async () => {
      try {
        session = await createMediaSession({
          container,
          media: createDemoFixtureMedia(fixture),
          presentation: {
            renderers: [createDepthRenderer(settingsRef.current)],
          },
          renderer: {
            autoPlay: false,
            loop: true,
            renderPreparation: { depth: { playback: depthPlaybackFromUrl() } },
          },
        });
        if (cancelled) {
          session.destroy();
          return;
        }
        sessionRef.current = session;
        session.subscribe((state) => {
          setRendererState(state.renderer);
          setDepthNotice(state.renderPreparation?.message ?? null);
          setPreviewOff(
            Boolean(state.renderPreparation?.message) &&
              state.renderPreparation?.artifacts.length === 0,
          );
          probe.refresh();
        });
        setRendererState(session.getState().renderer);
        probe.refresh();
        setReady(true);
      } catch (error) {
        if (!cancelled) setFailure(String(error));
      }
    })();

    return () => {
      cancelled = true;
      sessionRef.current = null;
      sessionLayerRef.current = null;
      setReady(false);
      session?.destroy();
    };
  }, [fixture, probe]);

  useEffect(() => {
    sessionRef.current?.setPresentation({
      renderers: [createDepthRenderer(settings)],
    });
  }, [settings]);

  useEffect(() => {
    const session = sessionRef.current;

    if (!ready || !session?.setDepth || sessionLayerRef.current === layerId) {
      return;
    }

    const manifest = findDepthLayer(depth, layerId).manifestSrc;

    sessionLayerRef.current = layerId;
    void depthLoader
      .load(() => session.setDepth!({ manifest }))
      .then(probe.refresh);
  }, [depth, depthLoader, layerId, probe, ready]);

  const session = sessionRef.current;
  const frameClock = session?.frameClock ?? null;
  const frameCount = frameClock?.frameCount ?? 0;
  const presentedTime =
    rendererState?.presentedTime ?? rendererState?.currentTime ?? null;
  const frame =
    frameClock && presentedTime !== null
      ? frameClock.indexAtOrBefore(presentedTime + 0.0005)
      : null;
  const isPlaying =
    rendererState?.playbackState === MediaRendererPlaybackState.Playing ||
    rendererState?.playbackState === MediaRendererPlaybackState.Buffering;
  const depthFrame = active?.frameIndex ?? null;
  const onScreen = depthFrame !== null && depthFrame === frame;
  const depthStatus = failure
    ? `Failed: ${failure}`
    : !ready
      ? "Opening the Spring clip…"
      : depthLoad.status === "failed"
        ? `Depth did not load: ${depthLoad.message}`
        : depthLoad.status === "loading"
          ? isPlaying
            ? "Playing: loading depth…"
            : "Loading depth…"
          : isPlaying
            ? onScreen
              ? active?.precision === "exact"
                ? `Playing: exact depth for frame ${frame}`
                : `Playing: 8-bit preview depth for frame ${frame}`
              : previewOff
                ? "Playing: depth shows once paused"
                : "Playing: decoding depth…"
            : onScreen && active?.precision === "exact"
              ? `Exact depth for frame ${frame}`
              : onScreen
                ? `Preview depth for frame ${frame}; loading exact…`
                : `Loading depth for frame ${frame ?? "…"}`;
  const layer = findDepthLayer(depth, layerId);

  return (
    <main
      className="docs-layer-playground depth-playground"
      aria-label="Depth annotation renderer playground"
    >
      <section className="docs-layer-playground__stage">
        <div
          ref={mountRef}
          className="depth-playground__mount"
          onPointerLeave={probe.onPointerLeave}
          onPointerMove={probe.onPointerMove}
        />
        <p className="depth-playground__badge">{layer.label}</p>
      </section>
      <section className="docs-layer-playground__panel">
        <header className="docs-layer-playground__header">
          <div>
            <p>Annotation renderer</p>
            <h1>Depth maps</h1>
            <span>Spring stereo clip, left view</span>
          </div>
          <button
            aria-label={isPlaying ? "Pause the clip" : "Play the clip"}
            disabled={!ready}
            onClick={() => void session?.renderer.togglePlayback()}
            type="button"
          >
            <span aria-hidden="true">{isPlaying ? "Ⅱ" : "▶"}</span>
            {isPlaying ? "Pause" : "Play"}
          </button>
        </header>
        <div className="depth-playground__transport">
          <button
            aria-label="Previous frame"
            disabled={!ready || frame === null || frame <= 0}
            onClick={() => void session?.stepBackward()}
            type="button"
          >
            ‹
          </button>
          <input
            aria-label="Frame"
            disabled={!ready || frameCount === 0}
            max={Math.max(0, frameCount - 1)}
            min={0}
            onChange={(event) =>
              void session?.frameNavigation?.moveToFrame(
                Number(event.currentTarget.value),
              )
            }
            step={1}
            type="range"
            value={frame ?? 0}
          />
          <button
            aria-label="Next frame"
            disabled={!ready || frame === null || frame >= frameCount - 1}
            onClick={() => void session?.stepForward()}
            type="button"
          >
            ›
          </button>
          <output aria-label="Frame on screen">
            {frame === null ? "—" : frame} / {Math.max(0, frameCount - 1)}
          </output>
        </div>
        <p aria-live="polite" className="depth-playground__status">
          {depthStatus}
        </p>
        {depthNotice ? (
          <p className="depth-playground__notice" role="status">
            {depthNotice}
          </p>
        ) : null}
        <div className="docs-layer-playground__controls">
          <fieldset className="docs-layer-playground__asset-type docs-layer-playground__asset-type--single">
            <legend>Depth layer</legend>
            <div>
              {depth.layers.map((option) => (
                <label key={option.id}>
                  <input
                    checked={option.id === layerId}
                    name="depth-layer"
                    onChange={() => setLayerId(option.id)}
                    type="radio"
                    value={option.id}
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <DepthControls
            kit={depthPlaygroundKit}
            onChange={(patch) =>
              setSettings((current) => ({ ...current, ...patch }))
            }
            probe={probe}
            settings={settings}
          />
        </div>
        <DepthReadoutPanel probe={probe} />
        <DepthLiveCode settings={settings} />
        <p className="depth-playground__note">
          Clip:{" "}
          <a
            href="https://spring-benchmark.org"
            rel="noreferrer"
            target="_blank"
          >
            Spring
          </a>{" "}
          sequence 0021 (Mehl et al., CVPR 2023) and the Spring movie by Blender
          Foundation, both{" "}
          <a
            href="https://creativecommons.org/licenses/by/4.0/"
            rel="noreferrer"
            target="_blank"
          >
            CC BY 4.0
          </a>
          . Downscaled to 1280x720; disparity stored at 1/1024 px. The matcher
          layer is OpenCV StereoSGBM on the stereo pair.
        </p>
      </section>
    </main>
  );
}

function requireDepthFixture(): DemoFixtureDefinition & {
  readonly depth: DemoFixtureDepthDefinition;
} {
  const fixture = demoFixtureCatalog.find(
    ({ sampleName }) => sampleName === DEPTH_FIXTURE,
  );

  if (!fixture?.depth) {
    throw new Error(`The ${DEPTH_FIXTURE} fixture with depth is missing.`);
  }

  return { ...fixture, depth: fixture.depth };
}

/** What plays, from `?depthPlayback=`; the library's default otherwise. */
function depthPlaybackFromUrl(): DepthPlaybackSource | undefined {
  const value =
    typeof location === "undefined"
      ? null
      : new URLSearchParams(location.search).get("depthPlayback");

  return value === "auto" || value === "exact" || value === "preview"
    ? value
    : undefined;
}

function DepthLiveCode({ settings }: { readonly settings: DepthSettings }) {
  return (
    <section
      className="docs-layer-playground__code"
      aria-label="Live presentation code"
    >
      <div>
        <span>Live code</span>
        <small>Values update with the controls</small>
      </div>
      <pre>
        <code>{createDepthSnippet(settings)}</code>
      </pre>
    </section>
  );
}

export const depthPlaygroundKit: DepthControlKit = {
  Choice: ({ disabled, label, onChange, options, tooltip, value }) => (
    <label className="docs-layer-playground__select" title={tooltip}>
      <strong>{label}</strong>
      <select
        disabled={disabled}
        onChange={(event) => {
          const picked = options.find(
            (option) => option.value === event.currentTarget.value,
          );
          if (picked) onChange(picked.value);
        }}
        value={value}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  ),
  Color: ({ disabled, label, onChange, value }) => (
    <label className="docs-layer-playground__select">
      <strong>{label}</strong>
      <input
        className="depth-playground__swatch"
        disabled={disabled}
        onChange={(event) =>
          onChange(Number.parseInt(event.currentTarget.value.slice(1), 16))
        }
        type="color"
        value={toHexColor(value)}
      />
    </label>
  ),
  Number: ({ disabled, label, onChange, value }) => (
    <label className="depth-playground__number">
      <strong>{label}</strong>
      <input
        disabled={disabled}
        onChange={(event) => {
          const raw = event.currentTarget.value.trim();
          if (raw !== "" && Number.isFinite(Number(raw))) onChange(Number(raw));
        }}
        step="any"
        type="number"
        value={value}
      />
    </label>
  ),
  Slider: ({ disabled, label, onChange, tooltip, value }) => (
    <label className="docs-layer-playground__range" title={tooltip}>
      <span>
        <strong>{label}</strong>
        <output>{Math.round(value * 100)}%</output>
      </span>
      <input
        disabled={disabled}
        max="1"
        min="0"
        onChange={(event) => onChange(Number(event.currentTarget.value))}
        step="0.05"
        type="range"
        value={value}
      />
    </label>
  ),
  Toggle: ({ checked, disabled, label, onChange, tooltip }) => (
    <label className="docs-layer-playground__toggle">
      <span>
        <strong>{label}</strong>
        {tooltip ? <small>{tooltip}</small> : null}
      </span>
      <input
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
        type="checkbox"
      />
    </label>
  ),
};
