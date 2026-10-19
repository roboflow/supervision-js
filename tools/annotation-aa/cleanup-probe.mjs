import * as Pixi from "pixi.js";
import { createBenchBackend } from "../../benchmark/depth/gpu/src/pixi-backend.ts";
import { installPixiFilterBindings } from "#renderers/pixi-filter-bindings";
import { createPixiAnnotationAntialiasFilter } from "#renderers/pixi-annotation-antialias";
import { comparePixels, digest } from "./pixels.mjs";

function createDrawing() {
  const root = new Pixi.Container();
  const region = new Pixi.Container();
  region.addChild(
    new Pixi.Graphics()
      .circle(31.5, 31.5, 12.2)
      .fill({ color: 0x3184ed, alpha: 0.6 }),
  );
  root.addChild(
    new Pixi.Graphics()
      .moveTo(3, 12)
      .lineTo(58, 52)
      .stroke({ color: 0xf82d50, width: 1.1 }),
    region,
  );
  const aa = createPixiAnnotationAntialiasFilter({
    Filter: Pixi.Filter,
    defaultFilterVert: Pixi.defaultFilterVert,
  });
  const blur = new Pixi.BlurFilter({ strength: 2, quality: 1 });
  return { root, region, aa, blur };
}

export async function probeFilterCleanup(requested) {
  const errors = [],
    warnings = [],
    cases = [];
  const previousWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map(String).join(" "));
    previousWarn(...args);
  };
  const owned = [];
  const create = async () => {
    const backend = await createBenchBackend(requested);
    if (backend.description.rendererName !== requested)
      throw Error("cleanup renderer silently fell back");
    backend.app.renderer.gpu?.device.addEventListener(
      "uncapturederror",
      (event) => errors.push(String(event.error)),
    );
    const drawing = createDrawing();
    const target = Pixi.RenderTexture.create({
      width: 64,
      height: 64,
      resolution: 1,
    });
    const releaseBindings = installPixiFilterBindings(
      Pixi,
      backend.app.renderer,
    );
    const item = {
      backend,
      drawing,
      target,
      releaseBindings,
      disposed: false,
      aaRetired: false,
    };
    owned.push(item);
    return item;
  };
  const render = async (item) => {
    item.backend.app.renderer.render({
      container: item.drawing.root,
      target: item.target,
      clear: true,
    });
    await item.backend.finish(item.target);
    return item.backend.readPixels(item.target);
  };
  const dispose = (item) => {
    if (item.disposed) return;
    item.disposed = true;
    item.releaseBindings();
    item.releaseBindings();
    item.drawing.root.filters = null;
    item.drawing.region.filters = null;
    if (!item.aaRetired) item.drawing.aa.destroy();
    item.drawing.blur.destroy();
    item.drawing.root.destroy({ children: true });
    item.target.destroy(true);
    item.backend.destroy();
  };
  try {
    const live = await create();
    live.drawing.root.filters = [live.drawing.aa];
    const liveBefore = await render(live);
    const first = await create();
    first.drawing.root.filters = [first.drawing.aa];
    await render(first);
    first.drawing.aa.enabled = false;
    await render(first);
    first.drawing.root.filters = null;
    first.drawing.aa.destroy();
    first.aaRetired = true;
    first.drawing.region.filters = [first.drawing.blur];
    await render(first);
    dispose(first);
    const liveAfterFirst = await render(live);
    const parity = comparePixels(liveBefore, liveAfterFirst, 64);
    cases.push({
      name: "aa-on-disabled-retired-region-filter-dispose-with-live-renderer",
      secondRendererUnchanged: parity.exact,
      beforeHash: await digest(liveBefore),
      afterHash: await digest(liveAfterFirst),
    });
    if (!parity.exact)
      errors.push(
        "first renderer disposal changed live second renderer output",
      );
    const regionOnly = await create();
    regionOnly.drawing.region.filters = [regionOnly.drawing.blur];
    await render(regionOnly);
    dispose(regionOnly);
    const liveAfterRegion = await render(live);
    const regionParity = comparePixels(liveBefore, liveAfterRegion, 64);
    cases.push({
      name: "region-only-filter-dispose-with-live-renderer",
      secondRendererUnchanged: regionParity.exact,
      beforeHash: await digest(liveBefore),
      afterHash: await digest(liveAfterRegion),
    });
    if (!regionParity.exact)
      errors.push(
        "region-only renderer disposal changed live second renderer output",
      );
    dispose(live);
  } catch (error) {
    errors.push(String(error));
  } finally {
    for (const item of owned) dispose(item);
    console.warn = previousWarn;
  }
  return {
    backend: requested,
    cases,
    errors,
    warnings,
    definition:
      "Three actual Pixi renderers: AA enabled, disabled, retired; region-only BlurFilter; second renderer stays live and must render identical pixels after each other teardown. Production filter-binding cleanup alone is used; no manual group destruction or warning suppression. These are functional pixel/lifecycle probes, without a CPU/GPU timing claim.",
  };
}
