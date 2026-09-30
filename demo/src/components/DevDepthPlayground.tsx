import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import {
  computeDepthPercentileRange,
  createMediaSession,
  createStaticImageMediaSource,
  createWebVideoEngineMediaRendererSource,
  readDepthAt,
  type DepthColormap,
  type DepthMap,
  type DepthQuantity,
  type DepthRange,
  type DepthReadout,
  type DepthSampling,
  type MediaRendererSource,
  type MediaSession,
} from "supervision";
import { SourceKind } from "supervision/web-video-engine";
import {
  renderSyntheticDisparity,
  renderSyntheticImage,
} from "../../../benchmark/depth/gpu/src/synthetic-stereo";
import {
  DocsDepthRangeMode,
  createDocsDepthRenderer,
  createDocsDepthSnippet,
  initialDocsDepthSettings,
  type DocsDepthSettings,
} from "../docs-depth";
import "./dev-depth-playground.css";

const MEDIA_WIDTH = 1280;
const MEDIA_HEIGHT = 720;
/** The yellow sphere swings to about half a metre from the camera here. */
const SCENE_TIME_SECONDS = 1.25;
/** The clip-wide colour range a producer would write: 2 m to 40 m. */
const NEAREST_M = 2;
const FARTHEST_M = 40;
const CLIP_FRAME_RATE = 30;

const colormaps: readonly DepthColormap[] = [
  "turbo",
  "viridis",
  "cividis",
  "inferno",
  "magma",
  "grayscale",
];
const samplings: readonly DepthSampling[] = ["auto", "nearest", "edge-aware"];

const MapResolution = { Full: "full", Half: "half" } as const;
type MapResolution = (typeof MapResolution)[keyof typeof MapResolution];

const Backend = { Image: "image", Engine: "engine" } as const;
type Backend = (typeof Backend)[keyof typeof Backend];

/**
 * Dev-only page for the depth renderer, fed by a synthetic scene generated in
 * the browser. It exists so the controls a docs playground will have can be
 * tried before a real stereo fixture is committed; `demo:build` never ships it.
 */
export function DevDepthPlayground() {
  const mountRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<MediaSession | null>(null);
  const mapsRef = useRef(new Map<MapResolution, DepthMap>());
  const [settings, setSettings] = useState(initialDocsDepthSettings);
  const [resolution, setResolution] = useState<MapResolution>(
    MapResolution.Full,
  );
  const [backend, setBackend] = useState<Backend>(Backend.Image);
  const [status, setStatus] = useState("Generating the synthetic scene…");
  const [rendererBackend, setRendererBackend] = useState<string | null>(null);
  const [readout, setReadout] = useState<DepthReadout | null>(null);
  const [noDepthHex, setNoDepthHex] = useState("#202020");
  const settingsRef = useRef(settings);
  const resolutionRef = useRef(resolution);

  settingsRef.current = settings;
  resolutionRef.current = resolution;

  const depthMapFor = (next: MapResolution) => {
    let map = mapsRef.current.get(next);

    if (!map) {
      map = createSyntheticDepthMap(
        next === MapResolution.Full ? MEDIA_WIDTH : MEDIA_WIDTH / 2,
        next === MapResolution.Full ? MEDIA_HEIGHT : MEDIA_HEIGHT / 2,
      );
      mapsRef.current.set(next, map);
    }

    return map;
  };

  useEffect(() => {
    const container = mountRef.current;
    let cancelled = false;
    let session: MediaSession | null = null;

    if (!container) return;
    setStatus("Generating the synthetic scene…");
    setRendererBackend(null);

    void (async () => {
      try {
        const map = depthMapFor(resolutionRef.current);
        const media = await createSyntheticMedia(backend);

        if (cancelled) return;
        session = await createMediaSession({
          container,
          depth: { map },
          media,
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
        setRendererBackend(
          session.getState().renderer?.rendererBackend ?? null,
        );
        setStatus("Ready");
      } catch (error) {
        if (!cancelled) setStatus(`Failed: ${String(error)}`);
      }
    })();

    return () => {
      cancelled = true;
      sessionRef.current = null;
      session?.destroy();
    };
  }, [backend]);

  useEffect(() => {
    sessionRef.current?.setPresentation({
      renderers: [createDocsDepthRenderer(settings)],
    });
  }, [settings]);

  useEffect(() => {
    void sessionRef.current?.setDepth?.({ map: depthMapFor(resolution) });
  }, [resolution]);

  const update = (patch: Partial<DocsDepthSettings>) =>
    setSettings((current) => ({ ...current, ...patch }));

  const lockRange = (quantity: DepthQuantity = settings.quantity) => {
    const active = sessionRef.current?.renderer.getActiveDepth?.();
    const range = active
      ? computeDepthPercentileRange(active.map, { quantity })
      : null;

    if (!range) return;
    update({
      manualRange: { max: round(range.max), min: round(range.min) },
      quantity,
      rangeMode: DocsDepthRangeMode.Manual,
    });
  };

  const readPointer = (event: PointerEvent<HTMLDivElement>) => {
    const session = sessionRef.current;
    const active = session?.renderer.getActiveDepth?.();

    if (!session || !active) {
      setReadout(null);
      return;
    }

    const box = event.currentTarget.getBoundingClientRect();
    const point = session.renderer.screenToMedia({
      x: event.clientX - box.left,
      y: event.clientY - box.top,
    });

    setReadout(
      readDepthAt(active.map, point, {
        height: active.mediaHeight,
        width: active.mediaWidth,
      }),
    );
  };

  const unit = settings.quantity === "depth" ? "m" : "px";
  const colourRange = useMemo(
    () => describeColourRange(depthMapFor(resolution), settings),
    [resolution, settings],
  );

  return (
    <main
      className="docs-layer-playground dev-depth-playground"
      aria-label="Depth annotation renderer development playground"
    >
      <section className="docs-layer-playground__stage">
        <div
          ref={mountRef}
          className="dev-depth-playground__mount"
          onPointerLeave={() => setReadout(null)}
          onPointerMove={readPointer}
        />
        <p className="dev-depth-playground__badge">
          Synthetic scene, not model output
        </p>
      </section>
      <section className="docs-layer-playground__panel">
        <header className="docs-layer-playground__header">
          <div>
            <p>Annotation renderer · dev only</p>
            <h1>Depth maps</h1>
            <span>
              {status}
              {rendererBackend ? ` · Pixi ${rendererBackend}` : ""}
            </span>
          </div>
        </header>
        <div className="docs-layer-playground__controls">
          <Select
            label="Media path"
            onChange={(value) => setBackend(value as Backend)}
            options={[
              [Backend.Image, "Still image (WebGL)"],
              [Backend.Engine, "Video engine (WebGPU)"],
            ]}
            value={backend}
          />
          <Select
            label="Map size"
            onChange={(value) => setResolution(value as MapResolution)}
            options={[
              [
                MapResolution.Full,
                `${MEDIA_WIDTH}x${MEDIA_HEIGHT} (media size)`,
              ],
              [
                MapResolution.Half,
                `${MEDIA_WIDTH / 2}x${MEDIA_HEIGHT / 2} (half)`,
              ],
            ]}
            value={resolution}
          />
          <Select
            label="Colormap"
            onChange={(value) => update({ colormap: value as DepthColormap })}
            options={colormaps.map((name) => [name, name])}
            value={settings.colormap}
          />
          <Select
            label="Quantity"
            onChange={(value) => {
              const quantity = value as DepthQuantity;
              if (settings.rangeMode === DocsDepthRangeMode.Manual) {
                lockRange(quantity);
              } else {
                update({ quantity });
              }
            }}
            options={[
              ["disparity", "Disparity (px)"],
              ["depth", "Depth (m)"],
            ]}
            value={settings.quantity}
          />
          <Select
            label="Range"
            onChange={(value) => {
              if (value === DocsDepthRangeMode.Manual) {
                lockRange();
              } else {
                update({ rangeMode: value as DocsDepthRangeMode });
              }
            }}
            options={[
              [DocsDepthRangeMode.Clip, "Clip (map's display range)"],
              [DocsDepthRangeMode.Auto, "Auto (2nd–98th percentile)"],
              [DocsDepthRangeMode.Manual, "Manual"],
            ]}
            value={settings.rangeMode}
          />
          {settings.rangeMode === DocsDepthRangeMode.Manual ? (
            <div className="dev-depth-playground__range-inputs">
              <NumberField
                label={`Min (${unit})`}
                onChange={(min) =>
                  update({ manualRange: { ...settings.manualRange, min } })
                }
                value={settings.manualRange.min}
              />
              <NumberField
                label={`Max (${unit})`}
                onChange={(max) =>
                  update({ manualRange: { ...settings.manualRange, max } })
                }
                value={settings.manualRange.max}
              />
              <button onClick={() => lockRange()} type="button">
                Lock to this frame
              </button>
            </div>
          ) : null}
          <p className="dev-depth-playground__note">{colourRange}</p>
          <Slider
            label="Opacity"
            onChange={(opacity) => update({ opacity })}
            value={settings.opacity}
          />
          <Slider
            label="Wipe"
            onChange={(wipe) => update({ wipe })}
            value={settings.wipe}
          />
          <Select
            label="Sampling"
            onChange={(value) => update({ sampling: value as DepthSampling })}
            options={samplings.map((name) => [name, name])}
            value={settings.sampling}
          />
          <label className="docs-layer-playground__toggle">
            <span>
              <strong>Paint pixels without depth</strong>
              <small>Off leaves them unpainted</small>
            </span>
            <span className="dev-depth-playground__no-depth">
              <input
                aria-label="No-depth colour"
                disabled={settings.noDepthColor === null}
                onChange={(event) => {
                  setNoDepthHex(event.currentTarget.value);
                  update({
                    noDepthColor: Number.parseInt(
                      event.currentTarget.value.slice(1),
                      16,
                    ),
                  });
                }}
                type="color"
                value={noDepthHex}
              />
              <input
                checked={settings.noDepthColor !== null}
                onChange={(event) =>
                  update({
                    noDepthColor: event.currentTarget.checked
                      ? Number.parseInt(noDepthHex.slice(1), 16)
                      : null,
                  })
                }
                type="checkbox"
              />
            </span>
          </label>
        </div>
        <section
          className="dev-depth-playground__readout"
          aria-label="Depth under the pointer"
        >
          <strong>Under the pointer</strong>
          {readout ? <ReadoutRows readout={readout} /> : <span>—</span>}
        </section>
        <section
          className="docs-layer-playground__code"
          aria-label="Live presentation code"
        >
          <div>
            <span>Live code</span>
            <small>Values update with the controls</small>
          </div>
          <pre>
            <code>{createDocsDepthSnippet(settings)}</code>
          </pre>
        </section>
      </section>
    </main>
  );
}

function ReadoutRows({ readout }: { readonly readout: DepthReadout }) {
  const rows: [string, string][] = [
    ["Map pixel", `${readout.x}, ${readout.y}`],
    ["Stored", String(readout.stored)],
  ];

  if (!readout.valid) {
    rows.push(["Depth", "no depth"]);
  } else {
    if (readout.depthM !== undefined) {
      rows.push(["Depth", `${readout.depthM.toFixed(3)} m`]);
    }
    if (readout.disparityPx !== undefined) {
      rows.push(["Disparity", `${readout.disparityPx.toFixed(3)} px`]);
    }
  }
  if (readout.step !== undefined) {
    rows.push(["Step", `${readout.step.toFixed(4)} px`]);
  }

  return (
    <dl>
      {rows.map(([name, value]) => (
        <div key={name}>
          <dt>{name}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Select(props: {
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly (readonly [string, string])[];
  readonly value: string;
}) {
  return (
    <label className="docs-layer-playground__select">
      <strong>{props.label}</strong>
      <select
        onChange={(event) => props.onChange(event.currentTarget.value)}
        value={props.value}
      >
        {props.options.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Slider(props: {
  readonly label: string;
  readonly onChange: (value: number) => void;
  readonly value: number;
}) {
  return (
    <label className="docs-layer-playground__range">
      <span>
        <strong>{props.label}</strong>
        <output>{Math.round(props.value * 100)}%</output>
      </span>
      <input
        max="1"
        min="0"
        onChange={(event) => props.onChange(Number(event.currentTarget.value))}
        step="0.05"
        type="range"
        value={props.value}
      />
    </label>
  );
}

function NumberField(props: {
  readonly label: string;
  readonly onChange: (value: number) => void;
  readonly value: number;
}) {
  return (
    <label>
      <strong>{props.label}</strong>
      <input
        onChange={(event) => {
          const value = Number(event.currentTarget.value);
          if (Number.isFinite(value)) props.onChange(value);
        }}
        step="any"
        type="number"
        value={props.value}
      />
    </label>
  );
}

function createSyntheticDepthMap(width: number, height: number): DepthMap {
  const disparity = renderSyntheticDisparity(width, height, SCENE_TIME_SECONDS);
  const focalBaseline = disparity.fxPx * disparity.baselineM;

  return {
    camera: { baselineM: disparity.baselineM, fxPx: disparity.fxPx },
    displayRange: {
      max: round(focalBaseline / NEAREST_M),
      min: round(focalBaseline / FARTHEST_M),
    },
    height,
    kind: "disparity_px",
    samples: {
      encoding: "scaled16",
      scale: disparity.scale,
      values: disparity.values,
    },
    view: "left",
    width,
  };
}

async function createSyntheticMedia(
  backend: Backend,
): Promise<MediaRendererSource> {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");

  if (!context) throw new Error("Unable to draw the synthetic scene.");
  canvas.width = MEDIA_WIDTH;
  canvas.height = MEDIA_HEIGHT;
  context.putImageData(
    new ImageData(
      renderSyntheticImage(MEDIA_WIDTH, MEDIA_HEIGHT, SCENE_TIME_SECONDS),
      MEDIA_WIDTH,
      MEDIA_HEIGHT,
    ),
    0,
    0,
  );

  if (backend === Backend.Image) {
    return createStaticImageMediaSource(canvas);
  }

  // The video engine presents through WebGPU, so the same still goes through
  // it as a one-second clip. (A single frame lasting the whole second stalls
  // the engine's first presentation, so the clip carries one per 1/30 s.)
  const { BufferTarget, CanvasSource, Mp4OutputFormat, Output, Quality } =
    await import("mediabunny");
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat(), target });
  const source = new CanvasSource(canvas, {
    codec: "avc",
    keyFrameInterval: 1,
    quality: new Quality({ bitrate: 8_000_000 }),
  });

  output.addVideoTrack(source, { frameRate: CLIP_FRAME_RATE });
  await output.start();
  for (let frame = 0; frame < CLIP_FRAME_RATE; frame += 1) {
    await source.add(frame / CLIP_FRAME_RATE, 1 / CLIP_FRAME_RATE);
  }
  await output.finalize();
  if (!target.buffer) throw new Error("Unable to encode the scene.");

  return createWebVideoEngineMediaRendererSource({
    source: {
      blob: new Blob([target.buffer], { type: "video/mp4" }),
      kind: SourceKind.Blob,
    },
  });
}

function describeColourRange(map: DepthMap, settings: DocsDepthSettings) {
  const unit = settings.quantity === "depth" ? "m" : "px";
  const focalBaseline = map.camera ? map.camera.fxPx * map.camera.baselineM : 1;
  let range: DepthRange | null;

  switch (settings.rangeMode) {
    case DocsDepthRangeMode.Manual:
      range = settings.manualRange;
      break;
    case DocsDepthRangeMode.Auto:
      range = computeDepthPercentileRange(map, { quantity: settings.quantity });
      break;
    default:
      range =
        map.displayRange && settings.quantity === "depth"
          ? {
              max: focalBaseline / map.displayRange.min,
              min: focalBaseline / map.displayRange.max,
            }
          : (map.displayRange ?? null);
  }

  if (!range) return "Colour range: not enough valid samples";
  const near = settings.quantity === "depth" ? range.min : range.max;
  const far = settings.quantity === "depth" ? range.max : range.min;

  return `Colour range: near ${round(near)} ${unit} (warm) to far ${round(far)} ${unit}`;
}

function round(value: number) {
  return Number(value.toFixed(3));
}
