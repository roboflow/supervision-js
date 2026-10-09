import * as Pixi from "pixi.js";
import {
  BaseFocusStyle,
  FocusTargetMode,
  annotationRenderers,
} from "supervision-js-core";
import { createBenchBackend } from "../../benchmark/depth/gpu/src/pixi-backend.ts";
import { createPixiFocusLayer } from "#renderers/pixi-focus-layer";
import { createPixiRegionCoverageMask } from "#renderers/pixi-region-coverage-mask";
import {
  createPixiAnnotationAntialiasFilter,
  resolvePixiAnnotationAntialiasResolution,
} from "#renderers/pixi-annotation-antialias";
import { installPixiFilterBindings } from "#renderers/pixi-filter-bindings";
import { installPixiBatchTextureBindings } from "#renderers/pixi-batch-texture-bindings";

export async function probeZoomedAnnotationBounds(requested) {
  const width = 2560,
    height = 64,
    outputResolution = 1;
  const cases = [],
    pooledTargets = [],
    capFailures = [],
    errors = [];
  let backend,
    target,
    focus,
    coverage,
    stage,
    filter,
    texture,
    releaseBindings,
    releaseBatchBindings;
  let phase = "opening";
  const originalGetOptimalTexture = Pixi.TexturePool.getOptimalTexture;
  try {
    backend = await createBenchBackend(requested);
    if (backend.description.rendererName !== requested)
      throw Error("zoom probe backend silently fell back");
    const limit = backend.description.maxTextureSize;
    const pooledLimit = 2 ** Math.floor(Math.log2(limit));
    const captureResolution = resolvePixiAnnotationAntialiasResolution(
      outputResolution,
      { width, height },
      limit,
      2,
    );
    const focusZoom = Math.ceil(pooledLimit / (width * captureResolution)) + 1;
    const regionZoom = Math.ceil(pooledLimit / (width * outputResolution)) + 1;
    releaseBindings = installPixiFilterBindings(Pixi, backend.app.renderer);
    releaseBatchBindings = installPixiBatchTextureBindings(
      Pixi,
      backend.app.renderer,
    );
    backend.app.renderer.resize(width, height, outputResolution);
    target = Pixi.RenderTexture.create({
      width,
      height,
      resolution: outputResolution,
    });
    texture = new Pixi.Texture({
      source: new Pixi.BufferImageSource({
        resource: new Uint8Array([255, 255, 255, 255]),
        width: 1,
        height: 1,
        format: "rgba8unorm",
        scaleMode: "nearest",
        alphaMode: "no-premultiply-alpha",
        autoGenerateMipmaps: false,
      }),
    });
    const bounds = {
      x: width / 2,
      y: height / 2,
      width: width / 8,
      height: height / 2,
    };
    const frame = {
      mediaTime: 0,
      detections: [{ heatmap: { bounds, width: 1, height: 1, values: [1] } }],
    };
    let viewportBounds = { x: 0, y: 0, width, height };
    focus = createPixiFocusLayer({
      ...Pixi,
      focusStyle: new BaseFocusStyle({
        targetMode: FocusTargetMode.Ambient,
        fill: { alpha: 0.5, color: 0 },
      }),
      getHeatmapRenderers: () => [annotationRenderers.heatmap()],
      getViewportBounds: () => viewportBounds,
    });
    const focusDisplay = focus.createDisplay({ width, height });
    focus.drawFrame({
      frame,
      mediaTime: 0,
      hoveredPick: null,
      selectedPick: null,
      heatmapArtifacts: [{ detectionIndex: 0, bounds, texture }],
    });
    focus.tick(0);
    focus.tick(120);
    filter = createPixiAnnotationAntialiasFilter({
      Filter: Pixi.Filter,
      defaultFilterVert: Pixi.defaultFilterVert,
      resolution: captureResolution,
    });
    const focusGroup = new Pixi.Container();
    focusGroup.filters = [filter];
    focusGroup.addChild(focusDisplay);
    coverage = createPixiRegionCoverageMask({
      ...Pixi,
      getAnnotationAntialiasing: () => true,
      getAntialiasResolution: () => captureResolution,
      getViewportBounds: () => viewportBounds,
    });
    coverage.render({
      artifact: { texture },
      coverage: { x: 0, y: 0, width, height },
      crop: { x: 0, y: 0, width, height },
      x: width / 2,
      y: height / 2,
      width,
      height,
      rotation: 0,
      flipHorizontal: false,
      flipVertical: false,
    });
    const regionDisplay = new Pixi.Sprite(texture);
    regionDisplay.width = width;
    regionDisplay.height = height;
    regionDisplay.setMask({ mask: coverage.effect, channel: "alpha" });
    const regionGroup = new Pixi.Container();
    regionGroup.addChild(regionDisplay, coverage.container);
    stage = new Pixi.Container();
    stage.addChild(focusGroup, regionGroup);
    Pixi.TexturePool.getOptimalTexture = function (...args) {
      const resolution = args[2] ?? 1;
      const requestedPixelWidth =
        2 **
        Math.ceil(
          Math.log2(Math.max(1, Math.ceil(args[0] * resolution - 1e-6))),
        );
      const requestedPixelHeight =
        2 **
        Math.ceil(
          Math.log2(Math.max(1, Math.ceil(args[1] * resolution - 1e-6))),
        );
      const oversized =
        requestedPixelWidth > limit || requestedPixelHeight > limit;
      const row = {
        phase,
        cssWidth: args[0],
        cssHeight: args[1],
        resolution,
        requestedPixelWidth,
        requestedPixelHeight,
        oversized,
      };
      pooledTargets.push(row);
      if (oversized) {
        const failure = `${phase}: production requested ${requestedPixelWidth}×${requestedPixelHeight}, device limit ${limit}`;
        capFailures.push(failure);
        errors.push(failure);
        // Record the real request, then keep this diagnostic from allocating an invalid target.
        args[2] = Math.min(
          resolution,
          pooledLimit / Math.max(1, Math.ceil(args[0]), Math.ceil(args[1])),
        );
      }
      const result = originalGetOptimalTexture.apply(this, args);
      row.allocatedPixelWidth = result.source.pixelWidth;
      row.allocatedPixelHeight = result.source.pixelHeight;
      return result;
    };
    for (const [kind, group, zoom, panX = 0, panY = 0] of [
      ["focus", focusGroup, 1],
      ["focus", focusGroup, focusZoom],
      ["focus", focusGroup, focusZoom * 2 * 0.50737, 17.371, 0.133],
      ["focus", focusGroup, focusZoom * 2 * 0.50737, 17.529, 0.389],
      ["region", regionGroup, 1],
      ["region", regionGroup, regionZoom],
      ["region", regionGroup, regionZoom * 2 * 0.50737, 17.371, 0.133],
      ["region", regionGroup, regionZoom * 2 * 0.50737, 17.529, 0.389],
    ]) {
      phase = `${kind}/zoom${zoom}/pan${panX},${panY}`;
      focusGroup.visible = kind === "focus";
      regionGroup.visible = kind === "region";
      group.scale.set(zoom);
      group.position.set(
        (-(zoom - 1) * width) / 2 + panX,
        (-(zoom - 1) * height) / 2 + panY,
      );
      viewportBounds = {
        x: -group.x / zoom,
        y: -group.y / zoom,
        width: width / zoom,
        height: height / zoom,
      };
      focus.syncViewportBounds();
      coverage.syncViewportBounds();
      const before = pooledTargets.length;
      backend.app.renderer.render({ container: stage, target, clear: true });
      await backend.finish(target);
      const pixels = await backend.readPixels(target);
      const centerAlpha = pixels[((height / 2) * width + width / 2) * 4 + 3];
      const cornerAlpha = pixels[(width + 1) * 4 + 3];
      if (kind === "region" && centerAlpha !== 255)
        errors.push(
          `${phase}: opaque Region center was ${centerAlpha}, expected 255`,
        );
      if (kind === "focus" && (centerAlpha > 2 || cornerAlpha < 120))
        errors.push(
          `${phase}: expected a clear heatmap hole inside a dim overlay; center ${centerAlpha}, corner ${cornerAlpha}`,
        );
      cases.push({
        kind,
        zoom,
        panX,
        panY,
        captureResolution,
        outputResolution,
        oversizedRequests: pooledTargets
          .slice(before)
          .filter((row) => row.oversized).length,
        outputPixelWidth: target.source.pixelWidth,
        outputPixelHeight: target.source.pixelHeight,
        centerAlpha,
        cornerAlpha,
      });
    }
  } catch (error) {
    errors.push(String(error));
  } finally {
    Pixi.TexturePool.getOptimalTexture = originalGetOptimalTexture;
    releaseBatchBindings?.();
    releaseBindings?.();
    focus?.destroy();
    coverage?.destroy();
    filter?.destroy();
    stage?.destroy({ children: true });
    texture?.destroy(true);
    target?.destroy(true);
    backend?.destroy();
  }
  return {
    backend: backend?.description,
    cases,
    pooledTargets,
    capFailures,
    bounded: capFailures.length === 0 && errors.length === 0,
    errors,
    definition:
      "Real production Focus AlphaMask and Region exact-coverage factories on a 2560×64 output at DPR1, FXAA2. Zoom is chosen from the queried device limit. Every real pooled-texture request is recorded. A diagnostic guard lowers allocation resolution only after an oversized request is logged; guarded-case pixels are not production correctness or performance evidence.",
  };
}
