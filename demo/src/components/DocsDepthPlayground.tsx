import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  computeDepthPercentileRange,
  createMediaSession,
  MediaRendererPlaybackState,
  type DepthMap,
  type DepthQuantity,
  type MediaRendererState,
  type MediaSession,
} from "supervision";
import {
  DocsDepthRangeMode,
  createDocsDepthRenderer,
  describeDepthColourRange,
  initialDocsDepthSettings,
  roundRange,
  type DocsDepthSettings,
} from "../docs-depth";
import {
  createDemoFixtureMedia,
  demoFixtureCatalog,
  type DemoFixtureDefinition,
  type DemoFixtureDepthDefinition,
} from "../fixtures/demo-fixtures";
import { useDepthPointerReadout } from "../hooks/useDepthPointerReadout";
import { DepthReadoutPanel } from "./DepthReadoutPanel";
import { DepthLiveCode, DepthRendererControls } from "./DepthRendererControls";
import "./depth-playground.css";

const DEPTH_FIXTURE = "spring_stereo_depth";

/**
 * The depth renderer over the Spring stereo fixture: the left view of a
 * rendered shot, with the dataset's ground-truth disparity and a stereo
 * matcher's disparity as two layers. Clip depth is exact and drawn while
 * playback rests, so stepping is how a reader compares frames.
 */
export function DocsDepthPlayground() {
  const fixture = useMemo(requireDepthFixture, []);
  const depth = fixture.depth;
  const mountRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<MediaSession | null>(null);
  const [layerId, setLayerId] = useState(depth.defaultLayer);
  const [settings, setSettings] = useState(initialDocsDepthSettings);
  const [failure, setFailure] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [rendererState, setRendererState] = useState<MediaRendererState | null>(
    null,
  );
  const [shownMap, setShownMap] = useState<DepthMap | null>(null);
  const pointer = useDepthPointerReadout(
    useCallback(() => sessionRef.current?.renderer ?? null, []),
  );
  const refreshPointer = pointer.refresh;
  const settingsRef = useRef(settings);
  const layerRef = useRef(layerId);
  const sessionLayerRef = useRef<string | null>(null);

  settingsRef.current = settings;
  layerRef.current = layerId;

  useEffect(() => {
    const container = mountRef.current;
    let cancelled = false;
    let session: MediaSession | null = null;

    if (!container) return;

    void (async () => {
      try {
        const layer = layerFor(depth, layerRef.current);

        session = await createMediaSession({
          container,
          depth: { manifest: layer.manifestSrc },
          media: createDemoFixtureMedia(fixture),
          presentation: {
            renderers: [createDocsDepthRenderer(settingsRef.current)],
          },
          renderer: { autoPlay: false, loop: true },
        });
        if (cancelled) {
          session.destroy();
          return;
        }
        sessionRef.current = session;
        sessionLayerRef.current = layer.id;
        session.subscribe((state) => {
          setRendererState(state.renderer);
          refreshPointer();
        });
        setRendererState(session.getState().renderer);
        refreshPointer();
        setReady(true);
      } catch (error) {
        if (!cancelled) setFailure(String(error));
      }
    })();

    return () => {
      cancelled = true;
      sessionRef.current = null;
      sessionLayerRef.current = null;
      session?.destroy();
    };
  }, [depth, fixture, refreshPointer]);

  useEffect(() => {
    sessionRef.current?.setPresentation({
      renderers: [createDocsDepthRenderer(settings)],
    });
  }, [settings]);

  useEffect(() => {
    const session = sessionRef.current;

    setShownMap(null);
    if (!ready || !session?.setDepth || sessionLayerRef.current === layerId) {
      return;
    }
    sessionLayerRef.current = layerId;
    session
      .setDepth({ manifest: layerFor(depth, layerId).manifestSrc })
      .then(refreshPointer)
      .catch((error: unknown) => setFailure(String(error)));
  }, [depth, layerId, ready, refreshPointer]);

  useEffect(() => {
    if (pointer.active) setShownMap(pointer.active.map);
  }, [pointer.active]);

  const update = (patch: Partial<DocsDepthSettings>) =>
    setSettings((current) => ({ ...current, ...patch }));

  const lockRange = (quantity: DepthQuantity) => {
    const active = sessionRef.current?.renderer.getActiveDepth?.();
    const range = active
      ? computeDepthPercentileRange(active.map, { quantity })
      : null;

    if (!range) return false;
    update({
      manualRange: { max: roundRange(range.max), min: roundRange(range.min) },
      quantity,
      rangeMode: DocsDepthRangeMode.Manual,
    });
    return true;
  };

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
  const depthFrame = pointer.active?.frameIndex ?? null;
  const depthStatus = failure
    ? `Failed: ${failure}`
    : !ready
      ? "Opening the Spring clip…"
      : isPlaying
        ? "Playing: depth is drawn when paused"
        : depthFrame !== null && depthFrame === frame
          ? `Exact depth for frame ${frame}`
          : `Loading exact depth for frame ${frame ?? "…"}`;
  const layer = layerFor(depth, layerId);

  return (
    <main
      className="docs-layer-playground depth-playground"
      aria-label="Depth annotation renderer playground"
    >
      <section className="docs-layer-playground__stage">
        <div
          ref={mountRef}
          className="depth-playground__mount"
          onPointerLeave={pointer.onPointerLeave}
          onPointerMove={pointer.onPointerMove}
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
        <DepthRendererControls
          canLock={pointer.active !== null}
          colourRange={describeDepthColourRange(shownMap, settings)}
          onChange={update}
          onLock={lockRange}
          settings={settings}
        >
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
        </DepthRendererControls>
        <DepthReadoutPanel
          frameIndex={depthFrame}
          idleStatus={
            isPlaying
              ? "No depth while playing"
              : depthFrame === null
                ? "Loading depth…"
                : "Point at the picture"
          }
          kind={pointer.active?.map.kind}
          readout={pointer.readout}
        />
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

function layerFor(depth: DemoFixtureDepthDefinition, id: string) {
  return depth.layers.find((layer) => layer.id === id) ?? depth.layers[0]!;
}
