import * as Pixi from "pixi.js";
import {
  createIdMaskFrame,
  encodeBinaryMask,
  pickDetectionByMaskId,
  StrokeAlignment,
} from "supervision-js-core";
import { createBenchBackend } from "../../benchmark/depth/gpu/src/pixi-backend.ts";
import { createPixiAnnotationAntialiasFilter } from "#renderers/pixi-annotation-antialias";
import { createPixiIdMaskShaderRenderer } from "#renderers/pixi-id-mask-shader";
import { installPixiFilterBindings } from "#renderers/pixi-filter-bindings";
import {
  PreparedMaskFrameKind,
  readIdMaskRasterValue,
} from "#render-preparation/mask-frame-artifact";
import { comparePixels, digest, png } from "./pixels.mjs";

const WIDTH = 352,
  HEIGHT = 272,
  MEDIA_WIDTH = 256,
  MEDIA_HEIGHT = 192;
const CAMERAS = [
  { name: "fit", scale: 0.75, x: 16.25, y: 15.375 },
  { name: "zoom", scale: 1.25, x: 16.25, y: 15.375 },
];
const ALIGNMENTS = [
  { name: "outside", value: StrokeAlignment.Outside, fraction: 0 },
  { name: "center", value: StrokeAlignment.Center, fraction: 0.5 },
  { name: "inside", value: StrokeAlignment.Inside, fraction: 1 },
];
const TOLERANCE = { byteDelta: 3, widthCss: 0.08, centroidCss: 0.06 };

/** Measures flat mask borders against geometric intervals in CSS coordinates. */
export async function probeMaskCssBorders(requested) {
  const cases = [],
    images = [],
    errors = [],
    warnings = [],
    restores = [];
  let backend, stage, display, owner, texture, target, releaseBindings;
  let phase = "opening";
  let scoped = false;
  const filters = [];
  const priorWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map(String).join(" "));
    priorWarn(...args);
  };
  try {
    backend = await createBenchBackend(requested);
    if (backend.description.rendererName !== requested)
      throw Error("mask border probe backend silently fell back");
    const device = backend.app.renderer.gpu?.device;
    device?.addEventListener("uncapturederror", (event) =>
      errors.push(String(event.error)),
    );
    if (device) {
      device.pushErrorScope("validation");
      scoped = true;
    }
    releaseBindings = installPixiFilterBindings(Pixi, backend.app.renderer);
    const fixture = createFixture();
    const beforeHash = await digest(fixture.frame.raster);
    texture = new Pixi.Texture({
      source: new Pixi.BufferImageSource({
        resource: fixture.frame.raster,
        width: fixture.frame.width,
        height: fixture.frame.height,
        format: "r8unorm",
        alphaMode: "no-premultiply-alpha",
        scaleMode: "nearest",
        autoGenerateMipmaps: false,
      }),
    });
    owner = createPixiIdMaskShaderRenderer({
      ...Pixi,
      mediaWidth: MEDIA_WIDTH,
      mediaHeight: MEDIA_HEIGHT,
    });
    stage = new Pixi.Container();
    display = new Pixi.Container();
    display.addChild(owner.mesh);
    stage.addChild(display);
    const capture = async (density, filter) => {
      display.filters = filter ? [filter] : null;
      owner.render(fixture.frame, texture, density);
      backend.app.renderer.render({ container: stage, target, clear: true });
      await backend.finish(target);
      return backend.readPixels(target);
    };
    for (const outputResolution of [1, 2]) {
      backend.app.renderer.resize(WIDTH, HEIGHT, outputResolution);
      target = Pixi.RenderTexture.create({
        width: WIDTH,
        height: HEIGHT,
        resolution: outputResolution,
        scaleMode: "nearest",
      });
      const filter = createPixiAnnotationAntialiasFilter({
        Filter: Pixi.Filter,
        defaultFilterVert: Pixi.defaultFilterVert,
        resolution: outputResolution * 2,
      });
      filters.push(filter);
      for (const camera of CAMERAS) {
        display.scale.set(camera.scale);
        display.position.set(camera.x, camera.y);
        let off;
        for (const mode of ["off", "fxaa2", "off-restored"]) {
          phase = `${camera.name}/output${outputResolution}/${mode}`;
          const density = outputResolution * (mode === "fxaa2" ? 2 : 1);
          const pixels = await capture(
            density,
            mode === "fxaa2" ? filter : null,
          );
          if (mode === "off") off = pixels;
          if (mode === "off-restored") {
            const parity = comparePixels(pixels, off, target.source.pixelWidth);
            restores.push({ phase, parity });
            if (!parity.exact)
              errors.push(`${phase}: off pixels did not restore`);
            continue;
          }
          images.push({
            name: `mask-css.${camera.name}.output${outputResolution}.${mode}`,
            png: png(
              pixels,
              target.source.pixelWidth,
              target.source.pixelHeight,
            ),
          });
          for (const item of fixture.items) {
            const stats = inspectBorder(pixels, item, camera, outputResolution);
            const picks = inspectSemanticPicks(fixture, item);
            const row = {
              phase,
              widthCss: item.width,
              alignment: item.alignment.name,
              defaultAlignment: item.defaultAlignment,
              outputResolution,
              captureResolution: density,
              maskSize: [fixture.frame.width, fixture.frame.height],
              filter:
                mode === "fxaa2"
                  ? {
                      resolution: filter.resolution,
                      antialias: filter.antialias,
                    }
                  : null,
              ...stats,
              semanticPicks: picks,
            };
            cases.push(row);
            for (const edge of stats.edges) {
              if (
                edge.maxByteDelta > TOLERANCE.byteDelta ||
                edge.partialPixels === 0 ||
                Math.abs(edge.measuredWidthCss - item.width) >
                  TOLERANCE.widthCss ||
                Math.abs(edge.centroidErrorCss) > TOLERANCE.centroidCss
              )
                errors.push(
                  `${phase}/${item.name}/${edge.name}: CSS width or alignment differed from interval coverage`,
                );
            }
            if (
              stats.fill.some(
                (sample) => sample.rgba.join() !== "0,255,0,255",
              ) ||
              stats.background.some((sample) => sample.rgba.some(Boolean))
            )
              errors.push(
                `${phase}/${item.name}: fill/background probes failed`,
              );
            if (
              stats.insideMix.some(
                (sample) =>
                  sample.rgba[3] !== 255 ||
                  Math.abs(sample.rgba[1] + sample.rgba[0] - 255) > 1,
              )
            )
              errors.push(
                `${phase}/${item.name}: inner stroke erased fill coverage`,
              );
            if (!picks.exact)
              errors.push(`${phase}/${item.name}: categorical picking changed`);
          }
        }
      }
      target.destroy(true);
      target = null;
    }
    const afterHash = await digest(fixture.frame.raster);
    const semanticRaster = {
      before: beforeHash,
      after: afterHash,
      ids: [...new Set(fixture.frame.raster)].sort((a, b) => a - b),
    };
    if (beforeHash !== afterHash)
      errors.push("mask border probe changed semantic IDs");
    if (device) {
      const error = await device.popErrorScope();
      scoped = false;
      if (error) errors.push(String(error));
    }
    const gl = backend.app.renderer.gl;
    if (gl)
      for (let i = 0; i < 16; i++) {
        const code = gl.getError();
        if (!code) break;
        errors.push(`WebGL error 0x${code.toString(16)}`);
      }
    return {
      backend: backend.description,
      nativeDpr: globalThis.devicePixelRatio,
      output: { width: WIDTH, height: HEIGHT, resolutions: [1, 2] },
      topology: "Neutral stage root; transformed, filtered annotation child",
      cameras: CAMERAS,
      tolerance: TOLERANCE,
      semanticRaster,
      cases,
      restores,
      images,
      errors,
      warnings,
      definition:
        "Real production ID shader and SSAA filter, with a 12-rectangle categorical raster. Widths 1–4 are total CSS pixels; rows are Outside, Center and Inside. Outside width1 omits alignment to exercise the default. Fit and zoom cameras retain the same CSS stroke widths at output/capture densities 1/1, 1/2, 2/2 and 2/4. Flat left/top border cross-sections are compared with independently intersected geometric stroke intervals and physical pixel apertures, including integrated red coverage and centroid. Stroke is opaque red, fill opaque green and background transparent, so green/alpha probes distinguish an inner stroke from a missing mask. ID picking reads the original nearest categorical plane, never the resolved RGBA. Full targets are read once per mode; the report retains sparse cross-sections and interiors. This is functional pixel evidence with no performance or memory claim.",
    };
  } catch (error) {
    errors.push(`${phase}: ${String(error)}`);
    return {
      backend: backend?.description,
      cases,
      restores,
      images,
      errors,
      warnings,
    };
  } finally {
    try {
      if (scoped) {
        const error = await backend.app.renderer.gpu.device.popErrorScope();
        if (error) errors.push(String(error));
      }
      if (display) display.filters = null;
      releaseBindings?.();
      for (const filter of filters) filter.destroy();
      display?.removeChildren();
      owner?.destroy();
      stage?.destroy({ children: true });
      texture?.destroy(true);
      target?.destroy(true);
      backend?.destroy();
    } catch (error) {
      errors.push(`cleanup: ${String(error)}`);
    } finally {
      console.warn = priorWarn;
      if (warnings.length) errors.push("mask border probe emitted warnings");
    }
  }
}

function createFixture() {
  const items = ALIGNMENTS.flatMap((alignment, row) =>
    [1, 2, 3, 4].map((width, col) => ({
      name: `${alignment.name}${width}`,
      alignment,
      width,
      rect: { x: 24 + col * 56, y: 24 + row * 56, width: 32, height: 28 },
      defaultAlignment: row === 0 && col === 0,
    })),
  );
  const instructions = items.map((item, detectionIndex) => {
    const binary = new Uint8Array(MEDIA_WIDTH * MEDIA_HEIGHT);
    for (let y = item.rect.y; y < item.rect.y + item.rect.height; y++)
      binary.fill(
        1,
        y * MEDIA_WIDTH + item.rect.x,
        y * MEDIA_WIDTH + item.rect.x + item.rect.width,
      );
    const mask = encodeBinaryMask(binary, MEDIA_WIDTH, MEDIA_HEIGHT);
    item.detectionIndex = detectionIndex;
    return {
      detectionIndex,
      mask,
      color: 0x00ff00,
      alpha: 1,
      stroke: {
        color: 0xff0000,
        alpha: 1,
        width: item.width,
        ...(item.defaultAlignment ? {} : { alignment: item.alignment.value }),
      },
    };
  });
  const cooked = createIdMaskFrame(instructions);
  if (!cooked || !cooked.strokeAlignments)
    throw Error("CSS stroke frame did not carry alignment entries");
  for (const item of items)
    if (
      cooked.strokeWidths[item.detectionIndex + 1] !== item.width ||
      cooked.strokeAlignments[item.detectionIndex + 1] !==
        item.alignment.fraction
    )
      throw Error(`${item.name}: fixture changed CSS width/alignment`);
  return {
    items,
    detectionFrame: {
      mediaTime: 0,
      frameIndex: 0,
      detections: items.map((item) => ({
        id: item.name,
        mask: instructions[item.detectionIndex].mask,
      })),
    },
    frame: {
      ...cooked,
      kind: PreparedMaskFrameKind.IdMask,
      key: "mask-css-border",
      raster: cooked.data,
      close() {},
    },
  };
}

function inspectSemanticPicks(fixture, item) {
  const inside = {
    x: item.rect.x + 0.25,
    y: item.rect.y + item.rect.height / 2,
  };
  const outside = { ...inside, x: item.rect.x - 0.25 };
  const sample = (point) => {
    const id = readIdMaskRasterValue(
      fixture.frame,
      Math.floor(point.x),
      Math.floor(point.y),
    );
    const pick = pickDetectionByMaskId(fixture.detectionFrame, id, point);
    return { point, id, detectionIndex: pick?.detectionIndex ?? null };
  };
  const inner = sample(inside),
    outer = sample(outside);
  return {
    inside: inner,
    outside: outer,
    exact:
      inner.detectionIndex === item.detectionIndex &&
      inner.id === item.detectionIndex + 1 &&
      outer.id === 0 &&
      outer.detectionIndex === null,
  };
}

function inspectBorder(pixels, item, camera, outputResolution) {
  const width = WIDTH * outputResolution;
  const left = camera.x + item.rect.x * camera.scale;
  const top = camera.y + item.rect.y * camera.scale;
  const center = {
    x: left + (item.rect.width * camera.scale) / 2,
    y: top + (item.rect.height * camera.scale) / 2,
  };
  const read = (x, y) => {
    const px = Math.floor(x * outputResolution),
      py = Math.floor(y * outputResolution);
    return {
      x: px,
      y: py,
      rgba: Array.from(
        pixels.subarray((py * width + px) * 4, (py * width + px) * 4 + 4),
      ),
    };
  };
  const edges = [
    { name: "left", boundary: left, fixed: center.y, horizontal: true },
    { name: "top", boundary: top, fixed: center.x, horizontal: false },
  ].map((edge) => {
    const interval = [
      edge.boundary - item.width * (1 - item.alignment.fraction),
      edge.boundary + item.width * item.alignment.fraction,
    ];
    const samples = [];
    let mass = 0,
      moment = 0,
      maxByteDelta = 0;
    for (
      let p = Math.floor((interval[0] - 2) * outputResolution);
      p <= Math.ceil((interval[1] + 2) * outputResolution);
      p++
    ) {
      const lo = p / outputResolution,
        hi = (p + 1) / outputResolution;
      const overlap = Math.max(
        0,
        Math.min(hi, interval[1]) - Math.max(lo, interval[0]),
      );
      const expectedRed = Math.round(overlap * outputResolution * 255);
      const pixel = edge.horizontal
        ? read((p + 0.5) / outputResolution, edge.fixed)
        : read(edge.fixed, (p + 0.5) / outputResolution);
      const coverage = pixel.rgba[0] / 255;
      const delta = Math.abs(pixel.rgba[0] - expectedRed);
      mass += coverage / outputResolution;
      moment += (coverage * (p + 0.5)) / outputResolution ** 2;
      maxByteDelta = Math.max(maxByteDelta, delta);
      samples.push({ ...pixel, expectedRed, delta });
    }
    const expectedCentroidCss = (interval[0] + interval[1]) / 2;
    const measuredCentroidCss = mass ? moment / mass : null;
    return {
      name: edge.name,
      intervalCss: interval,
      measuredWidthCss: mass,
      expectedCentroidCss,
      measuredCentroidCss,
      centroidErrorCss:
        measuredCentroidCss === null
          ? null
          : measuredCentroidCss - expectedCentroidCss,
      maxByteDelta,
      partialPixels: samples.filter(
        (sample) => sample.rgba[0] > 0 && sample.rgba[0] < 255,
      ).length,
      samples,
    };
  });
  const fill = [read(center.x, center.y)];
  const background = [
    read(left - item.width - 2, center.y),
    read(center.x, top - item.width - 2),
  ];
  const insideMix = [];
  for (const edge of edges)
    for (const sample of edge.samples) {
      const axisCenter =
        ((edge.name === "left" ? sample.x : sample.y) + 0.5) / outputResolution;
      if (
        axisCenter >=
          (edge.name === "left" ? left : top) + 1 / outputResolution &&
        sample.rgba[0] > 0 &&
        sample.rgba[0] < 255
      )
        insideMix.push(sample);
    }
  return { edges, fill, background, insideMix };
}
