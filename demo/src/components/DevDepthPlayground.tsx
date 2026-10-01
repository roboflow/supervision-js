import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  computeDepthPercentileRange,
  createMediaSession,
  createStaticImageMediaSource,
  createWebVideoEngineMediaRendererSource,
  type DepthMap,
  type DepthQuantity,
  type MediaRendererDepthInput,
  type MediaRendererSource,
  type MediaSession,
} from "supervision";
import { SourceKind } from "supervision/web-video-engine";
import {
  encodePng16,
  encodePng8Gray,
  PngFilter,
} from "../../../benchmark/depth/gpu/src/png-encode";
import {
  renderSyntheticDisparity,
  renderSyntheticImage,
} from "../../../benchmark/depth/gpu/src/synthetic-stereo";
import {
  DocsDepthRangeMode,
  createDocsDepthRenderer,
  describeDepthColourRange,
  initialDocsDepthSettings,
  roundRange,
  type DocsDepthSettings,
} from "../docs-depth";
import { useDepthPointerReadout } from "../hooks/useDepthPointerReadout";
import { DepthReadoutPanel } from "./DepthReadoutPanel";
import {
  DepthLiveCode,
  DepthRendererControls,
  PlaygroundSelect,
} from "./DepthRendererControls";
import "./depth-playground.css";

const MEDIA_WIDTH = 1280;
const MEDIA_HEIGHT = 720;
/** The yellow sphere swings to about half a metre from the camera here. */
const SCENE_TIME_SECONDS = 1.25;
/** The clip-wide colour range a producer would write: 2 m to 40 m. */
const NEAREST_M = 2;
const FARTHEST_M = 40;
const CLIP_FRAME_RATE = 30;

const MapResolution = { Full: "full", Half: "half" } as const;
type MapResolution = (typeof MapResolution)[keyof typeof MapResolution];

const Backend = { Image: "image", Engine: "engine" } as const;
type Backend = (typeof Backend)[keyof typeof Backend];

/** How the map reaches the session: as an array, or as files a producer wrote. */
const DepthInput = { Map: "map", Manifest: "manifest" } as const;
type DepthInput = (typeof DepthInput)[keyof typeof DepthInput];

/** A depth.json and its PNGs, written in the page as blob: URLs. */
interface SyntheticDepthFiles {
  readonly manifestUrl: string;
  readonly urls: readonly string[];
  readonly depthBytes: number;
  readonly confidenceBytes: number;
}

/**
 * Dev-only page for the depth renderer, fed by a synthetic scene generated in
 * the browser. It exists so the controls a docs playground will have can be
 * tried before a real stereo fixture is committed; `demo:build` never ships it.
 */
export function DevDepthPlayground() {
  const mountRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<MediaSession | null>(null);
  const mapsRef = useRef(new Map<MapResolution, DepthMap>());
  const filesRef = useRef(
    new Map<MapResolution, Promise<SyntheticDepthFiles>>(),
  );
  const [settings, setSettings] = useState(initialDocsDepthSettings);
  const [resolution, setResolution] = useState<MapResolution>(
    MapResolution.Full,
  );
  const [backend, setBackend] = useState<Backend>(Backend.Image);
  const [depthInput, setDepthInput] = useState<DepthInput>(DepthInput.Map);
  const [depthNote, setDepthNote] = useState("");
  const [status, setStatus] = useState("Generating the synthetic scene…");
  const [rendererBackend, setRendererBackend] = useState<string | null>(null);
  const pointer = useDepthPointerReadout(
    useCallback(() => sessionRef.current?.renderer ?? null, []),
  );
  const refreshPointer = pointer.refresh;
  const settingsRef = useRef(settings);
  const resolutionRef = useRef(resolution);
  const depthInputRef = useRef(depthInput);

  settingsRef.current = settings;
  resolutionRef.current = resolution;
  depthInputRef.current = depthInput;

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

  /**
   * The same map either as its array or as the files a producer would write:
   * a 16-bit PNG, an 8-bit confidence PNG and a depth.json naming them, all
   * blob: URLs, loaded through the session's manifest path.
   */
  const depthInputFor = async (
    next: MapResolution,
    input: DepthInput,
  ): Promise<MediaRendererDepthInput> => {
    const map = depthMapFor(next);

    if (input === DepthInput.Map) {
      setDepthNote("");
      return { map };
    }

    let files = filesRef.current.get(next);

    if (!files) {
      files = writeSyntheticDepthFiles(map);
      filesRef.current.set(next, files);
    }

    const written = await files;

    setDepthNote(
      `depth.json + ${formatMegabytes(written.depthBytes)} PNG16 (Up rows) + ${formatMegabytes(written.confidenceBytes)} confidence PNG, decoded in the session's worker`,
    );
    return { manifest: written.manifestUrl };
  };

  useEffect(
    () => () => {
      // The page's blob: URLs outlive sessions, not the page.
      for (const files of filesRef.current.values()) {
        void files.then(({ urls }) => urls.forEach(URL.revokeObjectURL));
      }
      filesRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    const container = mountRef.current;
    let cancelled = false;
    let session: MediaSession | null = null;

    if (!container) return;
    setStatus("Generating the synthetic scene…");
    setRendererBackend(null);

    void (async () => {
      try {
        const depth = await depthInputFor(
          resolutionRef.current,
          depthInputRef.current,
        );
        const media = await createSyntheticMedia(backend);

        if (cancelled) return;
        session = await createMediaSession({
          container,
          depth,
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
        session.subscribe(refreshPointer);
        refreshPointer();
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
  }, [backend, refreshPointer]);

  useEffect(() => {
    sessionRef.current?.setPresentation({
      renderers: [createDocsDepthRenderer(settings)],
    });
  }, [settings]);

  useEffect(() => {
    const session = sessionRef.current;

    if (!session?.setDepth) return;
    void depthInputFor(resolution, depthInput)
      .then((input) => session.setDepth?.(input))
      .catch((error: unknown) => setStatus(`Failed: ${String(error)}`));
  }, [resolution, depthInput]);

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

  const colourRange = useMemo(
    () => describeDepthColourRange(depthMapFor(resolution), settings),
    [resolution, settings],
  );

  return (
    <main
      className="docs-layer-playground depth-playground"
      aria-label="Depth annotation renderer development playground"
    >
      <section className="docs-layer-playground__stage">
        <div
          ref={mountRef}
          className="depth-playground__mount"
          onPointerLeave={pointer.onPointerLeave}
          onPointerMove={pointer.onPointerMove}
        />
        <p className="depth-playground__badge">
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
        <DepthRendererControls
          canLock={pointer.active !== null}
          colourRange={colourRange}
          onChange={update}
          onLock={lockRange}
          settings={settings}
        >
          <PlaygroundSelect
            label="Media path"
            onChange={(value) => setBackend(value as Backend)}
            options={[
              [Backend.Image, "Still image (WebGL)"],
              [Backend.Engine, "Video engine (WebGPU)"],
            ]}
            value={backend}
          />
          <PlaygroundSelect
            label="Depth input"
            onChange={(value) => setDepthInput(value as DepthInput)}
            options={[
              [DepthInput.Map, "In-memory map"],
              [DepthInput.Manifest, "depth.json + PNG16"],
            ]}
            value={depthInput}
          />
          {depthNote ? (
            <p className="depth-playground__note">{depthNote}</p>
          ) : null}
          <PlaygroundSelect
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
        </DepthRendererControls>
        <DepthReadoutPanel
          frameIndex={pointer.active?.frameIndex ?? null}
          kind={pointer.active?.map.kind}
          readout={pointer.readout}
        />
        <DepthLiveCode settings={settings} />
      </section>
    </main>
  );
}

/**
 * Writes the map as a producer would: the depth PNG with one Up filter on
 * every row, a confidence PNG, and a snake_case depth.json naming both.
 */
async function writeSyntheticDepthFiles(
  map: DepthMap,
): Promise<SyntheticDepthFiles> {
  if (map.samples.encoding !== "scaled16") {
    throw new Error("Only exact maps are written as PNG16.");
  }

  const depth = await encodePng16(
    map.width,
    map.height,
    map.samples.values,
    PngFilter.Up,
  );
  const confidence = await encodePng8Gray(
    map.width,
    map.height,
    syntheticConfidence(map),
    PngFilter.Up,
  );
  const depthUrl = URL.createObjectURL(
    new Blob([depth.bytes], { type: "image/png" }),
  );
  const confidenceUrl = URL.createObjectURL(
    new Blob([confidence.bytes], { type: "image/png" }),
  );
  const manifest = {
    camera: map.camera
      ? { baseline_m: map.camera.baselineM, fx_px: map.camera.fxPx }
      : undefined,
    display_range_px: map.displayRange
      ? [map.displayRange.min, map.displayRange.max]
      : undefined,
    height: map.height,
    image: { confidence_file: confidenceUrl, file: depthUrl },
    kind: map.kind,
    schema: "supervision.depth-manifest",
    storage: { format: "png16", no_depth: 0, scale: map.samples.scale },
    version: 1,
    view: map.view,
    width: map.width,
  };
  const manifestUrl = URL.createObjectURL(
    new Blob([JSON.stringify(manifest)], { type: "application/json" }),
  );

  return {
    confidenceBytes: confidence.bytes.byteLength,
    depthBytes: depth.bytes.byteLength,
    manifestUrl,
    urls: [manifestUrl, depthUrl, confidenceUrl],
  };
}

/**
 * A stand-in for a matcher's confidence: full on smooth surfaces, falling
 * with the disparity step to the next pixel, zero where there is no depth.
 */
function syntheticConfidence(map: DepthMap): Uint8Array {
  const { height, samples, width } = map;
  const values = samples.values;
  const scale = samples.encoding === "scaled16" ? samples.scale : 1;
  const confidence = new Uint8Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const here = values[i];

      if (here === 0) continue;

      const right = x + 1 < width ? values[i + 1] : here;
      const down = y + 1 < height ? values[i + width] : here;
      const step =
        Math.max(
          right === 0 ? 0 : Math.abs(right - here),
          down === 0 ? 0 : Math.abs(down - here),
        ) / scale;

      confidence[i] = Math.round(255 * Math.exp(-step / 2));
    }
  }

  return confidence;
}

function formatMegabytes(bytes: number) {
  return `${(bytes / 1e6).toFixed(2)} MB`;
}

function createSyntheticDepthMap(width: number, height: number): DepthMap {
  const disparity = renderSyntheticDisparity(width, height, SCENE_TIME_SECONDS);
  const focalBaseline = disparity.fxPx * disparity.baselineM;

  return {
    camera: { baselineM: disparity.baselineM, fxPx: disparity.fxPx },
    displayRange: {
      max: roundRange(focalBaseline / NEAREST_M),
      min: roundRange(focalBaseline / FARTHEST_M),
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
