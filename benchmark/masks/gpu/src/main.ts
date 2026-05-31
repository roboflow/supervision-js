import { Application, ImageSource, Sprite, Texture } from "pixi.js";

const fixtureDetectionsPath = "/demo/fixtures/basketball_sam3/detections.json";
const fixtureManifestPath =
  "/demo/fixtures/basketball_sam3/detections.manifest.json";
const sampleFrameCount = 45;
const warmupFrameCount = 5;
const yieldEveryArtifactCount = 2;
const yieldEveryRenderCount = 5;
const thresholds = [0.5, 0.1] as const;
const pngSignature = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const basketballClassStyles: Record<string, { fill: number; stroke: number }> =
  {
    basketball: {
      fill: 0xff7a1a,
      stroke: 0xffa23a,
    },
    "white team player": {
      fill: 0xf8fafc,
      stroke: 0xffffff,
    },
    "yellow team player": {
      fill: 0xfacc15,
      stroke: 0xfde047,
    },
  };

const fallbackClassStyle = {
  fill: 0x38bdf8,
  stroke: 0x7dd3fc,
};

interface DetectionMask {
  readonly counts: string;
  readonly encoding: string;
  readonly height: number;
  readonly width: number;
}

interface Detection {
  readonly className?: string;
  readonly confidence?: number;
  readonly mask?: DetectionMask;
}

interface DetectionFrame {
  readonly detections: readonly Detection[];
  readonly frameIndex: number;
  readonly mediaTime: number;
}

interface FixtureDetections {
  readonly frames: readonly DetectionFrame[];
}

interface FixtureManifest {
  readonly duration: number;
  readonly frameRate: number;
  readonly inference: {
    readonly mask: {
      readonly height: number;
      readonly width: number;
    };
  };
}

interface BenchmarkFrameInput {
  readonly detections: readonly DetectionWithMask[];
  readonly frameIndex: number;
  readonly mediaTime: number;
}

interface DetectionWithMask extends Detection {
  readonly mask: DetectionMask;
}

interface GpuBenchmarkCase {
  readonly artifactBytes: NumberSummary;
  readonly caseName: string;
  readonly confidenceThreshold: number;
  readonly decodeMs: NumberSummary;
  readonly frameCount: number;
  readonly projectedFullFixtureMs: number;
  readonly sampledDetectionCount: number;
  readonly sampledFrameCount: number;
  readonly scope: "browser-gpu";
  readonly textureRenderMs: NumberSummary;
  readonly timingMs: NumberSummary;
}

interface GpuBenchmarkReport {
  readonly benchmark: {
    readonly generatedAt: string;
    readonly name: string;
    readonly sampleFrameCount: number;
    readonly thresholds: readonly number[];
    readonly warmupFrameCount: number;
  };
  readonly cases: readonly GpuBenchmarkCase[];
  readonly environment: {
    readonly gpuFinishSupported: boolean;
    readonly rendererType: string;
    readonly userAgent: string;
  };
  readonly fixture: {
    readonly detectionCount: number;
    readonly durationSeconds: number;
    readonly frameCount: number;
    readonly frameRate: number;
    readonly maskHeight: number;
    readonly maskWidth: number;
  };
}

interface NumberSummary {
  readonly max: number;
  readonly mean: number;
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly total: number;
}

interface DecodedMaskPixels {
  readonly data: Uint8Array;
  readonly height: number;
  readonly width: number;
}

interface RgbaColor {
  readonly alpha: number;
  readonly blue: number;
  readonly green: number;
  readonly red: number;
}

interface RgbaFrame {
  readonly data: Uint8ClampedArray<ArrayBuffer>;
  readonly height: number;
  readonly width: number;
}

interface IdMaskFrame {
  readonly data: Uint8Array;
  readonly height: number;
  readonly width: number;
}

interface MaskInstruction {
  readonly alpha: number;
  readonly color: number;
  readonly mask: DetectionMask;
  readonly stroke?: {
    readonly alpha: number;
    readonly color: number;
    readonly width: number;
  };
}

interface BitmapArtifact {
  readonly artifactBytes: number;
  readonly bitmap: ImageBitmap;
  readonly height: number;
  readonly width: number;
}

interface PngArtifact {
  readonly artifactBytes: number;
  readonly blob: Blob;
  readonly height: number;
  readonly width: number;
}

interface RenderResource {
  readonly decodeMs: number;
  readonly height: number;
  readonly resource: ImageBitmap;
  readonly width: number;
  close(): void;
}

declare global {
  interface Window {
    __SUPERVISION_MASK_GPU_BENCHMARK_RESULT__?: GpuBenchmarkReport;
  }
}

const statusElement = requireElement<HTMLParagraphElement>("#status");
const outputElement = requireElement<HTMLPreElement>("#output");
const stageElement = requireElement<HTMLDivElement>("#stage");

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);

  setStatus(`Benchmark failed: ${message}`);
  throw error;
});

async function run() {
  setStatus("Loading fixture...");

  const [fixture, manifest] = await Promise.all([
    fetchJson<FixtureDetections>(fixtureDetectionsPath),
    fetchJson<FixtureManifest>(fixtureManifestPath),
  ]);
  const app = new Application();

  await app.init({
    antialias: false,
    autoStart: false,
    backgroundColor: 0x05070a,
    height: manifest.inference.mask.height,
    preference: "webgl",
    resolution: 1,
    width: manifest.inference.mask.width,
  });
  app.stop();

  const sprite = new Sprite({ texture: Texture.EMPTY });

  sprite.width = manifest.inference.mask.width;
  sprite.height = manifest.inference.mask.height;
  app.stage.addChild(sprite);
  stageElement.appendChild(app.canvas);
  app.render();

  const cases: GpuBenchmarkCase[] = [];
  const gpuFinishSupported = forceGpuFinish(app.renderer);

  for (const confidenceThreshold of thresholds) {
    const frameInputs = createBenchmarkFrameInputs(fixture.frames, {
      confidenceThreshold,
    });
    const sampledInputs = selectEvenlySpaced(frameInputs, sampleFrameCount);
    const warmupInputs = sampledInputs.slice(0, warmupFrameCount);

    setStatus(`Preparing RGBA fill artifacts at ${confidenceThreshold}...`);
    cases.push(
      await benchmarkBitmapUploadCase({
        app,
        artifactFactory: (input) =>
          createRgbaBitmapArtifact(input, { includeStroke: false }),
        caseName: "pixi-rgba-fill-imagebitmap-upload-render",
        confidenceThreshold,
        frameInputs,
        sampledInputs,
        sprite,
        warmupInputs,
      }),
    );

    setStatus(`Preparing RGBA border artifacts at ${confidenceThreshold}...`);
    cases.push(
      await benchmarkBitmapUploadCase({
        app,
        artifactFactory: (input) =>
          createRgbaBitmapArtifact(input, { includeStroke: true }),
        caseName: "pixi-rgba-fill-border-imagebitmap-upload-render",
        confidenceThreshold,
        frameInputs,
        sampledInputs,
        sprite,
        warmupInputs,
      }),
    );

    setStatus(`Preparing PNG ID-mask artifacts at ${confidenceThreshold}...`);
    cases.push(
      await benchmarkPngDecodeUploadCase({
        app,
        artifactFactory: createPngIdMaskArtifact,
        caseName: "pixi-png-id-mask-decode-upload-render",
        confidenceThreshold,
        frameInputs,
        sampledInputs,
        sprite,
        warmupInputs,
      }),
    );
  }

  const report: GpuBenchmarkReport = {
    benchmark: {
      generatedAt: new Date().toISOString(),
      name: "basketball-sam3-mask-gpu-artifacts",
      sampleFrameCount,
      thresholds,
      warmupFrameCount,
    },
    cases,
    environment: {
      gpuFinishSupported,
      rendererType: app.renderer.name,
      userAgent: navigator.userAgent,
    },
    fixture: {
      detectionCount: fixture.frames.reduce(
        (count, frame) => count + frame.detections.length,
        0,
      ),
      durationSeconds: manifest.duration,
      frameCount: fixture.frames.length,
      frameRate: manifest.frameRate,
      maskHeight: manifest.inference.mask.height,
      maskWidth: manifest.inference.mask.width,
    },
  };

  window.__SUPERVISION_MASK_GPU_BENCHMARK_RESULT__ = report;
  outputElement.textContent = JSON.stringify(report, null, 2);
  setStatus("Benchmark complete.");
  app.destroy({ removeView: true }, true);
}

async function benchmarkBitmapUploadCase(options: {
  readonly app: Application;
  readonly artifactFactory: (
    input: BenchmarkFrameInput,
  ) => Promise<BitmapArtifact>;
  readonly caseName: string;
  readonly confidenceThreshold: number;
  readonly frameInputs: readonly BenchmarkFrameInput[];
  readonly sampledInputs: readonly BenchmarkFrameInput[];
  readonly sprite: Sprite;
  readonly warmupInputs: readonly BenchmarkFrameInput[];
}): Promise<GpuBenchmarkCase> {
  const warmupArtifacts = await prepareArtifacts(
    options.warmupInputs,
    options.artifactFactory,
  );

  for (const artifact of warmupArtifacts) {
    renderImageBitmapArtifact(options.app, options.sprite, artifact);
    artifact.bitmap.close();
    await yieldToBrowser();
  }

  const sampledArtifacts = await prepareArtifacts(
    options.sampledInputs,
    options.artifactFactory,
  );

  return await runUploadBenchmark({
    app: options.app,
    artifactBytes: sampledArtifacts.map((artifact) => artifact.artifactBytes),
    caseName: options.caseName,
    confidenceThreshold: options.confidenceThreshold,
    frameInputs: options.frameInputs,
    sampledDetectionCount: options.sampledInputs.reduce(
      (count, input) => count + input.detections.length,
      0,
    ),
    sampledFrameCount: options.sampledInputs.length,
    sprite: options.sprite,
    resources: sampledArtifacts.map((artifact) => ({
      close() {
        artifact.bitmap.close();
      },
      decodeMs: 0,
      height: artifact.height,
      resource: artifact.bitmap,
      width: artifact.width,
    })),
  });
}

async function benchmarkPngDecodeUploadCase(options: {
  readonly app: Application;
  readonly artifactFactory: (
    input: BenchmarkFrameInput,
  ) => Promise<PngArtifact>;
  readonly caseName: string;
  readonly confidenceThreshold: number;
  readonly frameInputs: readonly BenchmarkFrameInput[];
  readonly sampledInputs: readonly BenchmarkFrameInput[];
  readonly sprite: Sprite;
  readonly warmupInputs: readonly BenchmarkFrameInput[];
}): Promise<GpuBenchmarkCase> {
  const warmupArtifacts = await prepareArtifacts(
    options.warmupInputs,
    options.artifactFactory,
  );

  for (const artifact of warmupArtifacts) {
    const resource = await decodePngArtifact(artifact);

    renderResource(options.app, options.sprite, resource);
    resource.close();
    await yieldToBrowser();
  }

  const sampledArtifacts = await prepareArtifacts(
    options.sampledInputs,
    options.artifactFactory,
  );
  const resources: RenderResource[] = [];

  for (let index = 0; index < sampledArtifacts.length; index += 1) {
    const artifact = sampledArtifacts[index];

    if (!artifact) {
      continue;
    }

    resources.push(await decodePngArtifact(artifact));

    if (index % yieldEveryArtifactCount === 0) {
      await yieldToBrowser();
    }
  }

  return await runUploadBenchmark({
    app: options.app,
    artifactBytes: sampledArtifacts.map((artifact) => artifact.artifactBytes),
    caseName: options.caseName,
    confidenceThreshold: options.confidenceThreshold,
    frameInputs: options.frameInputs,
    sampledDetectionCount: options.sampledInputs.reduce(
      (count, input) => count + input.detections.length,
      0,
    ),
    sampledFrameCount: options.sampledInputs.length,
    sprite: options.sprite,
    resources,
  });
}

async function runUploadBenchmark(options: {
  readonly app: Application;
  readonly artifactBytes: readonly number[];
  readonly caseName: string;
  readonly confidenceThreshold: number;
  readonly frameInputs: readonly BenchmarkFrameInput[];
  readonly sampledDetectionCount: number;
  readonly sampledFrameCount: number;
  readonly sprite: Sprite;
  readonly resources: readonly RenderResource[];
}): Promise<GpuBenchmarkCase> {
  const totalDurationsMs: number[] = [];
  const decodeDurationsMs: number[] = [];
  const textureRenderDurationsMs: number[] = [];

  for (let index = 0; index < options.resources.length; index += 1) {
    const resource = options.resources[index];

    if (!resource) {
      continue;
    }

    const renderStart = performance.now();

    renderResource(options.app, options.sprite, resource);

    const end = performance.now();
    const textureRenderMs = end - renderStart;

    totalDurationsMs.push(resource.decodeMs + textureRenderMs);
    decodeDurationsMs.push(resource.decodeMs);
    textureRenderDurationsMs.push(textureRenderMs);
    resource.close();

    if (index % yieldEveryRenderCount === 0) {
      await yieldToBrowser();
    }
  }

  const timing = summarizeNumbers(totalDurationsMs);
  const frameScale =
    options.frameInputs.length / Math.max(options.sampledFrameCount, 1);

  return {
    artifactBytes: {
      ...summarizeNumbers(options.artifactBytes),
      total: options.artifactBytes.reduce((sum, value) => sum + value, 0),
    },
    caseName: options.caseName,
    confidenceThreshold: options.confidenceThreshold,
    decodeMs: summarizeNumbers(decodeDurationsMs),
    frameCount: options.frameInputs.length,
    projectedFullFixtureMs: timing.total * frameScale,
    sampledDetectionCount: options.sampledDetectionCount,
    sampledFrameCount: options.sampledFrameCount,
    scope: "browser-gpu",
    textureRenderMs: summarizeNumbers(textureRenderDurationsMs),
    timingMs: timing,
  };
}

async function prepareArtifacts<Artifact>(
  inputs: readonly BenchmarkFrameInput[],
  artifactFactory: (input: BenchmarkFrameInput) => Promise<Artifact>,
) {
  const artifacts: Artifact[] = [];

  for (let index = 0; index < inputs.length; index += 1) {
    const input = inputs[index];

    if (!input) {
      continue;
    }

    artifacts.push(await artifactFactory(input));

    if (index % yieldEveryArtifactCount === 0) {
      await yieldToBrowser();
    }
  }

  return artifacts;
}

async function yieldToBrowser() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function renderImageBitmapArtifact(
  app: Application,
  sprite: Sprite,
  artifact: BitmapArtifact,
) {
  renderResource(app, sprite, {
    close() {},
    decodeMs: 0,
    height: artifact.height,
    resource: artifact.bitmap,
    width: artifact.width,
  });
}

function renderResource(
  app: Application,
  sprite: Sprite,
  resource: RenderResource,
) {
  const texture = new Texture({
    dynamic: false,
    source: new ImageSource({
      dynamic: false,
      height: resource.height,
      resource: resource.resource,
      width: resource.width,
    }),
  });

  sprite.texture = texture;
  sprite.width = resource.width;
  sprite.height = resource.height;
  app.render();
  forceGpuFinish(app.renderer);
  sprite.texture = Texture.EMPTY;
  texture.destroy(true);
}

async function createRgbaBitmapArtifact(
  input: BenchmarkFrameInput,
  options: { readonly includeStroke: boolean },
): Promise<BitmapArtifact> {
  const frame = compositeMaskFrame(
    createMaskInstructions(input, {
      includeStroke: options.includeStroke,
    }),
  );

  if (!frame) {
    throw new Error("Expected sampled frame to contain at least one mask.");
  }

  return {
    artifactBytes: frame.data.byteLength,
    bitmap: await createImageBitmap(
      new ImageData(frame.data, frame.width, frame.height),
    ),
    height: frame.height,
    width: frame.width,
  };
}

async function createPngIdMaskArtifact(
  input: BenchmarkFrameInput,
): Promise<PngArtifact> {
  const frame = buildIdMaskFrame(input);

  if (!frame) {
    throw new Error("Expected sampled frame to contain at least one mask.");
  }

  const png = await encodeGrayscalePng({
    height: frame.height,
    pixels: frame.data,
    width: frame.width,
  });
  const blob = new Blob([png], { type: "image/png" });

  return {
    artifactBytes: blob.size,
    blob,
    height: frame.height,
    width: frame.width,
  };
}

async function decodePngArtifact(
  artifact: PngArtifact,
): Promise<RenderResource> {
  const start = performance.now();
  const bitmap = await createImageBitmap(artifact.blob);
  const decodeMs = performance.now() - start;

  return {
    close() {
      bitmap.close();
    },
    decodeMs,
    height: artifact.height,
    resource: bitmap,
    width: artifact.width,
  };
}

function createBenchmarkFrameInputs(
  frames: readonly DetectionFrame[],
  options: { readonly confidenceThreshold: number },
): BenchmarkFrameInput[] {
  return frames
    .map((frame) => ({
      detections: frame.detections.filter(
        (detection): detection is DetectionWithMask =>
          Boolean(detection.mask) &&
          (detection.confidence ?? 1) >= options.confidenceThreshold,
      ),
      frameIndex: frame.frameIndex,
      mediaTime: frame.mediaTime,
    }))
    .filter((frame) => frame.detections.length > 0);
}

function createMaskInstructions(
  frameInput: BenchmarkFrameInput,
  options: { readonly includeStroke: boolean },
): MaskInstruction[] {
  return frameInput.detections.map((detection) => {
    const style = resolveClassStyle(detection.className);

    return {
      alpha: 0.3,
      color: style.fill,
      mask: detection.mask,
      stroke: options.includeStroke
        ? {
            alpha: 1,
            color: style.stroke,
            width: 1,
          }
        : undefined,
    };
  });
}

function resolveClassStyle(className: string | undefined) {
  return className
    ? (basketballClassStyles[className] ?? fallbackClassStyle)
    : fallbackClassStyle;
}

function buildIdMaskFrame(
  frameInput: BenchmarkFrameInput,
): IdMaskFrame | undefined {
  if (frameInput.detections.length === 0) {
    return undefined;
  }

  if (frameInput.detections.length > 255) {
    throw new Error("PNG ID-mask GPU benchmark only supports 8-bit masks.");
  }

  const width = Math.max(
    ...frameInput.detections.map((detection) => detection.mask.width),
  );
  const height = Math.max(
    ...frameInput.detections.map((detection) => detection.mask.height),
  );
  const data = new Uint8Array(width * height);

  for (const [index, detection] of frameInput.detections.entries()) {
    const decodedMask = decodeCompressedRleMask(detection.mask);
    const id = index + 1;

    for (let offset = 0; offset < decodedMask.data.length; offset += 1) {
      if (decodedMask.data[offset]) {
        data[offset] = id;
      }
    }
  }

  return {
    data,
    height,
    width,
  };
}

function compositeMaskFrame(
  instructions: readonly MaskInstruction[],
): RgbaFrame | undefined {
  if (instructions.length === 0) {
    return undefined;
  }

  const width = Math.max(...instructions.map(({ mask }) => mask.width));
  const height = Math.max(...instructions.map(({ mask }) => mask.height));
  const data = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));

  for (const instruction of instructions) {
    compositeInstruction(data, width, instruction);
  }

  return { data, height, width };
}

function compositeInstruction(
  rgba: Uint8ClampedArray,
  canvasWidth: number,
  instruction: MaskInstruction,
) {
  const decodedMask = decodeCompressedRleMask(instruction.mask);
  const fill = resolveRgbaColor(instruction.color, instruction.alpha);

  compositeMaskFill(rgba, canvasWidth, decodedMask, fill);

  if (instruction.stroke) {
    compositeMaskStroke(rgba, canvasWidth, decodedMask, instruction.stroke);
  }
}

function compositeMaskFill(
  rgba: Uint8ClampedArray,
  canvasWidth: number,
  decodedMask: DecodedMaskPixels,
  fill: RgbaColor,
) {
  for (let y = 0; y < decodedMask.height; y += 1) {
    for (let x = 0; x < decodedMask.width; x += 1) {
      const maskOffset = y * decodedMask.width + x;

      if (!decodedMask.data[maskOffset]) {
        continue;
      }

      writePixel(rgba, canvasWidth, x, y, fill);
    }
  }
}

function compositeMaskStroke(
  rgba: Uint8ClampedArray,
  canvasWidth: number,
  decodedMask: DecodedMaskPixels,
  stroke: NonNullable<MaskInstruction["stroke"]>,
) {
  const width = Math.round(stroke.width);

  if (width <= 0) {
    return;
  }

  const strokeColor = resolveRgbaColor(stroke.color, stroke.alpha);

  for (let y = 0; y < decodedMask.height; y += 1) {
    for (let x = 0; x < decodedMask.width; x += 1) {
      if (
        !isMaskPixel(decodedMask, x, y) ||
        !isBoundaryPixel(decodedMask, x, y)
      ) {
        continue;
      }

      for (let offsetY = -width; offsetY <= width; offsetY += 1) {
        for (let offsetX = -width; offsetX <= width; offsetX += 1) {
          const strokeX = x + offsetX;
          const strokeY = y + offsetY;

          if (
            isOutsideMaskBounds(decodedMask, strokeX, strokeY) ||
            isMaskPixel(decodedMask, strokeX, strokeY)
          ) {
            continue;
          }

          writePixel(rgba, canvasWidth, strokeX, strokeY, strokeColor);
        }
      }
    }
  }
}

function decodeCompressedRleMask(mask: DetectionMask): DecodedMaskPixels {
  if (mask.encoding !== "compressedRle") {
    throw new Error(`Unsupported detection mask encoding: ${mask.encoding}`);
  }

  const data = new Uint8Array(mask.width * mask.height);
  const counts = decodeCompressedRleCounts(mask.counts);
  let offset = 0;

  for (let index = 0; index < counts.length; index += 1) {
    const runLength = counts[index] ?? 0;
    const isForeground = index % 2 === 1;

    if (isForeground) {
      for (let runOffset = 0; runOffset < runLength; runOffset += 1) {
        const maskOffset = offset + runOffset;
        const x = Math.floor(maskOffset / mask.height);
        const y = maskOffset % mask.height;
        const rowMajorOffset = y * mask.width + x;

        if (rowMajorOffset < data.length) {
          data[rowMajorOffset] = 1;
        }
      }
    }

    offset += runLength;
  }

  return {
    data,
    height: mask.height,
    width: mask.width,
  };
}

function decodeCompressedRleCounts(counts: string): number[] {
  const decoded: number[] = [];
  let index = 0;

  while (index < counts.length) {
    let value = 0;
    let shift = 0;
    let charCode: number;

    do {
      charCode = counts.charCodeAt(index) - 48;
      index += 1;
      value |= (charCode & 0x1f) << shift;
      shift += 5;
    } while (charCode & 0x20);

    if (charCode & 0x10) {
      value |= -1 << shift;
    }

    if (decoded.length > 2) {
      value += decoded[decoded.length - 2] ?? 0;
    }

    decoded.push(value);
  }

  return decoded;
}

async function encodeGrayscalePng(options: {
  readonly height: number;
  readonly pixels: Uint8Array;
  readonly width: number;
}): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof CompressionStream === "undefined") {
    throw new Error("CompressionStream is required for the PNG GPU benchmark.");
  }

  const rawScanlines = createFilterlessPngScanlines(options);
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);

  ihdrView.setUint32(0, options.width);
  ihdrView.setUint32(4, options.height);
  ihdr[8] = 8;
  ihdr[9] = 0;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const compressed = new Uint8Array(
    await new Response(
      new Blob([rawScanlines])
        .stream()
        .pipeThrough(new CompressionStream("deflate")),
    ).arrayBuffer(),
  );

  return concatUint8Arrays([
    pngSignature,
    createPngChunk("IHDR", ihdr),
    createPngChunk("IDAT", compressed),
    createPngChunk("IEND", new Uint8Array(0)),
  ]);
}

function createFilterlessPngScanlines(options: {
  readonly height: number;
  readonly pixels: Uint8Array;
  readonly width: number;
}) {
  const rowStride = options.width + 1;
  const scanlines = new Uint8Array(rowStride * options.height);

  for (let y = 0; y < options.height; y += 1) {
    const sourceOffset = y * options.width;
    const targetOffset = y * rowStride;

    scanlines[targetOffset] = 0;
    scanlines.set(
      options.pixels.subarray(sourceOffset, sourceOffset + options.width),
      targetOffset + 1,
    );
  }

  return scanlines;
}

function createPngChunk(type: string, data: Uint8Array) {
  const typeBytes = new TextEncoder().encode(type);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);

  view.setUint32(0, data.length);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(concatUint8Arrays([typeBytes, data])));

  return chunk;
}

const crc32Table = createCrc32Table();

function createCrc32Table() {
  const table = new Uint32Array(256);

  for (let i = 0; i < table.length; i += 1) {
    let value = i;

    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }

    table[i] = value >>> 0;
  }

  return table;
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;

  for (const byte of bytes) {
    crc = crc32Table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function concatUint8Arrays(
  chunks: readonly Uint8Array[],
): Uint8Array<ArrayBuffer> {
  const totalLength = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

function isBoundaryPixel(mask: DecodedMaskPixels, x: number, y: number) {
  for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      if (offsetX === 0 && offsetY === 0) {
        continue;
      }

      const neighborX = x + offsetX;
      const neighborY = y + offsetY;

      if (
        isOutsideMaskBounds(mask, neighborX, neighborY) ||
        !isMaskPixel(mask, neighborX, neighborY)
      ) {
        return true;
      }
    }
  }

  return false;
}

function isMaskPixel(mask: DecodedMaskPixels, x: number, y: number) {
  return mask.data[y * mask.width + x] === 1;
}

function isOutsideMaskBounds(mask: DecodedMaskPixels, x: number, y: number) {
  return x < 0 || y < 0 || x >= mask.width || y >= mask.height;
}

function resolveRgbaColor(color: number, alpha: number): RgbaColor {
  return {
    alpha: Math.round(Math.max(0, Math.min(alpha, 1)) * 255),
    blue: color & 0xff,
    green: (color >> 8) & 0xff,
    red: (color >> 16) & 0xff,
  };
}

function writePixel(
  rgba: Uint8ClampedArray,
  canvasWidth: number,
  x: number,
  y: number,
  color: RgbaColor,
) {
  const rgbaOffset = (y * canvasWidth + x) * 4;

  rgba[rgbaOffset] = color.red;
  rgba[rgbaOffset + 1] = color.green;
  rgba[rgbaOffset + 2] = color.blue;
  rgba[rgbaOffset + 3] = color.alpha;
}

function selectEvenlySpaced<T>(items: readonly T[], count: number): T[] {
  if (count >= items.length) {
    return [...items];
  }

  if (count <= 1) {
    return items.slice(0, 1);
  }

  const selected: T[] = [];
  const seenIndexes = new Set<number>();

  for (let i = 0; i < count; i += 1) {
    const index = Math.round((i * (items.length - 1)) / (count - 1));

    if (!seenIndexes.has(index)) {
      const item = items[index];

      if (item !== undefined) {
        selected.push(item);
      }

      seenIndexes.add(index);
    }
  }

  return selected;
}

function summarizeNumbers(values: readonly number[]): NumberSummary {
  if (values.length === 0) {
    return {
      max: 0,
      mean: 0,
      min: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      total: 0,
    };
  }

  const sorted = [...values].sort((left, right) => left - right);
  const total = values.reduce((sum, value) => sum + value, 0);

  return {
    max: sorted[sorted.length - 1] ?? 0,
    mean: total / values.length,
    min: sorted[0] ?? 0,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    total,
  };
}

function percentile(sortedValues: readonly number[], quantile: number) {
  if (sortedValues.length === 0) {
    return 0;
  }

  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(sortedValues.length * quantile) - 1),
  );

  return sortedValues[index] ?? 0;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Unable to load ${url}: ${response.status}`);
  }

  return (await response.json()) as T;
}

function forceGpuFinish(renderer: unknown) {
  const gl = resolveWebGlContext(renderer);

  gl?.finish();

  return Boolean(gl);
}

function resolveWebGlContext(renderer: unknown): WebGL2RenderingContext | null {
  if (!isRecord(renderer)) {
    return null;
  }

  const directGl = renderer.gl;

  if (isWebGl2RenderingContext(directGl)) {
    return directGl;
  }

  const context = renderer.context;

  if (isRecord(context) && isWebGl2RenderingContext(context.gl)) {
    return context.gl;
  }

  const canvas = renderer.canvas;

  if (canvas instanceof HTMLCanvasElement) {
    return canvas.getContext("webgl2");
  }

  return null;
}

function isWebGl2RenderingContext(
  value: unknown,
): value is WebGL2RenderingContext {
  return (
    typeof WebGL2RenderingContext !== "undefined" &&
    value instanceof WebGL2RenderingContext
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function setStatus(message: string) {
  statusElement.textContent = message;
}

function requireElement<ElementType extends Element>(selector: string) {
  const element = document.querySelector<ElementType>(selector);

  if (!element) {
    throw new Error(`Mask GPU benchmark DOM is missing ${selector}.`);
  }

  return element;
}
