import * as Pixi from "pixi.js";
import {
  DetectionPickTarget,
  encodeBinaryMask,
  LabelPlacement,
  StrokeAlignment,
} from "supervision-js-core";
import { createBenchBackend } from "../../benchmark/depth/gpu/src/pixi-backend.ts";
import { createPixiAnnotationAntialiasLayer } from "#renderers/pixi-annotation-antialias-layer";
import { createPixiLabelLayer } from "#renderers/pixi-label-layer";
import { createPixiInteractionPresentationLayer } from "#renderers/pixi-interaction-presentation-layer";
import { PreparedMaskFrameKind } from "#render-preparation/mask-frame-artifact";
import {
  createPixiSceneLayerSlot,
  PixiSceneLayerKind,
} from "#renderers/pixi-scene-layer-slot";
import { installPixiBatchTextureBindings } from "#renderers/pixi-batch-texture-bindings";
import { installPixiFilterBindings } from "#renderers/pixi-filter-bindings";
import { comparePixels, png } from "./pixels.mjs";

const WIDTH = 208,
  HEIGHT = 112;
const BACKGROUND = { paddingX: 8, paddingY: 6, cornerRadius: 7 };
const ITEMS = [
  {
    id: "back",
    x: 16.25,
    y: 20.5,
    text: "Aa MW",
    color: 0xffffff,
    background: 0x932dec,
  },
  {
    id: "front",
    x: 45.75,
    y: 29.25,
    text: "WAVE",
    color: 0xfcfa5d,
    background: 0x1dcaed,
  },
];
const MODES = [
  { name: "off", value: false, resolution: 1 },
  { name: "fxaa1", value: true, resolution: 1 },
  { name: "fxaa2", value: 2, resolution: 2 },
  { name: "off-restored", value: false, resolution: 1 },
];
const TEXT_STYLE = { fontFamily: "Arial", fontSize: 18, fontWeight: "600" };

/** Checks sharp glyphs and ordered translucent chips against direct Pixi controls. */
export async function probeSharpLabelAntialias(requested) {
  const cases = [],
    images = [],
    errors = [],
    warnings = [];
  let backend,
    root,
    target,
    labels,
    interaction,
    interactionMask,
    aa,
    mediaTexture,
    direct,
    releaseBatch,
    releaseFilters;
  let enabled = false,
    consumer = "labels",
    scoped = false,
    device,
    phase = "opening";
  const previousWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map(String).join(" "));
    previousWarn(...args);
  };
  try {
    backend = await createBenchBackend(requested);
    if (backend.description.rendererName !== requested)
      throw Error("label probe backend silently fell back");
    device = backend.app.renderer.gpu?.device;
    device?.addEventListener("uncapturederror", (event) =>
      errors.push(String(event.error)),
    );
    if (device) {
      device.pushErrorScope("validation");
      scoped = true;
    }
    releaseBatch = installPixiBatchTextureBindings(Pixi, backend.app.renderer);
    releaseFilters = installPixiFilterBindings(Pixi, backend.app.renderer);
    backend.app.renderer.resize(WIDTH, HEIGHT, 1);
    target = Pixi.RenderTexture.create({
      width: WIDTH,
      height: HEIGHT,
      resolution: 1,
    });
    root = new Pixi.Container();
    mediaTexture = createMediaTexture();
    const media = new Pixi.Sprite(mediaTexture);
    const vector = new Pixi.Graphics()
      .moveTo(139.25, 19.5)
      .lineTo(164.5, 54.25)
      .lineTo(146.5, 88.5)
      .stroke({ color: 0xfb9243, width: 1.5 });
    const frame = {
      mediaTime: 0,
      frameIndex: 0,
      detections: ITEMS.map((item) => ({
        id: item.id,
        rect: { x: item.x + 50, y: item.y + 16, width: 100, height: 32 },
      })),
    };
    labels = createPixiLabelLayer({
      ...Pixi,
      detectionTimeline: { selectFrame: () => frame },
      labelStyle: style(false),
    });
    const labelDisplay = labels.createContainer();
    interaction = createPixiInteractionPresentationLayer({ ...Pixi });
    const interactionDisplay = interaction.createDisplay({
      width: WIDTH,
      height: HEIGHT,
    });
    const interactionLabelDisplay = interaction.getLabelDisplay();
    if (!interactionLabelDisplay || interactionLabelDisplay.parent)
      throw Error("interaction labels belong to the geometry capture");
    const interactionSlot = createPixiSceneLayerSlot(
      PixiSceneLayerKind.Interaction,
    );
    interactionSlot.setDisplay(interactionDisplay);
    const interactionLabelSlot = createPixiSceneLayerSlot(
      PixiSceneLayerKind.Label,
      interactionSlot.order,
    );
    interactionLabelSlot.setDisplay(interactionLabelDisplay);
    const slots = [
      [PixiSceneLayerKind.Media, media],
      [PixiSceneLayerKind.Vector, vector],
      [PixiSceneLayerKind.Label, labelDisplay],
    ].map(([kind, display]) => {
      const slot = createPixiSceneLayerSlot(kind);
      slot.setDisplay(display);
      return slot;
    });
    slots.push(interactionSlot, interactionLabelSlot);
    aa = createPixiAnnotationAntialiasLayer({
      ...Pixi,
      getEnabled: () => enabled,
    });
    const capture = async (container = root) => {
      backend.app.renderer.render({ container, target, clear: true });
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
    const configure = (mode, backgrounds) => {
      enabled = Boolean(mode.value);
      aa.setResolution(mode.resolution);
      aa.sync(root, slots);
      labels.setBackgroundAntialiasFilter(aa.getFxaaFilter());
      labels.setLabelStyle(style(backgrounds));
      labels.drawFrame(0);
      interaction.setBackgroundAntialiasFilter(aa.getFxaaFilter());
      interaction.setInteractionStyle({
        resolve: () => ({ labelStyle: style(backgrounds) }),
      });
      interaction.drawFrame({
        frame,
        mediaTime: 0,
        selectedPick: {
          frame,
          detection: frame.detections[0],
          detectionIndex: 0,
          mediaTime: 0,
          point: { x: ITEMS[0].x, y: ITEMS[0].y },
          target: DetectionPickTarget.Label,
        },
        hoveredPick: {
          frame,
          detection: frame.detections[1],
          detectionIndex: 1,
          mediaTime: 0,
          point: { x: ITEMS[1].x, y: ITEMS[1].y },
          target: DetectionPickTarget.Label,
        },
      });
      labelDisplay.visible = consumer === "labels";
      interactionDisplay.visible = interactionLabelDisplay.visible =
        consumer === "interaction";
      return ITEMS.map((item) => labels.getDetectionLabelBounds(item.id));
    };
    configure(MODES[0], false);
    labelDisplay.visible = vector.visible = false;
    const originalMedia = await capture();
    labelDisplay.visible = true;
    media.visible = false;
    for (consumer of ["labels", "interaction"]) {
      let textOff, chipOff;
      for (const backgrounds of [false, true]) {
        for (const mode of MODES) {
          phase = `${consumer}/${backgrounds ? "rounded-overlap" : "text-only"}/${mode.name}`;
          const bounds = configure(mode, backgrounds);
          if (bounds.some((value) => value === null))
            throw Error(`${phase}: labels not drawn`);
          const actual = await capture();
          direct = createDirectControl(bounds, backgrounds, aa.getFxaaFilter());
          const ordered = await capture(direct.root);
          const parity = comparePixels(actual, ordered, WIDTH);
          const row = {
            phase,
            mode: mode.value,
            captureResolution: mode.resolution,
            bounds,
            orderedControl: parity,
          };
          cases.push(row);
          if (!parity.exact)
            errors.push(
              `${phase}: label output differs from direct ordered text/chip control`,
            );
          images.push({
            name: phase.replaceAll("/", "."),
            png: png(actual, WIDTH, HEIGHT),
          });
          if (!backgrounds) {
            if (mode.name === "off") textOff = actual;
            row.vsOff = comparePixels(actual, textOff, WIDTH);
            row.glyphPixels = countGlyphPixels(actual);
            if (!row.vsOff.exact || row.glyphPixels < 64)
              errors.push(
                `${phase}: sharp text changed or glyph oracle was empty`,
              );
          } else {
            if (mode.name === "off") chipOff = actual;
            row.vsOff = comparePixels(actual, chipOff, WIDTH);
            direct.root.removeChildren();
            direct.root.addChild(...direct.backgrounds, ...direct.texts);
            const wrongOrder = await capture(direct.root);
            row.vsWrongPaintOrder = comparePixels(actual, wrongOrder, WIDTH);
            if (row.vsWrongPaintOrder.changedPixels < 16)
              errors.push(
                `${phase}: overlap fixture does not distinguish wrong paint order`,
              );
            row.cornerChangedPixels = cornerChanges(chipOff, actual, bounds);
            if (mode.value && row.cornerChangedPixels === 0)
              errors.push(
                `${phase}: AA did not change rounded chip contour pixels`,
              );
            if (mode.name === "off-restored" && !row.vsOff.exact)
              errors.push(
                `${phase}: original chips did not restore after AA toggles`,
              );
          }
          direct.destroy();
          direct = undefined;
          media.visible = vector.visible = true;
          const composite = await capture();
          row.untouchedMedia = comparePixels(composite, originalMedia, WIDTH, {
            x: 180,
            y: 0,
            width: 28,
            height: HEIGHT,
          });
          if (!row.untouchedMedia.exact)
            errors.push(`${phase}: reserved media pixels changed`);
          media.visible = vector.visible = false;
        }
      }
    }
    interactionMask = createInteractionMask();
    const maskFrame = {
      mediaTime: 0,
      detections: [{ id: "inside", mask: interactionMask.mask }],
    };
    interaction.setInteractionStyle({
      resolve: () => ({
        maskStyle: {
          resolve: () => ({
            mask: interactionMask.mask,
            alpha: 1,
            color: 0x00ff00,
            stroke: {
              alpha: 1,
              color: 0xff0000,
              width: 3,
              alignment: StrokeAlignment.Inside,
            },
          }),
        },
      }),
    });
    labelDisplay.visible = media.visible = vector.visible = false;
    interactionDisplay.visible = interactionLabelDisplay.visible = true;
    let insideOff;
    for (const mode of MODES) {
      phase = `interaction/inside/${mode.name}`;
      enabled = Boolean(mode.value);
      aa.setResolution(mode.resolution);
      aa.sync(root, slots);
      interaction.drawFrame({
        frame: maskFrame,
        mediaTime: 0,
        hoveredPick: null,
        selectedPick: {
          frame: maskFrame,
          detection: maskFrame.detections[0],
          detectionIndex: 0,
          mediaTime: 0,
          point: { x: 143, y: 84 },
          target: DetectionPickTarget.Mask,
        },
        idMaskArtifact: interactionMask.artifact,
        strokePixelRatio: mode.resolution,
      });
      const actual = await capture();
      const samples = [
        [143, 84],
        [151, 73],
        [151, 84],
        [138, 84],
      ].map(([x, y]) => [
        ...actual.subarray((y * WIDTH + x) * 4, (y * WIDTH + x) * 4 + 4),
      ]);
      if (mode.name === "off") insideOff = actual;
      const row = {
        phase,
        samples,
        vsOff: comparePixels(actual, insideOff, WIDTH),
      };
      cases.push(row);
      for (const red of samples.slice(0, 2))
        if (red[0] < 250 || red[1] > 3 || red[2] > 3 || red[3] < 250)
          errors.push(`${phase}: inside interaction outline is missing`);
      if (samples[2].join() !== "0,255,0,255" || samples[3].some(Boolean))
        errors.push(
          `${phase}: inside stroke changed interior fill or outside coverage`,
        );
      if (mode.name === "off-restored" && !row.vsOff.exact)
        errors.push(`${phase}: inside interaction outline did not restore`);
      images.push({
        name: phase.replaceAll("/", "."),
        png: png(actual, WIDTH, HEIGHT),
      });
    }
  } catch (error) {
    errors.push(`${phase}: ${String(error)}`);
  } finally {
    releaseFilters?.();
    releaseBatch?.();
    direct?.destroy();
    labels?.setBackgroundAntialiasFilter(null);
    interaction?.setBackgroundAntialiasFilter(null);
    aa?.destroy();
    labels?.destroy();
    interaction?.destroy();
    root?.destroy({ children: true });
    interactionMask?.artifact.texture.destroy(true);
    mediaTexture?.destroy(true);
    target?.destroy(true);
    if (scoped) {
      const error = await device.popErrorScope();
      if (error) errors.push(String(error));
    }
    backend?.destroy();
    console.warn = previousWarn;
  }
  return {
    backend: requested,
    nativeDpr: window.devicePixelRatio,
    output: { width: WIDTH, height: HEIGHT, resolution: 1 },
    cases,
    images,
    errors,
    warnings,
    definition:
      "Actual production annotation-AA composition for main labels and selected/hovered interaction labels, Off/FXAA1/FXAA2/restored Off. Background-disabled glyph pixels must match direct unfiltered Pixi.Text and Off exactly. Two overlapping translucent rounded chips must match independently ordered background-then-text pairs and differ from all-backgrounds-then-texts; enabled AA must alter corner pixels. An interaction mask's opaque red inside stroke and green interior are checked at flat edges against independent rectangle coordinates. A reserved high-frequency media strip stays byte-identical.",
    limits:
      "One Arial fixture at output resolution 1, with fractional label positions and explicit all-rounded corners. Direct controls take placement bounds from the public label API; this does not independently test layout, attachment corners, other fonts/zooms or real video decoding. Changed contour pixels prove AA is active, not a perceptual quality score. No timing claim.",
  };
}

/** Supplies independent categorical mask pixels for the inside-stroke oracle. */
function createInteractionMask() {
  const raster = new Uint8Array(WIDTH * HEIGHT);
  for (let y = 72; y < 102; y++)
    for (let x = 142; x < 164; x++) raster[y * WIDTH + x] = 1;
  const texture = new Pixi.Texture({
    source: new Pixi.BufferImageSource({
      resource: raster,
      width: WIDTH,
      height: HEIGHT,
      format: "r8unorm",
      alphaMode: "no-premultiply-alpha",
      scaleMode: "nearest",
      autoGenerateMipmaps: false,
    }),
  });
  return {
    mask: encodeBinaryMask(raster, WIDTH, HEIGHT),
    artifact: {
      texture,
      frame: {
        kind: PreparedMaskFrameKind.IdMask,
        width: WIDTH,
        height: HEIGHT,
        sourceWidth: WIDTH,
      },
    },
  };
}

function style(backgrounds) {
  return {
    resolve(detection) {
      const item = ITEMS.find((value) => value.id === detection.id);
      return {
        rect: detection.rect,
        text: item.text,
        placement: LabelPlacement.InsideTop,
        textStyle: { ...TEXT_STYLE, color: item.color },
        ...(backgrounds
          ? {
              background: {
                ...BACKGROUND,
                color: item.background,
                alpha: 0.65,
                topCornersOnly: false,
              },
            }
          : {}),
      };
    },
  };
}

function createDirectControl(bounds, backgrounds, filter) {
  const root = new Pixi.Container(),
    chips = [],
    texts = [];
  ITEMS.forEach((item, index) => {
    const rect = bounds[index];
    if (backgrounds) {
      const chip = new Pixi.Container();
      chip.filters = filter ? [filter] : null;
      const shape = new Pixi.Graphics()
        .roundRect(0, 0, rect.width, rect.height, BACKGROUND.cornerRadius)
        .fill({ color: item.background, alpha: 0.65 });
      shape.position.set(rect.x, rect.y);
      chip.addChild(shape);
      chips.push(chip);
      root.addChild(chip);
    }
    const text = new Pixi.Text({
      text: item.text,
      style: { ...TEXT_STYLE, fill: item.color },
    });
    text.position.set(
      rect.x + (backgrounds ? BACKGROUND.paddingX : 0),
      rect.y + (backgrounds ? BACKGROUND.paddingY : 0),
    );
    texts.push(text);
    root.addChild(text);
  });
  return {
    root,
    backgrounds: chips,
    texts,
    destroy() {
      for (const chip of chips) chip.filters = null;
      root.destroy({ children: true });
    },
  };
}

function createMediaTexture() {
  const resource = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++)
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 4;
      resource.set(
        [
          29 + ((x + y) % 2) * 75,
          (x * 17 + y * 3) % 256,
          61 + ((x + y) % 2) * 133,
          255,
        ],
        i,
      );
    }
  return new Pixi.Texture({
    source: new Pixi.BufferImageSource({
      resource,
      width: WIDTH,
      height: HEIGHT,
      format: "rgba8unorm",
      alphaMode: "no-premultiply-alpha",
      scaleMode: "nearest",
      autoGenerateMipmaps: false,
    }),
  });
}

function countGlyphPixels(pixels) {
  let count = 0;
  for (let i = 3; i < pixels.length; i += 4) count += Number(pixels[i] > 0);
  return count;
}

function cornerChanges(off, actual, bounds) {
  let changes = 0;
  for (const rect of bounds)
    for (const x of [rect.x, rect.x + rect.width - 12])
      for (const y of [rect.y, rect.y + rect.height - 12])
        changes += comparePixels(off, actual, WIDTH, {
          x: Math.floor(x) - 2,
          y: Math.floor(y) - 2,
          width: 16,
          height: 16,
        }).changedPixels;
  return changes;
}
