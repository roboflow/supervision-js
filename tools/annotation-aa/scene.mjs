import * as Pixi from "pixi.js";
import { KeypointMarkerShape } from "supervision-js-core";
import { createPixiIdMaskShaderRenderer } from "#renderers/pixi-id-mask-shader";
import { createFocusIdMaskRenderer } from "#renderers/pixi-focus-layer";
import { createPixiBoxLayer } from "#renderers/pixi-box-layer";
import { createPixiLabelLayer } from "#renderers/pixi-label-layer";
import { drawPixiPath } from "#renderers/pixi-path";
import { drawPixiKeypointInstruction } from "#renderers/pixi-vector-layer";
import { MAX_ID_MASK_PALETTE_ENTRIES } from "#render-preparation/mask-frame-compositor";
import { PreparedMaskFrameKind } from "#render-preparation/mask-frame-artifact";

export const WIDTH = 768;
export const HEIGHT = 512;
export const regions = {
  categoricalMasks: { x: 12, y: 28, width: 208, height: 208 },
  vectorsAndKeypoints: { x: 250, y: 25, width: 230, height: 225 },
  thinMaskFeature: { x: 174, y: 132, width: 18, height: 62 },
  thinVectorStroke: { x: 310, y: 163, width: 22, height: 22 },
  boxes: { x: 250, y: 285, width: 220, height: 205 },
  labels: { x: 16, y: 285, width: 210, height: 100 },
  focus: { x: 520, y: 260, width: 208, height: 208 },
  untouchedMedia: { x: 736, y: 0, width: 32, height: 512 },
};

function makeRaster() {
  const side = 64;
  const raster = new Uint8Array(side * side);
  for (let y = 5; y < 59; y++) {
    for (let x = 5; x < 59; x++) {
      if (x + y < 62 && x > y / 4) raster[y * side + x] = 1;
      if (x >= 25 && x <= 48 && y >= 19 && y <= 48 && x - y < 19)
        raster[y * side + x] = 3;
      if (x >= 16 && x <= 21 && y >= 23 && y <= 28) raster[y * side + x] = 0;
      if (x === 55 && y >= 35 && y <= 52) raster[y * side + x] = 1;
    }
  }
  return raster;
}

function palette(alpha) {
  const values = new Float32Array(MAX_ID_MASK_PALETTE_ENTRIES * 4);
  values.set([1, 0, 0, alpha], 4);
  values.set([0, 1, 0, 1], 8);
  values.set([0, 0, 1, alpha], 12);
  return values;
}

function makeMask() {
  const raster = makeRaster();
  const strokeWidths = new Float32Array(MAX_ID_MASK_PALETTE_ENTRIES);
  const strokeAlignments = new Float32Array(MAX_ID_MASK_PALETTE_ENTRIES);
  strokeWidths[1] = strokeWidths[3] = 3;
  strokeAlignments[1] = strokeAlignments[3] = 0.5;
  const frame = {
    kind: PreparedMaskFrameKind.IdMask,
    key: "annotation-aa-fixed-mask",
    width: 64,
    height: 64,
    sourceWidth: 64,
    raster,
    fillPalette: palette(0.35),
    strokePalette: palette(1),
    strokeAlignments,
    strokeWidths,
    hasStroke: true,
    maxStrokeWidth: 1.5,
    close() {},
  };
  const source = new Pixi.BufferImageSource({
    resource: raster,
    width: 64,
    height: 64,
    format: "r8unorm",
    alphaMode: "no-premultiply-alpha",
    scaleMode: "nearest",
    autoGenerateMipmaps: false,
  });
  const texture = new Pixi.Texture({ source });
  return { frame, texture, raster };
}

function backgroundTexture() {
  const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 4;
      const checker = (x + y) % 2 === 0;
      const calibrationStrip = x >= WIDTH - 32;
      pixels[i] = calibrationStrip
        ? checker
          ? 29
          : 104
        : 36 + Math.floor(x / 48);
      pixels[i + 1] = calibrationStrip
        ? (x * 17 + y * 3) % 256
        : 46 + Math.floor(y / 24);
      pixels[i + 2] = calibrationStrip
        ? checker
          ? 194
          : 61
        : 59 + Math.floor((x + y) / 64);
      pixels[i + 3] = 255;
    }
  }
  return new Pixi.Texture({
    source: new Pixi.BufferImageSource({
      resource: pixels,
      width: WIDTH,
      height: HEIGHT,
      format: "rgba8unorm",
      alphaMode: "no-premultiply-alpha",
      scaleMode: "nearest",
      autoGenerateMipmaps: false,
    }),
  });
}

export function createScene() {
  const stage = new Pixi.Container();
  const overlays = new Pixi.Container();
  const backgroundSource = backgroundTexture();
  const background = new Pixi.Sprite(backgroundSource);
  stage.addChild(background, overlays);
  const mask = makeMask();
  const maskOwner = createPixiIdMaskShaderRenderer({
    ...Pixi,
    mediaWidth: 64,
    mediaHeight: 64,
  });
  const maskDisplay = new Pixi.Container();
  maskDisplay.position.set(16.25, 32.5);
  maskDisplay.scale.set(3);
  maskDisplay.addChild(maskOwner.mesh);
  let strokePixelRatio = 1;
  maskOwner.render(mask.frame, mask.texture, strokePixelRatio);

  const vectors = new Pixi.Graphics();
  drawPixiPath(
    vectors,
    [
      { x: 262.25, y: 52.5 },
      { x: 430.5, y: 219.25 },
      { x: 287.5, y: 201.5 },
    ],
    true,
    { color: 0xffb92d, alpha: 1, width: 1.5 },
    1,
  );
  drawPixiPath(
    vectors,
    [
      { x: 266.5, y: 225.5 },
      { x: 433.25, y: 57.25 },
    ],
    false,
    { color: 0x21e4fa, alpha: 1, width: 1 },
    1,
  );
  const points = [
    { x: 290.25, y: 55.5 },
    { x: 341.5, y: 139.25 },
    { x: 435.25, y: 110.5 },
  ];
  drawPixiKeypointInstruction(
    vectors,
    {
      edges: points.slice(1).map((to, i) => ({
        from: points[i],
        to,
        stroke: { color: 0x35d956, alpha: 0.9, width: 1.5 },
      })),
      markers: points.map((point, index) => ({
        index,
        point,
        radius: 5,
        shape: KeypointMarkerShape.Circle,
        fill: { color: 0x35d956, alpha: 1 },
        stroke: { color: 0xffffff, alpha: 1, width: 1 },
      })),
    },
    1,
  );

  const frame = {
    mediaTime: 0,
    frameIndex: 0,
    detections: [
      { id: "box", rect: { x: 349.25, y: 386.5, width: 165, height: 162 } },
      { id: "label", rect: { x: 118.25, y: 349.5, width: 186, height: 70 } },
    ],
  };
  const detectionTimeline = { selectFrame: () => frame };
  const box = createPixiBoxLayer({
    ...Pixi,
    detectionTimeline,
    boxStyle: {
      resolve: (detection) =>
        detection.id === "box"
          ? {
              rect: detection.rect,
              shape: "roundedRect",
              cornerRadius: 8,
              stroke: { color: 0xffb92d, alpha: 1, width: 1.5 },
            }
          : undefined,
    },
  });
  const boxDisplay = box.createContainer();
  box.drawFrame(0);
  boxDisplay.rotation = 0.06;
  const label = createPixiLabelLayer({
    ...Pixi,
    detectionTimeline,
    labelStyle: {
      resolve: (detection) =>
        detection.id === "label"
          ? {
              rect: detection.rect,
              text: "Mask label",
              placement: "top",
              textStyle: {
                color: 0xffffff,
                fontFamily: "Arial",
                fontSize: 19,
                fontWeight: "600",
              },
              background: {
                color: 0x7c31db,
                alpha: 1,
                paddingX: 8,
                paddingY: 5,
                cornerRadius: 7,
                topCornersOnly: false,
              },
            }
          : undefined,
    },
  });
  const labelDisplay = label.createContainer();
  label.drawFrame(0);

  const focus = createFocusIdMaskRenderer({
    ...Pixi,
    mediaWidth: 64,
    mediaHeight: 64,
  });
  const focusDisplay = new Pixi.Container();
  focusDisplay.position.set(528.25, 272.5);
  focusDisplay.scale.set(3);
  focusDisplay.addChild(focus.mesh);
  focus.render(
    mask.frame,
    mask.texture,
    [1],
    { color: 0x000000, alpha: 0.45 },
    false,
  );
  overlays.addChild(maskDisplay, vectors, boxDisplay, focusDisplay);
  stage.addChild(labelDisplay);
  return {
    setAnnotationFilter(filter) {
      overlays.filters = filter ? [filter] : null;
      label.setBackgroundAntialiasFilter(filter);
    },
    setAnnotationsVisible(visible) {
      overlays.visible = labelDisplay.visible = visible;
    },
    stage,
    overlays,
    background,
    raster: mask.raster,
    maskStroke: { width: 3, alignment: "center", units: "CSS pixels" },
    setStrokePixelRatio(pixelRatio) {
      if (strokePixelRatio === pixelRatio) return;
      strokePixelRatio = pixelRatio;
      maskOwner.render(mask.frame, mask.texture, strokePixelRatio);
    },
    destroy() {
      overlays.filters = null;
      maskDisplay.removeChildren();
      focusDisplay.removeChildren();
      maskOwner.destroy();
      focus.destroy();
      label.destroy();
      stage.destroy({ children: true, texture: false, textureSource: false });
      mask.texture.destroy(true);
      backgroundSource.destroy(true);
    },
  };
}
