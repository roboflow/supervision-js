import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import test from "node:test";

const rootDir = process.cwd();
const coreSourceDir = path.join(rootDir, "packages/core/src");
const webSourceDir = path.join(rootDir, "packages/web/src");
const reactNativeSourceDir = path.join(rootDir, "packages/react-native/src");

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
  {
    label: "browser package import",
    pattern: /from\s+["']supervision["']/,
  },
  { label: "document global", pattern: /\bdocument\s*[.([]/ },
  { label: "window global", pattern: /\bwindow\s*[.([]/ },
  { label: "navigator global", pattern: /\bnavigator\s*[.([]/ },
  { label: "HTMLElement", pattern: /\bHTMLElement\b/ },
  { label: "HTMLCanvasElement", pattern: /\bHTMLCanvasElement\b/ },
  { label: "HTMLVideoElement", pattern: /\bHTMLVideoElement\b/ },
  { label: "HTMLImageElement", pattern: /\bHTMLImageElement\b/ },
  { label: "HTMLMediaElement", pattern: /\bHTMLMediaElement\b/ },
  { label: "OffscreenCanvas", pattern: /\bOffscreenCanvas\b/ },
  {
    label: "CanvasRenderingContext2D",
    pattern: /\bCanvasRenderingContext2D\b/,
  },
  { label: "Worker", pattern: /\bWorker\b/ },
  { label: "Blob", pattern: /\bBlob\b/ },
  {
    label: "File global",
    pattern: /(?::\s*File\b|\bnew\s+File\b|\binstanceof\s+File\b)/,
  },
  { label: "FileReader", pattern: /\bFileReader\b/ },
  { label: "ImageBitmap", pattern: /\bImageBitmap\b/ },
  { label: "createImageBitmap", pattern: /\bcreateImageBitmap\b/ },
  { label: "indexedDB", pattern: /\bindexedDB\b/ },
  { label: "fetch global", pattern: /\bfetch\s*[.([]/ },
  { label: "XMLHttpRequest", pattern: /\bXMLHttpRequest\b/ },
  { label: "localStorage", pattern: /\blocalStorage\b/ },
  { label: "sessionStorage", pattern: /\bsessionStorage\b/ },
  { label: "URL object URL", pattern: /\bURL\.(create|revoke)ObjectURL\b/ },
  { label: "CompressionStream", pattern: /\bCompressionStream\b/ },
  { label: "VideoFrame", pattern: /\bVideoFrame\b/ },
  { label: "VideoEncoder", pattern: /\bVideoEncoder\b/ },
  { label: "VideoDecoder", pattern: /\bVideoDecoder\b/ },
  { label: "WebGL", pattern: /\bWebGL(?:2)?RenderingContext\b/ },
  { label: "WebGPU", pattern: /\bGPU(?:Device|CanvasContext|Texture)\b/ },
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

test("web source consumes core through the package boundary", async () => {
  const files = await listSourceFiles(webSourceDir);
  const failures = [];
  const forbiddenWebPatterns = [
    {
      label: "core source path",
      pattern: /from\s+["'][^"']*(?:packages\/core|supervision-js-core\/src)/,
    },
    {
      label: "relative core source import",
      pattern: /from\s+["'](?:\.\.\/)+core(?:\/|["'])/,
    },
  ];

  for (const file of files) {
    const source = stripComments(await readFile(file, "utf8"));

    for (const { label, pattern } of forbiddenWebPatterns) {
      if (pattern.test(source)) {
        failures.push(`${path.relative(rootDir, file)} uses ${label}`);
      }
    }
  }

  assert.deepEqual(failures, []);
});

test("React Native source stays independent from browser package code", async () => {
  const files = await listSourceFiles(reactNativeSourceDir);
  const failures = [];
  const forbiddenReactNativePatterns = [
    {
      label: "browser package import",
      pattern: /from\s+["']supervision["']/,
    },
    {
      label: "web source path",
      pattern: /from\s+["'][^"']*(?:packages\/web|supervision-js\/src)/,
    },
    {
      label: "Pixi import",
      pattern: /from\s+["']pixi\.js(?:\/[^"']*)?["']/,
    },
    {
      label: "Mediabunny import",
      pattern: /from\s+["']mediabunny(?:\/[^"']*)?["']/,
    },
    { label: "DOM global", pattern: /\b(?:document|window)\s*[.([]/ },
    {
      label: "browser media element",
      pattern: /\bHTML(?:Video|Image|Media)Element\b/,
    },
    { label: "IndexedDB", pattern: /\bindexedDB\b/ },
  ];

  for (const file of files) {
    const source = stripComments(await readFile(file, "utf8"));

    for (const { label, pattern } of forbiddenReactNativePatterns) {
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
