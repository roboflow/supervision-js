import {
  Application,
  BufferImageSource,
  Graphics,
  ImageSource,
  Mesh,
  MeshGeometry,
  Rectangle,
  Shader,
  Texture,
  UniformGroup,
} from "pixi.js";
import {
  BaseMaskStyle,
  MaskRenderMode,
  resolveMaskStyleOpacity,
  encodeBinaryMask,
  pickDetectionAtPoint,
  StrokeAlignment,
  type DetectionFrame,
  type MaskDrawInstruction,
} from "supervision-js-core";
import {
  createPackedMaskCoverage,
  readPackedMaskCoverage,
} from "../../packages/web/src/render-preparation/packed-mask-coverage";
import { createPackedMaskPaint } from "../../packages/web/src/renderers/packed-mask-paint";
import { createPixiIdMaskShaderRenderer } from "../../packages/web/src/renderers/pixi-id-mask-shader";

const opacityMode =
  new URLSearchParams(location.search).get("opacity") === "mesh"
    ? "mesh"
    : "paint";
const coverageMode =
  new URLSearchParams(location.search).get("coverage") === "dense"
    ? "dense"
    : "packed";
const requested =
  new URLSearchParams(location.search).get("backend") === "webgpu"
    ? "webgpu"
    : "webgl";
const app = new Application();
await app.init({
  width: 256,
  height: 256,
  resolution: 1,
  preference: requested,
  autoStart: false,
  antialias: false,
});
document.querySelector("#canvas")!.appendChild(app.canvas);
app.stage.sortableChildren = true;
const background = new Graphics().rect(0, 0, 256, 256).fill(0xffffff);
background.zIndex = -10;
app.stage.addChild(background);

const redMask = encodeBinaryMask(
  Uint8Array.from({ length: 64 * 64 }, (_, index) =>
    Number(
      index % 64 >= 8 &&
        index % 64 < 56 &&
        Math.floor(index / 64) >= 8 &&
        Math.floor(index / 64) < 56,
    ),
  ),
  64,
  64,
);
const greenMask = encodeBinaryMask(
  Uint8Array.from({ length: 64 * 64 }, (_, index) => {
    const x = index % 64;
    const y = Math.floor(index / 64);
    return Number(
      x >= 20 &&
        x < 60 &&
        y >= 20 &&
        y < 60 &&
        !(x >= 30 && x < 36 && y >= 30 && y < 36),
    );
  }),
  64,
  64,
);
const detections: DetectionFrame["detections"] = [
  { id: "red", zIndex: 0, mask: redMask },
  {
    id: "blue",
    zIndex: 1,
    polygon: {
      points: [
        { x: 16, y: 16 },
        { x: 48, y: 16 },
        { x: 48, y: 48 },
        { x: 16, y: 48 },
      ],
    },
  },
  { id: "green", zIndex: 2, mask: greenMask },
];
let coveragePreparations = 0;
function prepareCoverage(mask: MaskDrawInstruction["mask"], index: number) {
  coveragePreparations += 1;
  return createPackedMaskCoverage(mask, index)!;
}
const redCoverage = prepareCoverage(redMask, 0);
const greenCoverage = prepareCoverage(greenMask, 2);
let textureAllocations = 0;
let shaderAllocations = 0;
let styleOpacity = 0.5;
let styleTime = 0;
function styles() {
  return [
    new BaseMaskStyle({
      opacity: styleOpacity,
      color: 0xff0000,
      mode: MaskRenderMode.FillOnly,
      fillAlpha: (_, { mediaTime }) => (mediaTime % 2 === 0 ? 0.5 : 0.25),
    }),
    new BaseMaskStyle({
      opacity: styleOpacity,
      color: 0x00ff00,
      fillAlpha: (_, { mediaTime }) => (mediaTime % 2 === 0 ? 0.5 : 0.25),
      stroke: {
        width: 4,
        widthUnit: "screen",
        color: 0,
        alpha: 1,
        alignment: StrokeAlignment.Inside,
      },
    }),
  ];
}
let instructions: MaskDrawInstruction[] = styles().map((style, index) =>
  style.resolve(detections[index * 2]!, {
    detectionIndex: index * 2,
    frame: { detections, mediaTime: styleTime },
    mediaTime: styleTime,
  })!,
);

const units = [redCoverage, greenCoverage].map((coverage, index) => {
  const textureWidth =
    coverageMode === "dense"
      ? Math.ceil(coverage.width / 4) * 4
      : coverage.textureWidth;
  const textureData =
    coverageMode === "dense"
      ? new Uint8Array(textureWidth * coverage.height)
      : coverage.data;
  if (coverageMode === "dense") {
    for (let y = 0; y < coverage.height; y += 1) {
      for (let x = 0; x < coverage.width; x += 1) {
        textureData[y * textureWidth + x] = Number(
          readPackedMaskCoverage(coverage, coverage.x + x, coverage.y + y),
        );
      }
    }
  }
  textureAllocations += 1;
  const texture = new Texture({
    source: new BufferImageSource({
      resource: textureData,
      width: textureWidth,
      height: coverage.height,
      format: "r8unorm",
      scaleMode: "nearest",
      autoGenerateMipmaps: false,
    }),
  });
  const renderer = createPixiIdMaskShaderRenderer({
    ImageSource,
    Mesh,
    MeshGeometry,
    Shader: {
      from: (descriptor) => {
        shaderAllocations += 1;
        return Shader.from(descriptor);
      },
    },
    UniformGroup,
    mediaWidth: 1,
    mediaHeight: 1,
    packedCoverage: coverageMode === "packed",
  });
  const paint = createPackedMaskPaint(
    coverage,
    instructions[index]!,
    256,
    1,
    opacityMode === "paint" ? resolveMaskStyleOpacity(styles()[index]!) : 1,
  );
  renderer.mesh.position.set(coverage.x * 4, coverage.y * 4);
  renderer.mesh.scale.set(coverage.width * 4, coverage.height * 4);
  renderer.mesh.zIndex = index * 2;
  renderer.setOpacity(opacityMode === "mesh" ? styleOpacity : 1);
  renderer.render(paint, texture, 1);
  app.stage.addChild(renderer.mesh);
  return { coverage, texture, textureData, renderer, paint };
});
const polygon = new Graphics()
  .rect(64, 64, 128, 128)
  .fill({ color: 0x0000ff, alpha: 0.5 });
polygon.zIndex = 1;
app.stage.addChild(polygon);
let reversed = false;

function over(rgb: number[], color: readonly number[], alpha: number) {
  return rgb.map(
    (channel, index) => channel * (1 - alpha) + color[index]! * alpha,
  );
}

function run() {
  const currentStyles = styles();
  instructions = currentStyles.map((style, index) =>
    style.resolve(detections[index * 2]!, {
      detectionIndex: index * 2,
      frame: { detections, mediaTime: styleTime },
      mediaTime: styleTime,
    })!,
  );
  units.forEach((unit, index) => {
    const opacity = resolveMaskStyleOpacity(currentStyles[index]!);
    unit.paint = createPackedMaskPaint(
      unit.coverage,
      instructions[index]!,
      256,
      1,
      opacityMode === "paint" ? opacity : 1,
    );
    unit.renderer.setOpacity(opacityMode === "mesh" ? opacity : 1);
    unit.renderer.render(unit.paint, unit.texture, 1);
  });
  units[0]!.renderer.mesh.zIndex = reversed ? 2 : 0;
  units[1]!.renderer.mesh.zIndex = reversed ? 0 : 2;
  const frame: DetectionFrame = {
    mediaTime: 0,
    detections: detections.map((detection, index) => ({
      ...detection,
      zIndex: index === 1 ? 1 : reversed ? 2 - index : index,
    })),
  };
  app.render();
  const extracted = app.renderer.extract.pixels({
    target: app.stage,
    frame: new Rectangle(0, 0, 256, 256),
    resolution: 1,
  });
  const samples = [
    { name: "background", px: 4, py: 4, greenStroke: false },
    { name: "red fill", px: 40, py: 40, greenStroke: false },
    { name: "both masks and polygon", px: 96, py: 96, greenStroke: false },
    { name: "green hole", px: 128, py: 128, greenStroke: false },
    { name: "green fill", px: 232, py: 232, greenStroke: false },
    { name: "green outline over red", px: 81, py: 221, greenStroke: true },
  ].map(({ name, px, py, greenStroke }) => {
    const point = { x: (px + 0.5) / 4, y: (py + 0.5) / 4 };
    let expected = [255, 255, 255];
    for (const index of reversed ? [2, 1, 0] : [0, 1, 2]) {
      if (index === 0 && readPackedMaskCoverage(redCoverage, point.x, point.y))
        expected = over(
          expected,
          [255, 0, 0],
          instructions[0]!.alpha * styleOpacity,
        );
      if (
        index === 1 &&
        point.x >= 16 &&
        point.x < 48 &&
        point.y >= 16 &&
        point.y < 48
      )
        expected = over(expected, [0, 0, 255], 0.5);
      if (
        index === 2 &&
        readPackedMaskCoverage(greenCoverage, point.x, point.y)
      )
        expected = over(
          expected,
          greenStroke ? [0, 0, 0] : [0, 255, 0],
          (greenStroke
            ? instructions[1]!.stroke!.alpha
            : instructions[1]!.alpha) * styleOpacity,
        );
    }
    const start = (py * extracted.width + px) * 4;
    const actual = [...extracted.pixels.slice(start, start + 3)];
    return {
      name,
      actual,
      expected: expected.map(Math.round),
      error: Math.max(
        ...actual.map((channel, index) => Math.abs(channel - expected[index]!)),
      ),
      picked:
        pickDetectionAtPoint(frame, point, {
          preferTopmost: true,
          maskOrder: "detection",
          maskMediaDimensions: { width: 64, height: 64 },
        })?.detection.id ?? null,
    };
  });
  const result = {
    requestedBackend: requested,
    coverageMode,
    opacityMode,
    styleOpacity,
    styleTime,
    coveragePreparations,
    texturesCreated: textureAllocations,
    shaderInstancesCreated: shaderAllocations,
    actualBackend: app.renderer.name,
    reversed,
    passed: samples.every(({ error }) => error <= 2),
    samples,
    packedCpuBytes: units.reduce(
      (total, { coverage }) => total + coverage.data.byteLength,
      0,
    ),
    textureBytes: units.reduce(
      (total, { textureData }) => total + textureData.byteLength,
      0,
    ),
    paintCpuBytes: units.reduce(
      (total, { paint }) =>
        total +
        paint.fillPalette.byteLength +
        paint.strokePalette.byteLength +
        paint.strokeWidths.byteLength +
        (paint.strokeAlignments?.byteLength ?? 0),
      0,
    ),
  };
  (window as Window & { __maskOrderProof?: unknown }).__maskOrderProof = result;
  document.querySelector("#result")!.textContent = JSON.stringify(
    result,
    null,
    2,
  );
  return result;
}
document.querySelector("#reverse")!.addEventListener("click", () => {
  reversed = !reversed;
  run();
});
run();

document.querySelector("#opacity")!.addEventListener("click", () => {
  styleOpacity = styleOpacity === 0.5 ? 0.25 : 0.5;
  run();
});
document.querySelector("#time")!.addEventListener("click", () => {
  styleTime += 1;
  run();
});
