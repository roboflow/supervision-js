import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import test from "node:test";

const rootDir = process.cwd();
const coreSourceDir = path.join(rootDir, "packages/core/src");

const forbiddenPatterns = [
  {
    label: "pixi.js import",
    pattern: /from\s+["']pixi\.js(?:\/[^"']*)?["']/,
  },
  {
    label: "mediabunny import",
    pattern: /from\s+["']mediabunny(?:\/[^"']*)?["']/,
  },
  {
    label: "web package alias",
    pattern:
      /from\s+["']#(?:constants|media|playback|render-preparation|renderers|sessions|workers)\//,
  },
  { label: "document global", pattern: /\bdocument\s*[.([]/ },
  { label: "window global", pattern: /\bwindow\s*[.([]/ },
  { label: "HTMLElement", pattern: /\bHTMLElement\b/ },
  { label: "HTMLCanvasElement", pattern: /\bHTMLCanvasElement\b/ },
  { label: "OffscreenCanvas", pattern: /\bOffscreenCanvas\b/ },
  {
    label: "CanvasRenderingContext2D",
    pattern: /\bCanvasRenderingContext2D\b/,
  },
  { label: "Worker", pattern: /\bWorker\b/ },
  { label: "Blob", pattern: /\bBlob\b/ },
  { label: "ImageBitmap", pattern: /\bImageBitmap\b/ },
  { label: "createImageBitmap", pattern: /\bcreateImageBitmap\b/ },
  { label: "indexedDB", pattern: /\bindexedDB\b/ },
  { label: "fetch global", pattern: /\bfetch\s*[.([]/ },
  { label: "CompressionStream", pattern: /\bCompressionStream\b/ },
  { label: "VideoFrame", pattern: /\bVideoFrame\b/ },
  { label: "VideoEncoder", pattern: /\bVideoEncoder\b/ },
  { label: "VideoDecoder", pattern: /\bVideoDecoder\b/ },
];

test("core source stays free of browser and vendor runtime APIs", async () => {
  const files = await listSourceFiles(coreSourceDir);
  const failures = [];

  for (const file of files) {
    const source = stripComments(await readFile(file, "utf8"));

    for (const { label, pattern } of forbiddenPatterns) {
      if (pattern.test(source)) {
        failures.push(`${path.relative(rootDir, file)} uses ${label}`);
      }
    }
  }

  assert.deepEqual(failures, []);
});

async function listSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        return listSourceFiles(entryPath);
      }

      return entry.isFile() && entry.name.endsWith(".ts") ? [entryPath] : [];
    }),
  );

  return files.flat();
}

function stripComments(source) {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/\/\/.*$/gm, "");
}
