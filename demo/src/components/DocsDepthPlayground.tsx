import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createMediaSession,
  MediaRendererPlaybackState,
  type DepthMap,
  type DepthQuantity,
  type MediaRendererState,
  type MediaSession,
} from "supervision";
import {
  createDocsDepthRenderer,
  lockDepthRange,
  resolveDepthColourRange,
  initialDocsDepthSettings,
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

/** Where the depth for the layer picked stands. */
type DepthLoad =
  | { readonly status: "loading" }
  | { readonly status: "ready" }
  | { readonly status: "failed"; readonly message: string };

/**
 * The depth renderer over the Spring stereo fixture: the left view of a
 * rendered shot, with the dataset's ground-truth disparity and a stereo
 * matcher's disparity as two layers. While the clip plays, each frame's
 * 8-bit preview depth is drawn; once it rests, the exact frame replaces it.
 *
 * The clip opens without depth and plays at once; each layer's depth loads
 * through `setDepth()`, which says when it is up or why it is not.
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
  const [depthLoad, setDepthLoad] = useState<DepthLoad>({ status: "loading" });
  /** What the depth diagnostics say, such as why the preview is off. */
  const [depthNotice, setDepthNotice] = useState<string | null>(null);
  /** The preview is off: nothing is prepared ahead, and the reason is given. */
  const [previewOff, setPreviewOff] = useState(false);
  const [rendererState, setRendererState] = useState<MediaRendererState | null>(
    null,
  );
  const [shownMap, setShownMap] = useState<DepthMap | null>(null);
  const pointer = useDepthPointerReadout(
    useCallback(() => sessionRef.current?.renderer ?? null, []),
  );
  const refreshPointer = pointer.refresh;
  const settingsRef = useRef(settings);
  const sessionLayerRef = useRef<string | null>(null);
  const depthRequestRef = useRef(0);

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
            renderers: [createDocsDepthRenderer(settingsRef.current)],
          },
          renderer: { autoPlay: false, loop: true },
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
      setReady(false);
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

    const request = ++depthRequestRef.current;
    const settled = (next: DepthLoad) => {
      if (request === depthRequestRef.current) setDepthLoad(next);
    };

    sessionLayerRef.current = layerId;
    setDepthLoad({ status: "loading" });
    session
      .setDepth({ manifest: layerFor(depth, layerId).manifestSrc })
      .then(() => {
        settled({ status: "ready" });
        refreshPointer();
      })
      .catch((error: unknown) =>
        settled({ message: String(error), status: "failed" }),
      );
  }, [depth, layerId, ready, refreshPointer]);

  useEffect(() => {
    if (pointer.active) setShownMap(pointer.active.map);
  }, [pointer.active]);

  const update = (patch: Partial<DocsDepthSettings>) =>
    setSettings((current) => ({ ...current, ...patch }));

  const lockRange = (quantity: DepthQuantity) =>
    lockDepthRange(
      sessionRef.current?.renderer.getActiveDepth?.()?.map,
      quantity,
    );

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
              ? `Playing: 8-bit preview depth for frame ${frame}`
              : previewOff
                ? "Playing: depth shows once paused"
                : "Playing: decoding preview depth…"
            : onScreen && pointer.active?.precision === "exact"
              ? `Exact depth for frame ${frame}`
              : onScreen
                ? `Preview depth for frame ${frame}; loading exact…`
                : `Loading depth for frame ${frame ?? "…"}`;
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
        {depthNotice ? (
          <p className="depth-playground__notice" role="status">
            {depthNotice}
          </p>
        ) : null}
        <DepthRendererControls
          canLock={pointer.active !== null}
          colourRange={resolveDepthColourRange(shownMap, settings)}
          onChange={update}
          lockRange={lockRange}
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
            depthFrame === null ? "Loading depth…" : "Point at the picture"
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
