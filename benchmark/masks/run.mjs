#!/usr/bin/env node
/* global Buffer, process, setTimeout */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const fixtureDir = path.join(rootDir, "demo/fixtures/basketball_sam3");
const defaultOutputDir = path.join(rootDir, "benchmark/masks/results");
const defaultSampleFrameCount = 45;
const defaultWarmupFrameCount = 5;
const defaultThresholds = [0.5, 0.1];
const defaultPreparedWindowSeconds = 5;
const pngCompressionLevels = [1, 6];
const bytesPerRgbaPixel = 4;
const bytesPerId8Pixel = 1;
const bytesPerId16Pixel = 2;
const pngSignature = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const basketballClassStyles = {
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const fixture = await loadFixture();
  const sourceBytes = await measureSourceBytes(fixture.manifest);
  const staticStats = summarizeFixture(fixture, sourceBytes);
  const cases = [];

  for (const confidenceThreshold of options.thresholds) {
    const frameInputs = createBenchmarkFrameInputs(fixture.frames, {
      confidenceThreshold,
    });
    const sampledInputs = selectEvenlySpaced(
      frameInputs,
      options.sampleFrameCount,
    );
    const warmupInputs = sampledInputs.slice(0, options.warmupFrameCount);

    cases.push(
      await benchmarkCase({
        caseName: `rgba-fill-threshold-${confidenceThreshold}`,
        fixture,
        frameInputs,
        run(input) {
          return compositeMaskFrame(
            createMaskInstructions(input, {
              includeStroke: false,
            }),
          );
        },
        sampledInputs,
        warmupInputs,
      }),
    );
    cases.push(
      await benchmarkCase({
        caseName: `rgba-fill-stroke-threshold-${confidenceThreshold}`,
        fixture,
        frameInputs,
        run(input) {
          return compositeMaskFrame(
            createMaskInstructions(input, {
              includeStroke: true,
            }),
          );
        },
        sampledInputs,
        warmupInputs,
      }),
    );
    cases.push(
      await benchmarkCase({
        caseName: `id-mask-threshold-${confidenceThreshold}`,
        fixture,
        frameInputs,
        run(input) {
          return buildIdMaskFrame(input);
        },
        sampledInputs,
        warmupInputs,
      }),
    );

    for (const compressionLevel of pngCompressionLevels) {
      cases.push(
        await benchmarkCase({
          caseName: `id-mask-png-level-${compressionLevel}-threshold-${confidenceThreshold}`,
          fixture,
          frameInputs,
          run(input) {
            return buildIdMaskPngFrame(input, { compressionLevel });
          },
          sampledInputs,
          warmupInputs,
        }),
      );
    }
  }

  const report = {
    benchmark: {
      generatedAt: new Date().toISOString(),
      name: "basketball-sam3-mask-artifacts",
      sampleFrameCount: options.sampleFrameCount,
      thresholds: options.thresholds,
      warmupFrameCount: options.warmupFrameCount,
    },
    cases,
    environment: getEnvironmentSummary(),
    fixture: staticStats,
    recommendations: createRecommendations({
      cases,
      fixture: staticStats,
      preparedWindowSeconds: options.preparedWindowSeconds,
    }),
  };

  await writeReport(report, options.outputDir);

  console.log(renderConsoleSummary(report));
}

function parseArgs(argv) {
  const options = {
    outputDir: defaultOutputDir,
    preparedWindowSeconds: defaultPreparedWindowSeconds,
    sampleFrameCount: defaultSampleFrameCount,
    thresholds: defaultThresholds,
    warmupFrameCount: defaultWarmupFrameCount,
  };

  for (const arg of argv) {
    const [name, value] = arg.split("=");

    if (name === "--output-dir" && value) {
      options.outputDir = path.resolve(rootDir, value);
    } else if (name === "--prepared-window-seconds" && value) {
      options.preparedWindowSeconds = parsePositiveNumber(
        value,
        options.preparedWindowSeconds,
      );
    } else if (name === "--sample-frames" && value) {
      options.sampleFrameCount = parsePositiveInteger(
        value,
        options.sampleFrameCount,
      );
    } else if (name === "--thresholds" && value) {
      options.thresholds = value
        .split(",")
        .map((threshold) => Number(threshold.trim()))
        .filter((threshold) => Number.isFinite(threshold));
    } else if (name === "--warmup-frames" && value) {
      options.warmupFrameCount = parsePositiveInteger(
        value,
        options.warmupFrameCount,
      );
    }
  }

  if (options.thresholds.length === 0) {
    options.thresholds = defaultThresholds;
  }

  return options;
}

async function loadFixture() {
  const manifestPath = path.join(fixtureDir, "detections.manifest.json");
  const detectionsPath = path.join(fixtureDir, "detections.json");
  const [manifest, detections] = await Promise.all([
    readJson(manifestPath),
    readJson(detectionsPath),
  ]);

  return {
    frames: detections.frames,
    manifest,
  };
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function measureSourceBytes(manifest) {
  const chunkFiles = manifest.chunks.map((chunk) =>
    path.join(fixtureDir, chunk.src),
  );
  const chunkStats = await Promise.all(
    chunkFiles.map(async (filePath) => ({
      bytes: (await fs.stat(filePath)).size,
      filePath,
    })),
  );
  const [manifestStats, detectionsStats, videoStats] = await Promise.all([
    fs.stat(path.join(fixtureDir, "detections.manifest.json")),
    fs.stat(path.join(fixtureDir, "detections.json")),
    fs.stat(path.join(fixtureDir, manifest.video.file)),
  ]);

  return {
    chunkedDetectionsBytes: chunkStats.reduce(
      (total, chunk) => total + chunk.bytes,
      0,
    ),
    chunks: chunkStats.map((chunk) => ({
      bytes: chunk.bytes,
      src: path.relative(fixtureDir, chunk.filePath),
    })),
    detectionsJsonBytes: detectionsStats.size,
    manifestBytes: manifestStats.size,
    videoBytes: videoStats.size,
  };
}

function summarizeFixture(fixture, sourceBytes) {
  const frames = fixture.frames;
  const detections = frames.flatMap((frame) => frame.detections);
  const masks = detections
    .map((detection) => detection.mask)
    .filter((mask) => Boolean(mask));
  const classNames = new Set(
    detections.map((detection) => detection.className ?? "detection"),
  );
  const maskWidth = fixture.manifest.inference.mask.width;
  const maskHeight = fixture.manifest.inference.mask.height;
  const maskPixels = maskWidth * maskHeight;
  const rleCountsBytes = masks.reduce(
    (total, mask) => total + Buffer.byteLength(mask.counts, "utf8"),
    0,
  );
  const rawBinaryMaskBytes = masks.length * maskPixels;
  const maxDetectionsPerFrame = Math.max(
    ...frames.map((frame) => frame.detections.length),
  );
  const fullFrameRgbaBytes = maskPixels * bytesPerRgbaPixel;
  const idMaskBytesPerFrame =
    maxDetectionsPerFrame <= 255
      ? maskPixels * bytesPerId8Pixel
      : maskPixels * bytesPerId16Pixel;

  return {
    classCount: classNames.size,
    classNames: Array.from(classNames).sort(),
    detectionCount: detections.length,
    durationSeconds: fixture.manifest.duration,
    frameCount: frames.length,
    frameRate: fixture.manifest.frameRate,
    fullFrameRgbaBytes,
    idMaskBytesPerFrame,
    maskCount: masks.length,
    maskHeight,
    maskPixels,
    maskWidth,
    maxDetectionsPerFrame,
    rawBinaryMaskBytes,
    rleCompressionRatio: rawBinaryMaskBytes
      ? rleCountsBytes / rawBinaryMaskBytes
      : 0,
    rleCountsBytes,
    sourceBytes,
  };
}

function createBenchmarkFrameInputs(frames, options) {
  return frames
    .map((frame) => ({
      detections: frame.detections.filter(
        (detection) =>
          detection.mask &&
          (detection.confidence ?? 1) >= options.confidenceThreshold,
      ),
      frameIndex: frame.frameIndex,
      mediaTime: frame.mediaTime,
    }))
    .filter((frame) => frame.detections.length > 0);
}

function createMaskInstructions(frameInput, options) {
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

function resolveClassStyle(className) {
  return basketballClassStyles[className] ?? fallbackClassStyle;
}

function buildIdMaskFrame(frameInput) {
  if (frameInput.detections.length === 0) {
    return undefined;
  }

  const width = Math.max(
    ...frameInput.detections.map((detection) => detection.mask.width),
  );
  const height = Math.max(
    ...frameInput.detections.map((detection) => detection.mask.height),
  );
  const maxId = frameInput.detections.length;
  const data =
    maxId <= 255
      ? new Uint8Array(width * height)
      : new Uint16Array(width * height);

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

function buildIdMaskPngFrame(frameInput, options) {
  const idMask = buildIdMaskFrame(frameInput);

  if (!idMask) {
    return undefined;
  }

  if (!(idMask.data instanceof Uint8Array)) {
    throw new Error(
      "PNG ID-mask benchmark only supports 8-bit masks for this fixture.",
    );
  }

  return {
    data: encodeGrayscalePng({
      compressionLevel: options.compressionLevel,
      height: idMask.height,
      pixels: idMask.data,
      width: idMask.width,
    }),
    height: idMask.height,
    width: idMask.width,
  };
}

function encodeGrayscalePng(options) {
  const rawScanlines = createFilterlessPngScanlines({
    height: options.height,
    pixels: options.pixels,
    width: options.width,
  });
  const ihdr = Buffer.alloc(13);

  ihdr.writeUInt32BE(options.width, 0);
  ihdr.writeUInt32BE(options.height, 4);
  ihdr[8] = 8; // Bit depth.
  ihdr[9] = 0; // Grayscale.
  ihdr[10] = 0; // Deflate compression.
  ihdr[11] = 0; // Adaptive filtering, with filter 0 per row below.
  ihdr[12] = 0; // No interlace.

  const compressed = zlib.deflateSync(rawScanlines, {
    level: options.compressionLevel,
  });

  return Buffer.concat([
    pngSignature,
    createPngChunk("IHDR", ihdr),
    createPngChunk("IDAT", compressed),
    createPngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function createFilterlessPngScanlines(options) {
  const rowStride = options.width + 1;
  const scanlines = Buffer.alloc(rowStride * options.height);

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

function createPngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);

  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(
    crc32(Buffer.concat([typeBuffer, data])),
    8 + data.length,
  );

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

function crc32(buffer) {
  let crc = 0xffffffff;

  for (const byte of buffer) {
    crc = crc32Table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function compositeMaskFrame(instructions) {
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

function compositeInstruction(rgba, canvasWidth, instruction) {
  const decodedMask = decodeCompressedRleMask(instruction.mask);
  const fill = resolveRgbaColor(instruction.color, instruction.alpha);

  compositeMaskFill(rgba, canvasWidth, decodedMask, fill);

  if (instruction.stroke) {
    compositeMaskStroke(rgba, canvasWidth, decodedMask, instruction.stroke);
  }
}

function compositeMaskFill(rgba, canvasWidth, decodedMask, fill) {
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

function compositeMaskStroke(rgba, canvasWidth, decodedMask, stroke) {
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

function decodeCompressedRleMask(mask) {
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

function decodeCompressedRleCounts(counts) {
  const decoded = [];
  let index = 0;

  while (index < counts.length) {
    let value = 0;
    let shift = 0;
    let charCode;

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

function isBoundaryPixel(mask, x, y) {
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

function isMaskPixel(mask, x, y) {
  return mask.data[y * mask.width + x] === 1;
}

function isOutsideMaskBounds(mask, x, y) {
  return x < 0 || y < 0 || x >= mask.width || y >= mask.height;
}

function resolveRgbaColor(color, alpha) {
  return {
    alpha: Math.round(Math.max(0, Math.min(alpha, 1)) * 255),
    blue: color & 0xff,
    green: (color >> 8) & 0xff,
    red: (color >> 16) & 0xff,
  };
}

function writePixel(rgba, canvasWidth, x, y, color) {
  const rgbaOffset = (y * canvasWidth + x) * 4;

  rgba[rgbaOffset] = color.red;
  rgba[rgbaOffset + 1] = color.green;
  rgba[rgbaOffset + 2] = color.blue;
  rgba[rgbaOffset + 3] = color.alpha;
}

async function benchmarkCase(options) {
  for (const input of options.warmupInputs) {
    options.run(input);
  }

  await new Promise((resolve) => setTimeout(resolve, 0));

  const frameDurationsMs = [];
  const artifactBytes = [];
  let sampledDetectionCount = 0;

  for (const input of options.sampledInputs) {
    const start = performance.now();
    const artifact = options.run(input);
    const durationMs = performance.now() - start;

    frameDurationsMs.push(durationMs);
    artifactBytes.push(artifact?.data.byteLength ?? 0);
    sampledDetectionCount += input.detections.length;
  }

  const timing = summarizeNumbers(frameDurationsMs);
  const bytes = summarizeNumbers(artifactBytes);
  const frameScale =
    options.frameInputs.length / Math.max(options.sampledInputs.length, 1);

  return {
    artifactBytes: {
      ...bytes,
      projectedFullFixtureBytes: bytes.mean * options.frameInputs.length,
    },
    caseName: options.caseName,
    frameCount: options.frameInputs.length,
    projectedFullFixtureMs: timing.total * frameScale,
    sampledDetectionCount,
    sampledFrameCount: options.sampledInputs.length,
    timingMs: timing,
  };
}

function summarizeNumbers(values) {
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
    max: sorted[sorted.length - 1],
    mean: total / values.length,
    min: sorted[0],
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    total,
  };
}

function percentile(sortedValues, quantile) {
  if (sortedValues.length === 0) {
    return 0;
  }

  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(sortedValues.length * quantile) - 1),
  );

  return sortedValues[index];
}

function selectEvenlySpaced(items, count) {
  if (count >= items.length) {
    return items;
  }

  if (count <= 1) {
    return items.slice(0, 1);
  }

  const selected = [];
  const seenIndexes = new Set();

  for (let i = 0; i < count; i += 1) {
    const index = Math.round((i * (items.length - 1)) / (count - 1));

    if (!seenIndexes.has(index)) {
      selected.push(items[index]);
      seenIndexes.add(index);
    }
  }

  return selected;
}

function createRecommendations(options) {
  const fixture = options.fixture;
  const preparedWindowFrames = Math.ceil(
    options.preparedWindowSeconds * fixture.frameRate,
  );
  const rgbaPreparedWindowBytes =
    preparedWindowFrames * fixture.fullFrameRgbaBytes;
  const idPreparedWindowBytes =
    preparedWindowFrames * fixture.idMaskBytesPerFrame;
  const paletteBytesPerClassStyleChange = fixture.classCount * 4;
  const pngPreparedWindowBytes = options.cases
    .filter((result) => result.caseName.startsWith("id-mask-png-"))
    .map((result) => ({
      caseName: result.caseName,
      preparedWindowBytes: preparedWindowFrames * result.artifactBytes.mean,
    }));

  return {
    idMaskPreparedWindowBytes: idPreparedWindowBytes,
    paletteBytesPerClassStyleChange,
    preparedWindowFrames,
    preparedWindowSeconds: options.preparedWindowSeconds,
    pngPreparedWindowBytes,
    rgbaPreparedWindowBytes,
    summary: [
      "Current RGBA artifacts are simple and renderer-friendly, but full-frame mask frames are byte-heavy.",
      "An ID-mask representation would reduce upload/cache bytes and make per-class style changes palette-sized instead of prepared-window-sized.",
      "PNG ID-mask artifacts are dramatically smaller on this sparse fixture, but encode time is still paid on top of RLE decode.",
      "Actual shader complexity and Pixi integration still need a browser/GPU prototype before replacing the current stable path.",
    ],
  };
}

async function writeReport(report, outputDir) {
  await fs.mkdir(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, "latest.json");
  const markdownPath = path.join(outputDir, "latest.md");

  await Promise.all([
    fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`),
    fs.writeFile(markdownPath, renderMarkdownReport(report)),
  ]);
}

function renderConsoleSummary(report) {
  const lines = [
    "Mask artifact benchmark complete",
    "",
    `Fixture: ${report.fixture.frameCount} frames, ${report.fixture.detectionCount} detections, ${report.fixture.maskWidth}x${report.fixture.maskHeight} masks`,
    `Source bytes: video ${formatBytes(
      report.fixture.sourceBytes.videoBytes,
    )}, chunked detections ${formatBytes(
      report.fixture.sourceBytes.chunkedDetectionsBytes,
    )}`,
    "",
    ...report.cases.map(
      (result) =>
        `${result.caseName}: ${formatMs(result.timingMs.mean)} mean/frame, ${formatMs(
          result.timingMs.p95,
        )} p95, ${formatBytes(result.artifactBytes.mean)} artifact/frame`,
    ),
    "",
    `5s RGBA prepared window: ${formatBytes(
      report.recommendations.rgbaPreparedWindowBytes,
    )}`,
    `5s ID-mask prepared window: ${formatBytes(
      report.recommendations.idMaskPreparedWindowBytes,
    )}`,
    ...report.recommendations.pngPreparedWindowBytes.map(
      (result) =>
        `5s ${result.caseName} prepared window: ${formatBytes(
          result.preparedWindowBytes,
        )}`,
    ),
  ];

  return lines.join("\n");
}

function renderMarkdownReport(report) {
  const rows = report.cases
    .map(
      (result) =>
        `| ${result.caseName} | ${result.sampledFrameCount} | ${formatMs(
          result.timingMs.mean,
        )} | ${formatMs(result.timingMs.p95)} | ${formatMs(
          result.projectedFullFixtureMs,
        )} | ${formatBytes(result.artifactBytes.mean)} |`,
    )
    .join("\n");
  const pngPreparedWindowRows = report.recommendations.pngPreparedWindowBytes
    .map(
      (result) =>
        `- ${result.caseName}: ${formatBytes(result.preparedWindowBytes)}`,
    )
    .join("\n");

  return `# Mask Artifact Benchmark

Generated: ${report.benchmark.generatedAt}

## Fixture

- Frames: ${report.fixture.frameCount}
- Detections: ${report.fixture.detectionCount}
- Masks: ${report.fixture.maskCount}
- Classes: ${report.fixture.classNames.join(", ")}
- Mask size: ${report.fixture.maskWidth} x ${report.fixture.maskHeight}
- Video bytes: ${formatBytes(report.fixture.sourceBytes.videoBytes)}
- Chunked detection bytes: ${formatBytes(
    report.fixture.sourceBytes.chunkedDetectionsBytes,
  )}
- RLE counts bytes: ${formatBytes(report.fixture.rleCountsBytes)}
- RLE/raw binary ratio: ${(report.fixture.rleCompressionRatio * 100).toFixed(
    2,
  )}%

## Timings

| Case | Sampled frames | Mean / frame | P95 / frame | Projected full fixture | Artifact bytes / frame |
| --- | ---: | ---: | ---: | ---: | ---: |
${rows}

## Prepared Window Byte Pressure

- Prepared window: ${report.recommendations.preparedWindowSeconds}s / ${
    report.recommendations.preparedWindowFrames
  } frames
- Current RGBA artifacts: ${formatBytes(
    report.recommendations.rgbaPreparedWindowBytes,
  )}
- ID-mask candidate: ${formatBytes(
    report.recommendations.idMaskPreparedWindowBytes,
  )}
${pngPreparedWindowRows}
- Per-class palette update: ${formatBytes(
    report.recommendations.paletteBytesPerClassStyleChange,
  )}

## Interpretation

${report.recommendations.summary.map((item) => `- ${item}`).join("\n")}

## Notes

- Timing measures CPU artifact preparation in Node.js using the same RLE decode
  and current RGBA compositor path used by the library.
- PNG timing measures a benchmark-only filterless grayscale PNG ID mask encoded
  with Node zlib. It does not measure browser-native image decode or Pixi/GPU
  texture upload.
- Texture upload bytes are estimated from artifact byte sizes. Actual GPU upload
  and fragment shader time require a browser/GPU benchmark.
- Results are local-machine measurements; use trends and ratios, not absolute
  milliseconds, as the decision input.
`;
}

function getEnvironmentSummary() {
  const cpus = os.cpus();

  return {
    arch: process.arch,
    cpuCount: cpus.length,
    cpuModel: cpus[0]?.model ?? null,
    node: process.version,
    platform: process.platform,
  };
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePositiveNumber(value, fallback) {
  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function formatMs(value) {
  return `${value.toFixed(value >= 10 ? 1 : 2)}ms`;
}

function formatBytes(value) {
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
