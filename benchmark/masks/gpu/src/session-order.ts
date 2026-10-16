import { Application, BufferImageSource, Rectangle, Shader } from "pixi.js";
import {
  BaseBoxStyle,
  BasePolygonStyle,
  createMediaSession,
  DetectionMaskEncoding,
  MediaInteractionMode,
  RenderPreparationMode,
  RenderPreparationArtifactKind,
  RenderPreparationArtifactFrameStatus,
  StrokeAlignment,
  type Detection,
  type DetectionFrame,
  type MaskStyle,
  type MediaSession,
} from "supervision";
import {
  createWebVideoEngineMediaRendererSource,
  SourceKind,
} from "supervision/web-video-engine";
import { white256, white64, redMask, greenMask } from "./white-video";

const backend = new URLSearchParams(location.search).get("backend") ?? "webgl";
const stage = document.querySelector<HTMLDivElement>("#stage")!;
const status = document.querySelector<HTMLParagraphElement>("#status")!;
const output = document.querySelector<HTMLPreElement>("#output")!;
const shaders = new Set<Shader>();
let scene: WeakRef<Application>;
const init = Application.prototype.init;
Application.prototype.init = async function (options) {
  await init.call(this, options);
  scene = new WeakRef(this);
};
const from = Shader.from;
Shader.from = function (options) {
  const shader = from.call(this, options);
  shaders.add(shader);
  const destroy = shader.destroy;
  shader.destroy = function (...args) {
    shaders.delete(shader);
    return destroy.apply(this, args);
  };
  return shader;
};
let session: MediaSession;
let opacity = 0.5;
let mediaSize = 256;
let reversed = false;
let onlyRed = false;
let hidden = false;
let hideGreen = false;
let strokeWidth = 0;
let strokeUnit: "screen" | "mask" = "screen";
let alignment = StrokeAlignment.Outside;
let version = 0;
let count = 2;
let hovered: string | number | undefined;
let preparedBytes = 0;
let masksPrepared = false;
const results: unknown[] = [];
const maskContains = (id: string | number | undefined, x: number, y: number) =>
  id === "red"
    ? x >= 40 && x < 168 && y >= 40 && y < 168
    : x >= 96 &&
      x < 224 &&
      y >= 96 &&
      y < 224 &&
      !(x >= 120 && x < 136 && y >= 120 && y < 136);
const red = { ...redMask, encoding: DetectionMaskEncoding.CompressedRle };
const green = { ...greenMask, encoding: DetectionMaskEncoding.CompressedRle };

function detections(): Detection[] {
  const scale = mediaSize / 256;
  if (count > 2)
    return Array.from({ length: count }, (_, i) => [
      { id: `mask-${i}`, mask: green },
      {
        id: `box-${i}`,
        rect: {
          x: 160 * scale,
          y: 160 * scale,
          width: 32 * scale,
          height: 32 * scale,
        },
      },
    ]).flat();
  return [
    { id: "red", zIndex: reversed ? 3 : 0, mask: red },
    {
      id: "polygon",
      zIndex: reversed ? 2 : 1,
      polygon: {
        points: [
          [64, 64],
          [192, 64],
          [192, 192],
          [64, 192],
        ].map(([x, y]) => ({ x: x! * scale, y: y! * scale })),
      },
    },
    {
      id: "box",
      zIndex: reversed ? 1 : 2,
      rect: {
        x: 160 * scale,
        y: 160 * scale,
        width: 32 * scale,
        height: 32 * scale,
      },
    },
    { id: "green", zIndex: reversed ? 0 : 3, mask: green },
  ];
}
function maskStyle(): MaskStyle {
  return {
    artifactKey: onlyRed ? "red-coverage" : "both-coverage",
    opacity,
    resolve: (d, context) =>
      d.mask && (!onlyRed || d.id === "red")
        ? {
            mask: d.mask,
            color: d.id === "red" ? 0xff0000 : 0x00ff00,
            alpha: context.mediaTime >= 1 ? 0.25 : 0.5,
            stroke: {
              alpha: 1,
              color: 0,
              width: strokeWidth,
              widthUnit: strokeUnit,
              alignment,
            },
          }
        : undefined,
  };
}
function presentation() {
  return {
    backgroundColor: 0xffffff,
    maskStyle: maskStyle(),
    labelStyle: null,
    focusStyle: null,
    interactionStyle: null,
    annotationAntialiasing: false,
    boxStyle: onlyRed
      ? null
      : new BaseBoxStyle({
          shouldRender: (d) => d.id?.toString().startsWith("box") === true,
          fill: { alpha: 0.5, color: 0xffff00 },
          stroke: null,
        }),
    polygonStyle: onlyRed
      ? null
      : new BasePolygonStyle({
          fill: { alpha: 0.5, color: 0x0000ff },
          stroke: null,
        }),
    visibility: {
      annotationsHidden: hidden,
      hiddenDetectionIds: hideGreen ? ["green"] : [],
    },
  };
}
async function open(size: 64 | 256) {
  mediaSize = size;
  const bytes = Uint8Array.from(atob(size === 256 ? white256 : white64), (c) =>
    c.charCodeAt(0),
  );
  const blob = new Blob([bytes], { type: "video/mp4" });
  session = await createMediaSession({
    container: stage,
    normalize: false,
    media:
      backend === "webgpu"
        ? createWebVideoEngineMediaRendererSource({
            source: { kind: SourceKind.Blob, blob },
          })
        : blob,
    detections: {
      source: {
        getVersion: () => version,
        loadFrames: async () =>
          [0, 0.5, 1, 1.5].map((mediaTime, frameIndex): DetectionFrame => ({
            mediaTime,
            frameIndex,
            detections: detections(),
          })),
      },
    },
    presentation: presentation(),
    renderer: {
      autoPlay: false,
      loop: false,
      maxDevicePixelRatio: 1,
      maskOrder: "detection",
      interaction: {
        mode: MediaInteractionMode.Always,
        preferTopmost: true,
        onHover: (pick) => {
          hovered = pick?.detection.id;
        },
      },
      renderPreparation: {
        mode: RenderPreparationMode.MainThread,
        maskFrame: { prefetchFrameCount: 0 },
        onDiagnostics: (d) => {
          masksPrepared = d.artifacts.some(
            (a) =>
              a.kind === RenderPreparationArtifactKind.MaskFrame &&
              a.activeFrame?.status ===
                RenderPreparationArtifactFrameStatus.Prepared,
          );
          preparedBytes = d.artifacts.reduce(
            (total, a) => total + (a.preparedBytes ?? 0),
            0,
          );
        },
      },
    },
  });
  await session.seek(0);
}
function resources() {
  const sources = new Set(
    [...shaders].flatMap((s) =>
      s.resources.uTexture instanceof BufferImageSource
        ? [s.resources.uTexture]
        : [],
    ),
  );
  const arrays = new Set(
    [...shaders].flatMap((s) => {
      const uniforms = s.resources.maskUniforms as
        { uniforms?: Record<string, unknown> } | undefined;
      return Object.values(uniforms?.uniforms ?? {})
        .filter((v): v is Float32Array => v instanceof Float32Array)
        .map((v) => v.buffer);
    }),
  );
  return {
    shaders: shaders.size,
    sources: sources.size,
    sourceIds: [...sources].map((s) => s.uid).sort((a, b) => a - b),
    coverageBytes: [...sources].reduce(
      (n, s) =>
        n + (s.resource instanceof Uint8Array ? s.resource.byteLength : 0),
      0,
    ),
    paintBytes: [...arrays].reduce((n, a) => n + a.byteLength, 0),
    preparedBytes,
  };
}
function expected(x: number, y: number, time: number) {
  const rgb = [255, 255, 255];
  if (hidden) return { rgb, id: undefined };
  let id: string | number | undefined;
  for (const { d } of detections()
    .map((d, i) => ({ d, order: d.zIndex ?? i }))
    .sort((a, b) => a.order - b.order)) {
    const hit = d.mask
      ? maskContains(d.id, x, y)
      : d.polygon
        ? x >= 64 && x < 192 && y >= 64 && y < 192
        : x >= 144 && x < 176 && y >= 144 && y < 176;
    if ((onlyRed && d.id !== "red") || (hideGreen && d.id === "green"))
      continue;
    const scale = Math.abs(
      session.renderer.mediaToScreen({ x: mediaSize / 256, y: 0 }).x -
        session.renderer.mediaToScreen({ x: 0, y: 0 }).x,
    );
    const outsideDistance = Math.max(40 - x, x - 168, 40 - y, y - 168);
    const signedDistance =
      outsideDistance > 0
        ? outsideDistance
        : -Math.min(x - 40, 168 - x, y - 40, 168 - y);
    const fraction =
      alignment === StrokeAlignment.Inside
        ? 1
        : alignment === StrokeAlignment.Center
          ? 0.5
          : 0;
    const width = Math.min(
      strokeUnit === "mask" ? 2 * strokeWidth : strokeWidth / scale,
      16 / Math.max(fraction, 1 - fraction),
    );
    const outline =
      onlyRed &&
      strokeWidth > 0 &&
      signedDistance >= -width * fraction &&
      signedDistance < width * (1 - fraction);
    if (hit) id = d.id;
    if (hit || outline) {
      const color = outline
        ? [0, 0, 0]
        : d.mask
          ? d.id === "red"
            ? [255, 0, 0]
            : [0, 255, 0]
          : d.polygon
            ? [0, 0, 255]
            : [255, 255, 0];
      const alpha = outline
        ? opacity
        : d.mask
          ? opacity * (time >= 1 ? 0.25 : 0.5)
          : 0.5;
      rgb.forEach((v, i) => {
        rgb[i] = v * (1 - alpha) + color[i]! * alpha;
      });
    }
  }
  return { rgb, id };
}
async function probe(
  name: string,
  points = [
    [50, 50],
    [78, 78],
    [110, 110],
    [128, 128],
    [158, 158],
    [210, 210],
  ],
) {
  status.textContent = name;
  session.setPresentation(presentation());
  await session.refresh();
  const deadline = performance.now() + 10_000;
  while (
    !hidden &&
    !(
      session.renderer.getPreparedAnnotationWindow()?.playheadPrepared ??
      masksPrepared
    )
  ) {
    if (performance.now() > deadline)
      throw new Error(`${name}: mask preparation did not settle`);
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  }
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const canvas = stage.querySelector("canvas")!;
  const rect = canvas.getBoundingClientRect();
  const app = scene.deref()!;
  const extracted = app.renderer.extract.pixels({
    target: app.stage,
    frame: new Rectangle(0, 0, 256, 256),
    resolution: 1,
    antialias: false,
  });
  const samples = [];
  for (const [x, y] of points) {
    const p = session.renderer.mediaToScreen({
      x: (x! * mediaSize) / 256,
      y: (y! * mediaSize) / 256,
    });
    canvas.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        pointerType: "mouse",
        pointerId: 1,
        isPrimary: true,
        clientX: rect.left + p.x,
        clientY: rect.top + p.y,
      }),
    );
    const offset = (Math.floor(p.y) * extracted.width + Math.floor(p.x)) * 4;
    const actual = [...extracted.pixels.slice(offset, offset + 3)];
    const want = expected(
      x!,
      y!,
      session.renderer.getState().presentedTime ?? 0,
    );
    const error = Math.max(...actual.map((v, i) => Math.abs(v - want.rgb[i]!)));
    samples.push({
      x,
      y,
      actual,
      expected: want.rgb,
      error,
      picked: hovered ?? null,
      expectedId: want.id ?? null,
      passed: error <= 2 && hovered === want.id,
    });
  }
  const report = {
    name,
    backend: session.renderer.getState().rendererBackend,
    mediaSize,
    samples,
    resources: resources(),
  };
  results.push(report);
  output.textContent = JSON.stringify({ complete: false, results }, null, 2);
}
async function run() {
  await open(256);
  await probe("initial");
  hideGreen = true;
  await probe("hidden-top-mask");
  hideGreen = false;
  reversed = true;
  version += 1;
  await probe("reverse");
  const before = resources();
  opacity = 0.25;
  await probe("opacity");
  results.push({
    name: "opacity-reuse",
    passed:
      JSON.stringify(before.sourceIds) ===
        JSON.stringify(resources().sourceIds) &&
      before.shaders === resources().shaders,
  });
  await session.seek(1);
  await probe("timed-fill");
  const selected = session.renderer.setSelectedDetection({
    detectionId: "green",
  });
  results.push({
    name: "selection",
    passed: selected?.detection.id === "green",
  });
  await probe("selected-and-hovered");
  await session.seek(0);
  opacity = 0.5;
  onlyRed = true;
  strokeWidth = 8;
  await probe("outside-outline", [
    [34, 100],
    [50, 100],
  ]);
  alignment = StrokeAlignment.Inside;
  await probe("inside-outline", [
    [34, 100],
    [44, 100],
    [50, 100],
  ]);
  alignment = StrokeAlignment.Center;
  await probe("center-outline", [
    [34, 100],
    [38, 100],
    [42, 100],
    [50, 100],
  ]);
  alignment = StrokeAlignment.Outside;
  strokeWidth = 2;
  strokeUnit = "mask";
  await probe("mask-unit-outline", [
    [34, 100],
    [38, 100],
    [50, 100],
  ]);
  strokeWidth = 8;
  strokeUnit = "screen";
  session.renderer.setViewportTransform({ scale: 0.5 });
  await probe("zoomed-crop", [
    [26, 100],
    [50, 100],
  ]);
  session.renderer.setViewportTransform({ scale: 1 });
  hidden = true;
  await probe("hidden");
  hidden = false;
  onlyRed = false;
  strokeWidth = 0;
  await probe("shown");
  session.destroy();
  results.push({
    name: "destroy",
    passed: shaders.size === 0 && stage.querySelectorAll("canvas").length === 0,
    resources: resources(),
  });
  reversed = false;
  await open(64);
  await probe("new-source-size");
  count = 100;
  version += 1;
  await probe("alternating-100", [[158, 158]]);
  const scaled = resources();
  for (let i = 0; i < 3; i++) await probe("stable-100", [[158, 158]]);
  results.push({
    name: "stable-allocations",
    passed:
      scaled.shaders === resources().shaders &&
      JSON.stringify(scaled.sourceIds) ===
        JSON.stringify(resources().sourceIds),
  });
  count = 130;
  version += 1;
  await probe("mask-index-over-255", [[210, 210]]);
  session.destroy();
  results.push({
    name: "final-destroy",
    passed: shaders.size === 0 && stage.querySelectorAll("canvas").length === 0,
  });
  const passed = results.every((r) => {
    const result = r as {
      passed?: boolean;
      samples?: { passed: boolean }[];
      backend?: string;
    };
    return (
      result.passed ??
      (result.backend === backend && result.samples!.every((s) => s.passed))
    );
  });
  output.textContent = JSON.stringify(
    { complete: true, passed, backend, results },
    null,
    2,
  );
  status.textContent = passed ? "Passed" : "Failed";
}
void run().catch((error: unknown) => {
  session?.destroy();
  output.textContent = JSON.stringify(
    {
      complete: true,
      passed: false,
      error: String(error),
      stack: error instanceof Error ? error.stack : null,
      results,
    },
    null,
    2,
  );
  status.textContent = "Failed";
});
