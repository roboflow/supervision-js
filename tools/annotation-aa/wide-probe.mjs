import * as Pixi from "pixi.js";
import { createBenchBackend } from "../../benchmark/depth/gpu/src/pixi-backend.ts";
import {
  createPixiAnnotationAntialiasFilter,
  resolvePixiAnnotationAntialiasResolution,
} from "#renderers/pixi-annotation-antialias";
import { installPixiFilterBindings } from "#renderers/pixi-filter-bindings";
import { comparePixels, png } from "./pixels.mjs";

export async function probeWideAnnotationSurface(requested) {
  const width = 2560,
    height = 64,
    outputResolution = 2;
  const pixelWidth = width * outputResolution,
    pixelHeight = height * outputResolution;
  const errors = [],
    warnings = [],
    images = [],
    cases = [],
    pooledTargets = [];
  const previousWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map(String).join(" "));
    previousWarn(...args);
  };
  const originalGetOptimalTexture = Pixi.TexturePool.getOptimalTexture;
  let backend,
    stage,
    target,
    filter,
    releaseBindings,
    phase = "opening",
    scoped = false;
  let description, captureResolution;
  try {
    backend = await createBenchBackend(requested);
    description = backend.description;
    if (description.rendererName !== requested)
      throw Error("wide surface renderer silently fell back");
    const limit = description.maxTextureSize;
    if (pixelWidth > limit)
      throw Error("device cannot fit the control's DPR2 output canvas");
    const device = backend.app.renderer.gpu?.device;
    device?.addEventListener("uncapturederror", (event) =>
      errors.push(String(event.error)),
    );
    if (device) {
      device.pushErrorScope("validation");
      scoped = true;
    }
    releaseBindings = installPixiFilterBindings(Pixi, backend.app.renderer);
    backend.app.renderer.resolution = outputResolution;
    backend.app.renderer.resize(width, height);
    captureResolution = resolvePixiAnnotationAntialiasResolution(
      outputResolution,
      { width, height },
      limit,
      2,
    );
    filter = createPixiAnnotationAntialiasFilter({
      Filter: Pixi.Filter,
      defaultFilterVert: Pixi.defaultFilterVert,
      resolution: captureResolution,
    });
    if (filter.resolution !== captureResolution || filter.antialias !== "off")
      throw Error(
        "production filter ignored capture resolution or enabled native MSAA",
      );
    stage = new Pixi.Container();
    const background = new Pixi.Graphics();
    for (let x = 0; x < width; x += 4)
      background
        .rect(x, 0, 4, height)
        .fill({ color: (x / 4) % 2 ? 0x5594da : 0x23366d });
    const annotations = new Pixi.Container();
    annotations.filterArea = new Pixi.Rectangle(0, 0, width, height);
    annotations.addChild(
      new Pixi.Graphics()
        .moveTo(0, 8.4)
        .lineTo(width, 44.6)
        .stroke({ color: 0xffb30f, width: 1.25 }),
    );
    stage.addChild(background, annotations);
    target = Pixi.RenderTexture.create({
      width,
      height,
      resolution: outputResolution,
      scaleMode: "nearest",
    });
    Pixi.TexturePool.getOptimalTexture = function (...args) {
      const result = originalGetOptimalTexture.apply(this, args);
      const row = {
        phase,
        requestedCssWidth: args[0],
        requestedCssHeight: args[1],
        resolution: args[2] ?? 1,
        pixelWidth: result.source.pixelWidth,
        pixelHeight: result.source.pixelHeight,
      };
      pooledTargets.push(row);
      if (row.pixelWidth > limit || row.pixelHeight > limit)
        errors.push(
          `pooled target exceeds device limit ${limit}: ${JSON.stringify(row)}`,
        );
      return result;
    };
    const capture = async () => {
      backend.app.renderer.render({ container: stage, target, clear: true });
      await backend.finish(target);
      const bytes = await backend.readPixels(target);
      const gl = backend.app.renderer.gl;
      if (gl)
        for (let i = 0; i < 16; i++) {
          const code = gl.getError();
          if (!code) break;
          errors.push(`WebGL error 0x${code.toString(16)}`);
        }
      return bytes;
    };
    annotations.visible = false;
    phase = "media-only";
    const media = await capture();
    annotations.visible = true;
    const pixels = [];
    const untouchedMedia = {
      x: 0,
      y: 56 * outputResolution,
      width: pixelWidth,
      height: 8 * outputResolution,
    };
    for (const mode of ["off", "on", "off-restored"]) {
      phase = mode;
      annotations.filters = mode === "on" ? [filter] : null;
      const bytes = await capture();
      pixels.push(bytes);
      const parity = comparePixels(bytes, media, pixelWidth, untouchedMedia);
      if (!parity.exact) errors.push(`${mode}: untouched media pixels changed`);
      cases.push({ mode, untouchedMedia: parity });
      images.push({
        name: `wide.${mode}`,
        png: png(bytes, pixelWidth, pixelHeight),
      });
    }
    const restored = comparePixels(pixels[0], pixels[2], pixelWidth);
    const aaChange = comparePixels(pixels[0], pixels[1], pixelWidth);
    if (!restored.exact)
      errors.push("wide AA off/on/off did not restore exact pixels");
    if (aaChange.exact)
      errors.push("wide AA capture did not alter any annotation edge pixels");
    if (
      !pooledTargets.some(
        (row) => row.phase === "on" && row.requestedCssWidth >= width,
      )
    )
      errors.push(
        "probe did not exercise a full-width pooled annotation capture",
      );
    cases.push({ mode: "toggle-parity", restored, aaChange });
    if (device) {
      const error = await device.popErrorScope();
      scoped = false;
      if (error) errors.push(String(error));
    }
  } catch (error) {
    errors.push(String(error));
  } finally {
    Pixi.TexturePool.getOptimalTexture = originalGetOptimalTexture;
    if (scoped) {
      const error = await backend.app.renderer.gpu.device.popErrorScope();
      if (error) errors.push(String(error));
    }
    releaseBindings?.();
    if (stage) for (const child of stage.children) child.filters = null;
    filter?.destroy();
    stage?.destroy({ children: true });
    target?.destroy(true);
    backend?.destroy();
    console.warn = previousWarn;
  }
  if (warnings.length)
    errors.push("wide surface lifetime probe emitted warnings");
  return {
    backend: description,
    nativeDpr: globalThis.devicePixelRatio,
    output: {
      width,
      height,
      resolution: outputResolution,
      pixelWidth,
      pixelHeight,
    },
    captureResolution,
    pooledTargets,
    cases,
    errors,
    warnings,
    images,
    definition:
      "Actual wide Pixi surface 2560×64 at output DPR2. Full-width annotation capture uses the production resolver/factory and real queried GPU/GL maximum texture size; every actual pooled capture dimension must fit. Original media strip and restored AA-off pixels stay exact. Thin height avoids an unnecessarily tall allocation. Functional pixel/lifetime evidence only, without CPU/GPU timing claims.",
  };
}
