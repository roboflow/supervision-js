import * as Pixi from "pixi.js";
import { createBenchBackend } from "../../benchmark/depth/gpu/src/pixi-backend.ts";
import { createPixiAnnotationAntialiasFilter } from "#renderers/pixi-annotation-antialias";
import { installPixiFilterBindings } from "#renderers/pixi-filter-bindings";
import { installPixiBatchTextureBindings } from "#renderers/pixi-batch-texture-bindings";
import { createScene, WIDTH, HEIGHT, regions } from "./scene.mjs";
import {
  alphaStatistics,
  comparePixels,
  digest,
  downsample,
  png,
} from "./pixels.mjs";
import { probeHeatmapFocus } from "./heatmap-probe.mjs";
import { probeFilterCleanup } from "./cleanup-probe.mjs";
import { probeWideAnnotationSurface } from "./wide-probe.mjs";
import { probeZoomedAnnotationBounds } from "./zoom-probe.mjs";
import { probeRegionMediaAntialias } from "./region-media-probe.mjs";
import { probeFilterUniformIsolation } from "./filter-uniforms-probe.mjs";
import { probeMaskCssBorders } from "./mask-border-probe.mjs";
import { probeSharpLabelAntialias } from "./label-probe.mjs";

const MODES = ["none", "fxaa", "fxaa2"];
const BATCH_DRAWS = 24;
const ROUNDS = 3;

function show(mode, overlay, composite) {
  const figure = document.createElement("figure");
  const title = document.createElement("figcaption");
  title.textContent = mode;
  figure.append(title);
  for (const [kind, data] of Object.entries({ composite, overlay })) {
    const image = document.createElement("img");
    image.src = data;
    image.alt = `${mode}, ${kind}, native DPR-1 output`;
    figure.append(image);
  }
  document.querySelector("#gallery").append(figure);
}

export async function run(requested, { timings = true } = {}) {
  const status = document.querySelector("#status");
  document.querySelector("#gallery").replaceChildren();
  for (const button of document.querySelectorAll("button"))
    button.disabled = true;
  const report = {
    schema: "annotation-aa-pixels.v1",
    at: new Date().toISOString(),
    status: "started",
    nativeDpr: window.devicePixelRatio,
    output: { width: WIDTH, height: HEIGHT, resolution: 1 },
    source: null,
    regions,
    definitions: {
      pixels:
        "Real Pixi WebGPU/WebGL target pixels, resolution 1. Transparent annotation-only output and composition over a fixed high-frequency image are captured separately. This is a fixed production-factory scene, not a complete media session.",
      reference:
        "The exact same semantic mask raster and vector scene rendered with AA off at resolution 4, then box-downsampled in premultiplied RGBA. It measures output coverage, not recovery of contour detail discarded in preparation. Label text retains its original raster resolution.",
      video:
        "The background image and sprite are outside the filtered annotation container. A reserved right strip contains no annotation, and must match its original pixels exactly for every option.",
      masks:
        "A nearest-sampled R8 categorical raster contains IDs 0, 1, 3. ID 2 has a green palette entry but no pixels. Its total 3-CSS-pixel centered outline stays fixed across capture densities. The exact raster bytes are checked before/after rendering.",
      timings:
        "Counterbalanced batches of 24 complete scene renders followed by GPU drain, after warming each shader and target. Wall time includes JS/Pixi submission and synchronization; it is not isolated GPU duration, CPU utilization, playback FPS or a scrub benchmark.",
    },
    modes: [],
    timing: [],
    warnings: [],
    warningStacks: [],
    errors: [],
  };
  let backend, scene, target, referenceTarget, releaseFilters, releaseBatch;
  const filters = new Map();
  const captures = new Map();
  const images = [];
  const priorWarn = console.warn;
  console.warn = (...args) => {
    report.warnings.push(args.map(String).join(" "));
    report.warningStacks.push(new Error("Pixi warning location").stack);
    priorWarn(...args);
  };
  try {
    backend = await createBenchBackend(requested);
    report.backend = backend.description;
    if (report.backend.rendererName !== requested)
      throw Error("requested renderer silently fell back");
    if (backend.app.renderer.resolution !== 1)
      throw Error("renderer output resolution changed");
    releaseBatch = installPixiBatchTextureBindings(Pixi, backend.app.renderer);
    releaseFilters = installPixiFilterBindings(Pixi, backend.app.renderer);
    backend.app.renderer.gpu?.device.addEventListener(
      "uncapturederror",
      (event) => {
        report.errors.push(String(event.error));
      },
    );
    scene = createScene();
    report.maskStroke = scene.maskStroke;
    const initialRasterHash = await digest(scene.raster);
    target = Pixi.RenderTexture.create({
      width: WIDTH,
      height: HEIGHT,
      resolution: 1,
      scaleMode: "nearest",
    });
    referenceTarget = Pixi.RenderTexture.create({
      width: WIDTH,
      height: HEIGHT,
      resolution: 4,
      scaleMode: "nearest",
    });
    for (const mode of MODES.slice(1)) {
      filters.set(
        mode,
        createPixiAnnotationAntialiasFilter({
          Filter: Pixi.Filter,
          defaultFilterVert: Pixi.defaultFilterVert,
          resolution: mode === "fxaa2" ? 2 : 1,
        }),
      );
    }
    const mode = (name) => {
      scene.setAnnotationFilter(name === "none" ? null : filters.get(name));
    };
    const draw = (destination = target) => {
      const captureResolution = scene.overlays.filters?.[0]?.resolution;
      scene.setStrokePixelRatio(
        typeof captureResolution === "number"
          ? captureResolution
          : destination.source.resolution,
      );
      backend.app.renderer.render({
        container: scene.stage,
        target: destination,
        clear: true,
      });
    };
    const capture = async (name, background, destination = target) => {
      mode(name);
      scene.background.visible = background;
      draw(destination);
      await backend.finish(destination);
      return backend.readPixels(destination);
    };
    for (const name of MODES) {
      mode(name);
      draw();
      await backend.finish(target);
    }
    report.source = await window
      .fetch("/__annotation-aa-source")
      .then((r) => r.json());
    mode("none");
    scene.setAnnotationsVisible(false);
    scene.background.visible = true;
    draw();
    await backend.finish(target);
    const originalBackground = await backend.readPixels(target);
    scene.setAnnotationsVisible(true);
    const reference = downsample(
      await capture("none", false, referenceTarget),
      WIDTH,
      HEIGHT,
      4,
    );
    images.push({
      name: "coverage-reference.overlay",
      png: png(reference, WIDTH, HEIGHT),
    });
    for (const name of MODES) {
      status.textContent = `Capturing ${requested}: ${name}`;
      const overlay = await capture(name, false);
      const composite = await capture(name, true);
      captures.set(name, { overlay, composite });
      const item = {
        name,
        filter:
          name === "none"
            ? null
            : {
                resolution: filters.get(name).resolution,
                antialias: filters.get(name).antialias,
              },
        untouchedMedia: comparePixels(
          composite,
          originalBackground,
          WIDTH,
          regions.untouchedMedia,
        ),
        regions: Object.fromEntries(
          Object.entries(regions)
            .filter(([key]) => key !== "untouchedMedia")
            .map(([key, roi]) => [
              key,
              {
                ...alphaStatistics(overlay, WIDTH, roi),
                reference: alphaStatistics(reference, WIDTH, roi),
                vsFinerCoverageReference: comparePixels(
                  overlay,
                  reference,
                  WIDTH,
                  roi,
                ),
                vsOff: comparePixels(
                  overlay,
                  captures.get("none").overlay,
                  WIDTH,
                  roi,
                ),
              },
            ]),
        ),
      };
      report.modes.push(item);
      if (name !== "none" && item.regions.categoricalMasks.vsOff.exact)
        report.errors.push(`${name}: smoothing did not change mask edges`);
      if (!item.untouchedMedia.exact)
        report.errors.push(`${name}: unannotated background pixels changed`);
      const green = Array.from(
        { length: regions.categoricalMasks.height },
        (_, dy) => {
          let count = 0;
          for (let dx = 0; dx < regions.categoricalMasks.width; dx++) {
            const i =
              ((regions.categoricalMasks.y + dy) * WIDTH +
                regions.categoricalMasks.x +
                dx) *
              4;
            count += Number(overlay[i + 1] > 2);
          }
          return count;
        },
      ).reduce((a, b) => a + b, 0);
      item.nonexistentGreenMaskPixels = green;
      if (green)
        report.errors.push(
          `${name}: nonexistent green detection appeared in mask output`,
        );
      const overlayPng = png(overlay, WIDTH, HEIGHT);
      const compositePng = png(composite, WIDTH, HEIGHT);
      images.push(
        { name: `${name}.overlay`, png: overlayPng },
        { name: `${name}.composite`, png: compositePng },
      );
      show(name, overlayPng, compositePng);
    }
    report.toggleBackOff = comparePixels(
      await capture("none", false),
      captures.get("none").overlay,
      WIDTH,
    );
    if (!report.toggleBackOff.exact)
      report.errors.push(
        "switching all modes back off changed original pixels",
      );
    report.semanticRaster = {
      before: initialRasterHash,
      after: await digest(scene.raster),
      ids: [...new Set(scene.raster)].sort(),
    };
    if (report.semanticRaster.before !== report.semanticRaster.after)
      report.errors.push("categorical raster mutated");

    if (timings) {
      await Promise.all(
        [...document.querySelectorAll("#gallery img")].map((image) =>
          image.decode(),
        ),
      );
      scene.background.visible = true;
      for (const name of MODES) {
        mode(name);
        for (let i = 0; i < 8; i++) draw();
        await backend.finish(target);
      }
      for (const candidate of MODES.slice(1)) {
        for (let round = 0; round < ROUNDS; round++) {
          for (const name of round % 2
            ? [candidate, "none"]
            : ["none", candidate]) {
            mode(name);
            await backend.finish(target);
            const start = window.performance.now();
            for (let i = 0; i < BATCH_DRAWS; i++) draw();
            await backend.finish(target);
            report.timing.push({
              candidate,
              round: round + 1,
              mode: name,
              batchDraws: BATCH_DRAWS,
              renderAndGpuDrainMs: window.performance.now() - start,
            });
          }
        }
      }
    }
    const gl = backend.app.renderer.gl;
    const heatmap = await probeHeatmapFocus(backend);
    images.push(...heatmap.images);
    report.heatmapFocus = { ...heatmap, images: undefined };
    report.errors.push(...heatmap.errors);
    if (gl) {
      for (let i = 0; i < 16; i++) {
        const code = gl.getError();
        if (!code) break;
        report.errors.push(`WebGL error 0x${code.toString(16)}`);
      }
    }
    report.filterCleanup = await probeFilterCleanup(requested);
    report.errors.push(...report.filterCleanup.errors);
    if (report.filterCleanup.warnings.length)
      report.errors.push("filter lifetime probe emitted Pixi warnings");
    const wide = await probeWideAnnotationSurface(requested);
    images.push(...wide.images);
    report.wideSurface = { ...wide, images: undefined };
    report.errors.push(...wide.errors);
    report.zoomedBounds = await probeZoomedAnnotationBounds(requested);
    report.errors.push(...report.zoomedBounds.errors);
    const copiedMedia = await probeRegionMediaAntialias(requested);
    images.push(...copiedMedia.images);
    report.regionMedia = { ...copiedMedia, images: undefined };
    report.errors.push(...copiedMedia.errors);
    report.filterUniforms = await probeFilterUniformIsolation(requested);
    report.errors.push(...report.filterUniforms.errors);
    report.warnings.push(...report.filterUniforms.warnings);
    const borders = await probeMaskCssBorders(requested);
    images.push(...borders.images);
    report.maskCssBorders = { ...borders, images: undefined };
    report.errors.push(...borders.errors);
    report.warnings.push(...borders.warnings);
    const labels = await probeSharpLabelAntialias(requested);
    images.push(...labels.images);
    report.sharpLabels = { ...labels, images: undefined };
    report.errors.push(...labels.errors);
    if (labels.warnings.length)
      report.errors.push("label composition probe emitted Pixi warnings");
    const finalSource = await window
      .fetch("/__annotation-aa-source")
      .then((r) => r.json());
    report.sourceUnchanged =
      finalSource.fingerprint === report.source.fingerprint;
    if (!report.sourceUnchanged)
      report.errors.push(
        "source or dependency bytes changed during comparison",
      );
  } catch (error) {
    report.errors.push(String(error));
  } finally {
    scene?.setAnnotationFilter(null);
    releaseBatch?.();
    releaseFilters?.();
    for (const filter of filters.values()) filter.destroy();
    scene?.destroy();
    target?.destroy(true);
    referenceTarget?.destroy(true);
    backend?.destroy();
    console.warn = priorWarn;
    for (const button of document.querySelectorAll("button"))
      button.disabled = false;
  }
  report.status = report.errors.length ? "failed" : "complete";
  window.annotationAaReport = report;
  const response = await window.fetch("/__annotation-aa-report", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ report, images }),
  });
  if (!response.ok) throw Error(await response.text());
  report.artifacts = await response.json();
  status.textContent = JSON.stringify(report, null, 2);
  return report;
}

window.runAnnotationAaPixels = run;
window.runAnnotationAaCleanup = probeFilterCleanup;
window.runAnnotationAaZoomBounds = probeZoomedAnnotationBounds;
window.runAnnotationAaRegionMedia = probeRegionMediaAntialias;
window.runAnnotationAaFilterUniforms = probeFilterUniformIsolation;
window.runAnnotationAaWide = probeWideAnnotationSurface;
window.runAnnotationAaMaskCssBorders = probeMaskCssBorders;
window.runAnnotationAaSharpLabels = probeSharpLabelAntialias;
for (const button of document.querySelectorAll("button"))
  button.addEventListener("click", () => run(button.dataset.backend));
const query = new window.URLSearchParams(window.location.search);
if (query.get("run") === "1")
  run(query.get("backend") ?? "webgpu", {
    timings: query.get("timings") !== "0",
  });
