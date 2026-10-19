import * as Pixi from "pixi.js";
import { annotationRenderers, encodeBinaryMask } from "supervision-js-core";
import { createBenchBackend } from "../../benchmark/depth/gpu/src/pixi-backend.ts";
import { createPixiRegionLayer } from "#renderers/pixi-region-layer";
import { resolvePixiAnnotationAntialiasResolution } from "#renderers/pixi-annotation-antialias";
import { installPixiFilterBindings } from "#renderers/pixi-filter-bindings";
import { installPixiBatchTextureBindings } from "#renderers/pixi-batch-texture-bindings";
import { comparePixels, png } from "./pixels.mjs";

const WIDTH = 192;
const HEIGHT = 144;
const CROP = { x: 16, y: 8, width: 64, height: 48 };
const RECT = { x: 48, y: 32, width: CROP.width, height: CROP.height };
const TRANSFORM = {
  scale: 1.8,
  rotation: 0.38,
  offset: { x: 0.625, y: 0.7 },
  flip: { horizontal: true },
};
const POLYGON = [
  { x: 5, y: 5 },
  { x: 55, y: 7 },
  { x: 51, y: 42 },
  { x: 9, y: 39 },
];
const CAMERAS = [
  { name: "centered", scale: 1, x: 0, y: 0 },
  { name: "zoom-pan", scale: 3, x: -319, y: -133 },
];
const MODES = [
  { name: "off", value: false, scale: 1 },
  { name: "fxaa1", value: true, scale: 1 },
  { name: "fxaa2", value: 2, scale: 2 },
  { name: "off-restored", value: false, scale: 1 },
];

/** Verifies coverage AA without resolving the copied media through its filter. */
export async function probeRegionMediaAntialias(requested) {
  const cases = [],
    images = [],
    errors = [],
    warnings = [],
    pooledTargets = [];
  let backend,
    stage,
    layer,
    target,
    media,
    coverage,
    releaseBindings,
    releaseBatch;
  let mode = MODES[0],
    captureResolution = 2,
    camera = CAMERAS[0],
    phase = "opening";
  let scoped = false;
  const originalPool = Pixi.TexturePool.getOptimalTexture;
  const originalWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map(String).join(" "));
    originalWarn(...args);
  };
  try {
    backend = await createBenchBackend(requested);
    if (backend.description.rendererName !== requested)
      throw Error("region media probe backend silently fell back");
    const device = backend.app.renderer.gpu?.device;
    device?.addEventListener("uncapturederror", (event) =>
      errors.push(String(event.error)),
    );
    if (device) {
      device.pushErrorScope("validation");
      scoped = true;
    }
    releaseBindings = installPixiFilterBindings(Pixi, backend.app.renderer);
    releaseBatch = installPixiBatchTextureBindings(Pixi, backend.app.renderer);
    backend.app.renderer.resize(WIDTH, HEIGHT, 1);
    const fixture = createFixture();
    media = fixture.media;
    coverage = fixture.coverage;
    layer = createPixiRegionLayer({
      ...Pixi,
      detectionTimeline: { selectFrame: () => fixture.frame },
      regionRenderers: [],
      getAnnotationAntialiasing: () => Boolean(mode.value),
      getAntialiasResolution: () => captureResolution,
      getViewportBounds: () => ({
        x: -camera.x / camera.scale,
        y: -camera.y / camera.scale,
        width: WIDTH / camera.scale,
        height: HEIGHT / camera.scale,
      }),
      getActiveRegionMaskCoverage: (time) =>
        time === 0 ? fixture.artifact : null,
      getMediaTexture: () => media,
    });
    stage = new Pixi.Container();
    const display = layer.createContainer();
    stage.addChild(display);
    target = Pixi.RenderTexture.create({
      width: WIDTH,
      height: HEIGHT,
      resolution: 1,
    });
    Pixi.TexturePool.getOptimalTexture = function (...args) {
      const resolution = args[2] ?? 1;
      const pixelSize = (size) =>
        2 **
        Math.ceil(Math.log2(Math.max(1, Math.ceil(size * resolution - 1e-6))));
      const limit = backend.description.maxTextureSize;
      const requestedPixelWidth = pixelSize(args[0]);
      const requestedPixelHeight = pixelSize(args[1]);
      const guarded =
        Math.max(requestedPixelWidth, requestedPixelHeight) > limit;
      const row = {
        phase,
        requestedWidth: args[0],
        requestedHeight: args[1],
        resolution,
        requestedPixelWidth,
        requestedPixelHeight,
        guarded,
      };
      pooledTargets.push(row);
      if (guarded) {
        errors.push(
          `${phase}: production requested a pooled texture beyond backend limit`,
        );
        args[2] = Math.min(
          resolution,
          2 ** Math.floor(Math.log2(limit)) /
            Math.max(1, Math.ceil(args[0]), Math.ceil(args[1])),
        );
      }
      const result = originalPool.apply(this, args);
      row.allocatedPixelWidth = result.source.pixelWidth;
      row.allocatedPixelHeight = result.source.pixelHeight;
      return result;
    };
    const capture = async () => {
      backend.app.renderer.render({ container: stage, target, clear: true });
      await backend.finish(target);
      const pixels = await backend.readPixels(target);
      const gl = backend.app.renderer.gl;
      if (gl)
        for (let i = 0; i < 16; i++) {
          const code = gl.getError();
          if (!code) break;
          errors.push(`${phase}: WebGL error 0x${code.toString(16)}`);
        }
      return pixels;
    };
    for (camera of CAMERAS) {
      display.scale.set(camera.scale);
      display.position.set(camera.x, camera.y);
      mode = MODES[0];
      phase = `${camera.name}/unmasked-control`;
      layer.setRenderers([descriptor()]);
      const controlState = layer.drawFrame(0, camera.scale);
      if (
        controlState.activeDetectionIndexes.length !== 1 ||
        controlState.activeDetectionIndexes[0] !== 0
      )
        errors.push(`${phase}: control region detection was not drawn`);
      layer.syncViewportBounds();
      const control = await capture();
      images.push({
        name: `region-media.${camera.name}.control`,
        png: png(control, WIDTH, HEIGHT),
      });
      for (const kind of ["rect", "polygon", "mask"]) {
        const captures = new Map();
        for (mode of MODES) {
          phase = `${camera.name}/${kind}/${mode.name}`;
          captureResolution = resolvePixiAnnotationAntialiasResolution(
            1,
            { width: WIDTH, height: HEIGHT },
            backend.description.maxTextureSize,
            mode.scale,
          );
          layer.setAntialiasResolution(captureResolution);
          layer.setRenderers([descriptor(kind)]);
          const state = layer.drawFrame(0, camera.scale);
          layer.syncViewportBounds();
          const pixels = await capture();
          captures.set(mode.name, pixels);
          const stats = inspectPixels(pixels, control, kind, camera);
          const row = {
            phase,
            mode: mode.value,
            requestedScale: mode.scale,
            captureResolution: mode.value ? captureResolution : null,
            activeDetectionIndexes: state.activeDetectionIndexes,
            ...stats,
          };
          cases.push(row);
          if (
            state.activeDetectionIndexes.length !== 1 ||
            state.activeDetectionIndexes[0] !== 0
          )
            errors.push(`${phase}: region detection was not drawn`);
          if (stats.interiorPixels < 128 || stats.outsidePixels < 128)
            errors.push(
              `${phase}: insufficient interior/outside oracle coverage`,
            );
          if (
            stats.interiorChangedPixels > stats.nearestSamplerSeamChanges ||
            stats.controlNonOpaqueInteriorPixels ||
            stats.distinctInteriorColors < 8 ||
            stats.outsideNonzeroPixels ||
            stats.whiteMaskLeakPixels
          )
            errors.push(
              `${phase}: copied-media/coverage pixel invariant failed`,
            );
          images.push({
            name: `region-media.${camera.name}.${kind}.${mode.name}`,
            png: png(pixels, WIDTH, HEIGHT),
          });
        }
        const off = captures.get("off");
        const restored = comparePixels(
          off,
          captures.get("off-restored"),
          WIDTH,
        );
        const modeComparisons = Object.fromEntries(
          MODES.slice(1, -1).map(({ name }) => [
            name,
            comparePixels(off, captures.get(name), WIDTH),
          ]),
        );
        const fxaa = modeComparisons.fxaa1;
        const finer = modeComparisons.fxaa2;
        cases.push({
          phase: `${camera.name}/${kind}/toggle-parity`,
          restored,
          fxaa,
          finer,
          modeComparisons,
        });
        if (!restored.exact)
          errors.push(`${camera.name}/${kind}: AA-off pixels did not restore`);
        if (fxaa.exact || finer.exact)
          errors.push(
            `${camera.name}/${kind}: AA did not alter coverage edge pixels`,
          );
      }
    }
    if (device) {
      const error = await device.popErrorScope();
      scoped = false;
      if (error) errors.push(String(error));
    }
  } catch (error) {
    errors.push(`${phase}: ${String(error)}`);
  } finally {
    Pixi.TexturePool.getOptimalTexture = originalPool;
    try {
      if (scoped) {
        const error = await backend.app.renderer.gpu.device.popErrorScope();
        if (error) errors.push(String(error));
      }
      releaseBatch?.();
      releaseBindings?.();
      layer?.destroy();
      stage?.destroy({ children: true });
      media?.destroy(true);
      coverage?.destroy(true);
      target?.destroy(true);
      backend?.destroy();
    } catch (error) {
      errors.push(`cleanup: ${String(error)}`);
    } finally {
      console.warn = originalWarn;
    }
  }
  if (warnings.length) errors.push("region media probe emitted warnings");
  return {
    backend: backend?.description,
    nativeDpr: globalThis.devicePixelRatio,
    output: { width: WIDTH, height: HEIGHT, resolution: 1 },
    transform: TRANSFORM,
    cameras: CAMERAS,
    modes: MODES,
    allocationGuardUsed: pooledTargets.some((row) => row.guarded),
    cases,
    pooledTargets,
    images,
    errors,
    warnings,
    definition:
      "Actual RegionLayer copies a high-frequency nearest-sampled RGBA media crop with rotation and horizontal mirror. Rectangular, polygon and prepared exact-mask coverage are tested at centered and zoomed/panned cameras, Off→FXAA1/2→Off. Pixels at least two source pixels inside coverage must match an unmasked copied-media control byte for byte. The sole RGB exception is an explicitly recorded float32 nearest-sampler tie within0.001 source pixels of a texel boundary: both colors must be exact adjacent original texels, and alpha must remain255. Outside pixels must be transparent, with no white-mask leakage. Every enabled mode's edge differences are reported; FXAA1/2 must alter coverage pixels. Actual pooled texture requests are recorded before allocation; oversized requests fail and are guarded by lower resolution, so guarded pixels are not production correctness evidence. Functional evidence only, without timing or resident-memory claims.",
  };
}

function descriptor(kind) {
  return annotationRenderers.region({
    id: "pixel-copy",
    target: {},
    region: { kind: "bounds" },
    transform: TRANSFORM,
    source: {
      kind: "media",
      region: { kind: "bounds" },
      ...(kind === "mask" || kind === "polygon" ? { coverage: { kind } } : {}),
    },
  });
}

function texture(resource, width, height, format) {
  return new Pixi.Texture({
    source: new Pixi.BufferImageSource({
      resource,
      width,
      height,
      format,
      scaleMode: "nearest",
      alphaMode: "no-premultiply-alpha",
      autoGenerateMipmaps: false,
    }),
  });
}

function createFixture() {
  const data = new Uint8Array(96 * 64 * 4);
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 96; x++) {
      const i = (y * 96 + x) * 4;
      data.set(fixtureColor(x, y), i);
    }
  const raster = new Uint8Array(CROP.width * CROP.height);
  const semantic = new Uint8Array(96 * 64);
  for (let y = 0; y < CROP.height; y++)
    for (let x = 0; x < CROP.width; x++) {
      if (polygonDistance(x + 0.5, y + 0.5) <= 0) continue;
      raster[y * CROP.width + x] = 255;
      semantic[(CROP.y + y) * 96 + CROP.x + x] = 1;
    }
  const coverage = texture(raster, CROP.width, CROP.height, "r8unorm");
  const entry = { ...CROP, detectionIndex: 0, data: raster };
  return {
    media: texture(data, 96, 64, "rgba8unorm"),
    coverage,
    frame: {
      mediaTime: 0,
      frameIndex: 0,
      detections: [
        {
          id: "copy",
          rect: RECT,
          mask: encodeBinaryMask(semantic, 96, 64),
          polygon: {
            points: POLYGON.map((point) => ({
              x: CROP.x + point.x,
              y: CROP.y + point.y,
            })),
          },
        },
      ],
    },
    artifact: { frame: { entries: [entry] }, getTexture: () => coverage },
  };
}

function polygonDistance(x, y) {
  return Math.min(
    ...POLYGON.map((from, i) => {
      const to = POLYGON[(i + 1) % POLYGON.length];
      const dx = to.x - from.x,
        dy = to.y - from.y;
      return (dx * (y - from.y) - dy * (x - from.x)) / Math.hypot(dx, dy);
    }),
  );
}

function fixtureColor(x, y) {
  return [
    20 + ((x * 79 + y * 37) % 192),
    25 + ((x * 29 + y * 83) % 180),
    35 + ((x * 61 + y * 19) % 164),
    255,
  ];
}

function nearestSamplerTie(pixels, control, i, u, v) {
  const xs = new Set([Math.floor(u)]);
  const ys = new Set([Math.floor(v)]);
  const nearX = Math.abs(u - Math.round(u)) < 0.001;
  const nearY = Math.abs(v - Math.round(v)) < 0.001;
  if (!nearX && !nearY) return false;
  if (nearX) xs.add(Math.round(u) - 1).add(Math.round(u));
  if (nearY) ys.add(Math.round(v) - 1).add(Math.round(v));
  const candidates = [];
  for (const x of xs)
    for (const y of ys) candidates.push(fixtureColor(CROP.x + x, CROP.y + y));
  return [pixels, control].every((image) =>
    candidates.some((color) => color.every((byte, c) => image[i + c] === byte)),
  );
}

function inspectPixels(pixels, control, kind, camera) {
  const stats = {
    interiorPixels: 0,
    interiorChangedPixels: 0,
    controlNonOpaqueInteriorPixels: 0,
    maxInteriorByteDelta: 0,
    nearestSamplerSeamChanges: 0,
    nearestSamplerSeamExamples: [],
    outsidePixels: 0,
    outsideNonzeroPixels: 0,
    whiteMaskLeakPixels: 0,
    partialCoveragePixels: 0,
  };
  const cosine = Math.cos(TRANSFORM.rotation),
    sine = Math.sin(TRANSFORM.rotation);
  const colors = new Set();
  for (let y = 0; y < HEIGHT; y++)
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 4,
        alpha = pixels[i + 3];
      const dx =
        (x + 0.5 - camera.x) / camera.scale -
        RECT.x -
        TRANSFORM.offset.x * RECT.width;
      const dy =
        (y + 0.5 - camera.y) / camera.scale -
        RECT.y -
        TRANSFORM.offset.y * RECT.height;
      const u = CROP.width / 2 - (dx * cosine + dy * sine) / TRANSFORM.scale;
      const v = CROP.height / 2 + (-dx * sine + dy * cosine) / TRANSFORM.scale;
      const distance = Math.min(
        u,
        CROP.width - u,
        v,
        CROP.height - v,
        kind === "rect" ? Infinity : polygonDistance(u, v),
      );
      if (distance >= 2) {
        stats.interiorPixels++;
        stats.controlNonOpaqueInteriorPixels += Number(control[i + 3] !== 255);
        colors.add((control[i] << 16) | (control[i + 1] << 8) | control[i + 2]);
        let delta = 0;
        for (let c = 0; c < 4; c++)
          delta = Math.max(delta, Math.abs(pixels[i + c] - control[i + c]));
        stats.interiorChangedPixels += Number(delta > 0);
        if (delta > 0 && nearestSamplerTie(pixels, control, i, u, v)) {
          stats.nearestSamplerSeamChanges++;
          if (stats.nearestSamplerSeamExamples.length < 8)
            stats.nearestSamplerSeamExamples.push({
              x,
              y,
              u,
              v,
              rgba: Array.from(pixels.slice(i, i + 4)),
              controlRgba: Array.from(control.slice(i, i + 4)),
            });
        }
        stats.maxInteriorByteDelta = Math.max(
          stats.maxInteriorByteDelta,
          delta,
        );
      } else if (distance <= -2) {
        stats.outsidePixels++;
        stats.outsideNonzeroPixels += Number(
          Boolean(pixels[i] || pixels[i + 1] || pixels[i + 2] || alpha),
        );
      }
      stats.partialCoveragePixels += Number(alpha > 0 && alpha < 255);
      stats.whiteMaskLeakPixels += Number(
        Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) >
          Math.ceil((211 * alpha) / 255) + 1,
      );
    }
  stats.distinctInteriorColors = colors.size;
  return stats;
}
