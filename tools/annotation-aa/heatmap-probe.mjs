import * as Pixi from "pixi.js";
import { createBenchBackend } from "../../benchmark/depth/gpu/src/pixi-backend.ts";
import {
  annotationRenderers,
  BaseFocusStyle,
  FocusTargetMode,
} from "supervision-js-core";
import { createPixiFocusHeatmapCutout } from "#renderers/pixi-focus-heatmap-cutout";
import { createPixiFocusLayer } from "#renderers/pixi-focus-layer";
import { installPixiFilterBindings } from "#renderers/pixi-filter-bindings";
import { installPixiBatchTextureBindings } from "#renderers/pixi-batch-texture-bindings";
import {
  createPixiAnnotationAntialiasFilter,
  resolvePixiAnnotationAntialiasResolution,
} from "#renderers/pixi-annotation-antialias";
import { comparePixels, png } from "./pixels.mjs";

const MODES = [
  { name: "none", scale: 1, enabled: false },
  { name: "fxaa1", scale: 1, enabled: true },
  { name: "fxaa2", scale: 2, enabled: true },
  { name: "none-restored", scale: 1, enabled: false },
];
const ISLANDS = [
  { name: "bright", x: 2, y: 2, width: 4, height: 4, alpha: 255 },
  { name: "faint", x: 10, y: 1, width: 4, height: 4, alpha: 1 },
];

export async function probeHeatmapFocus(backend) {
  const width = 64,
    height = 48;
  const target = Pixi.RenderTexture.create({
    width,
    height,
    resolution: 1,
    scaleMode: "nearest",
  });
  const cases = [],
    images = [],
    errors = [];
  for (const sampling of ["nearest", "linear"]) {
    for (const empty of [false, true]) {
      const texture = createTexture(sampling, empty);
      const artifact = {
        texture,
        bounds: { x: width / 2, y: height / 2, width, height },
      };
      const cutout = createPixiFocusHeatmapCutout({ ...Pixi, artifact });
      cutout.render(artifact);
      const group = new Pixi.Container();
      const mask = new Pixi.Container();
      mask.addChild(cutout.display);
      const dim = new Pixi.Graphics()
        .rect(0, 0, width, height)
        .fill({ color: 0, alpha: 0.5 });
      const effect = new Pixi.AlphaMask({ mask });
      dim.setMask({ mask: effect, inverse: true, channel: "alpha" });
      group.addChild(dim, mask);
      const filters = createFilters(backend, width, height);
      const pixels = new Map();
      try {
        for (const { name: mode } of MODES) {
          const filter = filters.get(mode);
          group.filters = filter ? [filter] : null;
          cutout.render(artifact, filter !== undefined);
          backend.app.renderer.render({
            container: group,
            target,
            clear: true,
          });
          await backend.finish(target);
          const values = await backend.readPixels(target);
          pixels.set(mode, values);
          const probes = [
            ["bright-island", 14, 21],
            ["faint-island", 46, 15],
            ["transparent-gap", 32, 24],
            ["outside-islands", 2, 2],
            ["right-edge", width - 1, height / 2],
            ["bottom-edge", width / 2, height - 1],
            ["bottom-right", width - 1, height - 1],
            ["near-right-top", width - 2, 2],
            ["near-bottom-left", 2, height - 2],
          ].map(([name, x, y]) => ({
            name,
            x,
            y,
            alpha: values[(y * width + x) * 4 + 3],
          }));
          const expected = probes.map((_, index) =>
            empty || index >= 2 ? 128 : 0,
          );
          if (
            probes.some((probe, i) => Math.abs(probe.alpha - expected[i]) > 1)
          )
            errors.push(
              `${sampling}/${empty ? "empty" : "islands"}/${mode}: coverage probes failed`,
            );
          let whitePixels = 0;
          for (let i = 0; i < values.length; i += 4)
            whitePixels += Number(values[i] || values[i + 1] || values[i + 2]);
          if (whitePixels)
            errors.push(
              `${sampling}/${empty ? "empty" : "islands"}/${mode}: cutout display leaked white pixels`,
            );
          let minAlpha = 255,
            maxAlpha = 0,
            unexpectedEmptyPixels = 0;
          for (let i = 3; i < values.length; i += 4) {
            minAlpha = Math.min(minAlpha, values[i]);
            maxAlpha = Math.max(maxAlpha, values[i]);
            if (empty && Math.abs(values[i] - 128) > 1) unexpectedEmptyPixels++;
          }
          if (unexpectedEmptyPixels)
            errors.push(
              `${mode}: empty heatmap left ${unexpectedEmptyPixels} pixels outside full dim coverage`,
            );
          const edgeCoverage = [];
          if (!empty && filter) {
            const tolerance = 4;
            for (const [name, firstX, y] of [
              ["bright", 6, 21],
              ["faint", 38, 15],
            ]) {
              for (let offset = 0; offset < 4; offset++) {
                const x = firstX + offset;
                const alpha = values[(y * width + x) * 4 + 3];
                const expectedAlpha = 128 * (1 - (offset * 2 + 1) / 8);
                edgeCoverage.push({
                  name,
                  x,
                  y,
                  alpha,
                  expectedAlpha,
                  tolerance,
                });
                if (Math.abs(alpha - expectedAlpha) > tolerance)
                  errors.push(
                    `${sampling}/${mode}/${name}: boundary ${x},${y} alpha${alpha}, expected${expectedAlpha}`,
                  );
              }
            }
          }
          cases.push({
            sampling,
            empty,
            mode,
            filter: filter
              ? { resolution: filter.resolution, antialias: filter.antialias }
              : null,
            probes,
            edgeCoverage,
            whitePixels,
            minAlpha,
            maxAlpha,
            unexpectedEmptyPixels,
          });
          images.push({
            name: `heatmap-${sampling}-${empty ? "empty" : "islands"}.${mode}`,
            png: png(values, width, height),
          });
        }
        if (
          !comparePixels(pixels.get("none"), pixels.get("none-restored"), width)
            .exact
        )
          errors.push(
            `${sampling}/${empty ? "empty" : "islands"}: restored pixels changed`,
          );
      } finally {
        group.filters = null;
        for (const filter of filters.values()) filter.destroy();
        dim.setMask({ mask: null });
        effect.destroy();
        cutout.destroy();
        group.destroy({ children: true });
        texture.destroy(true);
      }
    }
  }
  target.destroy(true);
  const registration = await probeHeatmapRegistration(backend);
  images.push(...registration.images);
  errors.push(...registration.errors);
  return {
    cases,
    images,
    errors,
    registration: { ...registration, images: undefined },
    definition:
      "Actual heatmap-coverage shader with inverse AlphaMask and both linear/nearest textures: bright and faint-alpha islands, transparent gap and empty map. Off→FXAA1/2→restored Off at output resolution1. FXAA straight-edge probes allow4 alpha bytes. Faint interiors remain fully open and restored Off must match exactly. Additional production FocusLayer registration cases cover fractional viewport bounds, translated/zoomed inverse masks, analytical island centers and unclipped transparent gaps. This validates production shader/mask geometry, not demo frame selection.",
  };
}

function createTexture(sampling, empty = false) {
  const data = new Uint8Array(16 * 8 * 4);
  if (!empty)
    for (const island of ISLANDS)
      for (let y = island.y; y < island.y + island.height; y++)
        for (let x = island.x; x < island.x + island.width; x++)
          data[(y * 16 + x) * 4 + 3] = island.alpha;
  return new Pixi.Texture({
    source: new Pixi.BufferImageSource({
      resource: data,
      width: 16,
      height: 8,
      format: "rgba8unorm",
      alphaMode: "no-premultiply-alpha",
      scaleMode: sampling,
      autoGenerateMipmaps: false,
    }),
  });
}

function createFilters(backend, width, height) {
  return new Map(
    MODES.filter((mode) => mode.enabled).map((mode) => [
      mode.name,
      createPixiAnnotationAntialiasFilter({
        Filter: Pixi.Filter,
        defaultFilterVert: Pixi.defaultFilterVert,
        resolution: resolvePixiAnnotationAntialiasResolution(
          1,
          { width, height },
          backend.description.maxTextureSize,
          mode.scale,
        ),
      }),
    ]),
  );
}

/** Isolates padded AA registration from irregular heatmap color weighting. */
export async function probeHeatmapRegistration(backend) {
  const width = 128,
    height = 96;
  const bounds = { x: 86.25, y: 61.5, width: 96, height: 56 };
  const cameras = [
    { name: "fractional-offset", scale: 1, x: -17.25, y: -11.375 },
    { name: "clipped-zoom-pan", scale: 1.375, x: -60.125, y: -36.375 },
  ];
  const target = Pixi.RenderTexture.create({ width, height, resolution: 1 });
  const cases = [],
    images = [],
    errors = [];
  const previousScreen = {
    width: backend.app.renderer.screen.width,
    height: backend.app.renderer.screen.height,
    resolution: backend.app.renderer.resolution,
  };
  backend.app.renderer.resize(width, height, 1);
  try {
    for (const sampling of ["nearest", "linear"])
      for (const camera of cameras) {
        const texture = createTexture(sampling);
        const artifact = { texture, bounds, detectionIndex: 0 };
        const frame = {
          mediaTime: 0,
          detections: [
            {
              heatmap: {
                width: 16,
                height: 8,
                bounds,
                values: Array.from(
                  { length: 128 },
                  (_, index) => texture.source.resource[index * 4 + 3] / 255,
                ),
              },
            },
          ],
        };
        const viewport = {
          x: -camera.x / camera.scale,
          y: -camera.y / camera.scale,
          width: width / camera.scale,
          height: height / camera.scale,
        };
        let mode = MODES[0];
        const focus = createPixiFocusLayer({
          ...Pixi,
          focusStyle: new BaseFocusStyle({
            targetMode: FocusTargetMode.Ambient,
            fill: { color: 0, alpha: 0.5 },
            shape: null,
          }),
          getAnnotationAntialiasing: () => mode.enabled,
          getHeatmapRenderers: () => [annotationRenderers.heatmap()],
          getViewportBounds: () => viewport,
        });
        const group = new Pixi.Container();
        group.addChild(focus.createDisplay({ width: 184, height: 128 }));
        const scene = new Pixi.Container();
        scene.position.set(camera.x, camera.y);
        scene.scale.set(camera.scale);
        scene.addChild(group);
        const stage = new Pixi.Container();
        stage.addChild(scene);
        const filters = createFilters(backend, width, height);
        const pixels = new Map();
        try {
          for (mode of MODES) {
            const phase = `${sampling}/${camera.name}/${mode.name}`;
            const filter = filters.get(mode.name);
            group.filters = filter ? [filter] : null;
            focus.drawFrame({
              frame,
              mediaTime: 0,
              hoveredPick: null,
              selectedPick: null,
              heatmapArtifacts: [artifact],
            });
            focus.syncViewportBounds();
            focus.tick(0);
            focus.tick(120);
            backend.app.renderer.render({
              container: stage,
              target,
              clear: true,
            });
            await backend.finish(target);
            const values = await backend.readPixels(target);
            pixels.set(mode.name, values);
            const registration = inspectRegistration(
              values,
              width,
              height,
              bounds,
              camera,
              mode,
            );
            const row = {
              phase,
              sampling,
              camera,
              mode: mode.name,
              viewport,
              bounds,
              filter: filter
                ? {
                    resolution: filter.resolution,
                    antialias: filter.antialias,
                    padding: filter.padding,
                  }
                : null,
              ...registration,
            };
            cases.push(row);
            if (
              registration.probes.some(
                (probe) => Math.abs(probe.alpha - probe.expectedAlpha) > 1,
              )
            )
              errors.push(
                `${phase}: interior/gap/corner registration probes failed`,
              );
            if (registration.gap.changedPixels || registration.whitePixels)
              errors.push(
                `${phase}: transparent gap or dim-only color changed`,
              );
            for (const island of registration.islands) {
              if (
                !island.centroid ||
                island.mass < 128 ||
                Math.max(Math.abs(island.delta.x), Math.abs(island.delta.y)) >
                  island.tolerance
              )
                errors.push(
                  `${phase}/${island.name}: hole centroid or interior coverage shifted`,
                );
            }
            for (const edge of registration.edges)
              if (Math.abs(edge.alpha - edge.expectedAlpha) > edge.tolerance)
                errors.push(
                  `${phase}/${edge.name}: straight edge ${edge.x},${edge.y} alpha${edge.alpha}, expected${edge.expectedAlpha}`,
                );
            images.push({
              name: `heatmap-registration.${phase.replaceAll("/", ".")}`,
              png: png(values, width, height),
            });
          }
          const restored = comparePixels(
            pixels.get("none"),
            pixels.get("none-restored"),
            width,
          );
          cases.push({
            phase: `${sampling}/${camera.name}/restore-parity`,
            restored,
          });
          if (!restored.exact)
            errors.push(
              `${sampling}/${camera.name}: restored Off registration changed`,
            );
        } finally {
          group.filters = null;
          for (const filter of filters.values()) filter.destroy();
          focus.destroy();
          stage.destroy({ children: true });
          texture.destroy(true);
        }
      }
  } finally {
    target.destroy(true);
    backend.app.renderer.resize(
      previousScreen.width,
      previousScreen.height,
      previousScreen.resolution,
    );
  }
  return {
    output: { width, height, resolution: 1 },
    cameras,
    cases,
    images,
    errors,
    definition:
      "Production FocusLayer with inverse AlphaMask, visible texture artifacts and fractional media-coordinate viewport bounds. Two asymmetric placements contain independently symmetric bright/faint islands; zoom/pan partially clips the mask quad. Fully open interiors and the transparent gap remain exact within1 alpha byte. Hole centroids must match analytical geometry within0.3 output pixels with AA, or0.6 for binary Off. Enabled-mode straight edges compare with bilinear binary support at tolerance4 alpha bytes. Every Off restore is byte exact. These registration oracles do not compare irregular heatmap color centroids or measure performance.",
  };
}

/** Runs the registration cases with one owned backend and production cleanup. */
export async function probeHeatmapRegistrationBackend(requested) {
  const backend = await createBenchBackend(requested);
  const releaseBatch = installPixiBatchTextureBindings(
    Pixi,
    backend.app.renderer,
  );
  const releaseFilters = installPixiFilterBindings(Pixi, backend.app.renderer);
  const warnings = [],
    runtimeErrors = [];
  const priorWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map(String).join(" "));
    priorWarn(...args);
  };
  const device = backend.app.renderer.gpu?.device;
  const onGpuError = (event) => runtimeErrors.push(String(event.error));
  device?.addEventListener("uncapturederror", onGpuError);
  try {
    if (backend.description.rendererName !== requested)
      throw Error("heatmap registration backend silently fell back");
    const report = await probeHeatmapRegistration(backend);
    return {
      ...report,
      backend: backend.description,
      warnings,
      errors: report.errors.concat(runtimeErrors),
    };
  } finally {
    releaseBatch();
    releaseFilters();
    backend.destroy();
    device?.removeEventListener("uncapturederror", onGpuError);
    console.warn = priorWarn;
  }
}

function inspectRegistration(values, width, height, bounds, camera, mode) {
  const texel = {
    x: (bounds.width / 16) * camera.scale,
    y: (bounds.height / 8) * camera.scale,
  };
  const origin = {
    x: (bounds.x - bounds.width / 2) * camera.scale + camera.x,
    y: (bounds.y - bounds.height / 2) * camera.scale + camera.y,
  };
  const alphaAt = (x, y) => values[(y * width + x) * 4 + 3];
  const corner = [alphaAt(2, 2), alphaAt(width - 3, height - 3)].sort(
    (a, b) => a - b,
  )[1];
  const point = (island) => ({
    x: origin.x + (island.x + island.width / 2) * texel.x,
    y: origin.y + (island.y + island.height / 2) * texel.y,
  });
  const islands = ISLANDS.map((island) => {
    const expected = point(island);
    const left = Math.max(
      0,
      Math.floor(origin.x + island.x * texel.x - texel.x / 2 - 3),
    );
    const right = Math.min(
      width,
      Math.ceil(
        origin.x + (island.x + island.width) * texel.x + texel.x / 2 + 3,
      ),
    );
    const top = Math.max(
      0,
      Math.floor(origin.y + island.y * texel.y - texel.y / 2 - 3),
    );
    const bottom = Math.min(
      height,
      Math.ceil(
        origin.y + (island.y + island.height) * texel.y + texel.y / 2 + 3,
      ),
    );
    let mass = 0,
      weightedX = 0,
      weightedY = 0;
    for (let y = top; y < bottom; y++)
      for (let x = left; x < right; x++) {
        const alpha = alphaAt(x, y);
        if (alpha >= corner - 1) continue;
        const weight = (corner - alpha) / corner;
        mass += weight;
        weightedX += (x + 0.5) * weight;
        weightedY += (y + 0.5) * weight;
      }
    const centroid = mass ? { x: weightedX / mass, y: weightedY / mass } : null;
    return {
      name: island.name,
      expected,
      centroid,
      mass,
      expectedMass: island.width * texel.x * island.height * texel.y,
      delta: centroid
        ? { x: centroid.x - expected.x, y: centroid.y - expected.y }
        : null,
      tolerance: mode.enabled ? 0.3 : 0.6,
    };
  });
  const gapCenter = {
    x: bounds.x * camera.scale + camera.x,
    y: bounds.y * camera.scale + camera.y,
  };
  const probes = [
    ...islands.map((island) => [
      island.name,
      Math.floor(island.expected.x),
      Math.floor(island.expected.y),
      0,
    ]),
    ["gap", Math.floor(gapCenter.x), Math.floor(gapCenter.y), 128],
    ["top-left", 2, 2, 128],
    ["bottom-right", width - 3, height - 3, 128],
    ["viewport-top-left", 0, 0, 128],
    ["viewport-top-right", width - 1, 0, 128],
    ["viewport-bottom-left", 0, height - 1, 128],
    ["viewport-bottom-right", width - 1, height - 1, 128],
    ["viewport-top", Math.floor(width / 2), 0, 128],
    ["viewport-right", width - 1, Math.floor(height / 2), 128],
    ["viewport-bottom", Math.floor(width / 2), height - 1, 128],
    ["viewport-left", 0, Math.floor(height / 2), 128],
  ].map(([name, x, y, expectedAlpha]) => ({
    name,
    x,
    y,
    alpha: alphaAt(x, y),
    expectedAlpha,
  }));
  let gapPixels = 0,
    gapChangedPixels = 0,
    whitePixels = 0;
  for (
    let y = Math.floor(gapCenter.y - 3 * camera.scale);
    y < Math.ceil(gapCenter.y + 3 * camera.scale);
    y++
  )
    for (
      let x = Math.floor(gapCenter.x - 3 * camera.scale);
      x < Math.ceil(gapCenter.x + 3 * camera.scale);
      x++
    ) {
      gapPixels++;
      gapChangedPixels += Number(Math.abs(alphaAt(x, y) - 128) > 1);
    }
  for (let i = 0; i < values.length; i += 4)
    whitePixels += Number(values[i] || values[i + 1] || values[i + 2]);
  const edges = [];
  if (mode.enabled)
    for (const island of ISLANDS) {
      const center = point(island);
      const boundary = origin.x + island.x * texel.x;
      const y = Math.floor(center.y);
      for (
        let x = Math.max(0, Math.floor(boundary - texel.x / 2));
        x < Math.min(width, Math.ceil(boundary + texel.x / 2));
        x++
      ) {
        const support = Math.max(
          0,
          Math.min(1, 0.5 + (x + 0.5 - boundary) / texel.x),
        );
        edges.push({
          name: island.name,
          x,
          y,
          alpha: alphaAt(x, y),
          expectedAlpha: 128 * (1 - support),
          tolerance: 4,
        });
      }
    }
  return {
    islands,
    probes,
    edges,
    gap: { pixels: gapPixels, changedPixels: gapChangedPixels },
    whitePixels,
  };
}
