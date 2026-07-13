import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const coreSource = (folder: string) =>
  path.resolve(rootDir, "packages/core/src", folder);
const webSource = (folder: string) =>
  path.resolve(rootDir, "packages/web/src", folder);

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "supervision-js",
        replacement: path.resolve(rootDir, "packages/web/src/index.ts"),
      },
      {
        find: "supervision-js-core",
        replacement: path.resolve(rootDir, "packages/core/src/index.ts"),
      },
      {
        find: /^#detections\/(array-detection-frame-source|buffered-detection-timeline|cold-detection-frame-source|composite-detection-frame-source|memory-cold-detection-frame-store|writable-detection-frame-source)$/,
        replacement: `${coreSource("detections")}/$1.ts`,
      },
      {
        find: /^#interactions\/(.+)$/,
        replacement: `${coreSource("interactions")}/$1.ts`,
      },
      {
        find: /^#styles\/(.+)$/,
        replacement: `${coreSource("styles")}/$1.ts`,
      },
      {
        find: /^#types\/(box-style|detection-timeline|detections|focus-style|interaction|interaction-style|label-style|mask-style|media|media-rendering|session-lifecycle|style)$/,
        replacement: `${coreSource("types")}/$1.ts`,
      },
      {
        find: /^#utils\/(.+)$/,
        replacement: `${coreSource("utils")}/$1.ts`,
      },
      {
        find: /^#constants\/(.+)$/,
        replacement: `${webSource("constants")}/$1.ts`,
      },
      {
        find: /^#detections\/(.+)$/,
        replacement: `${webSource("detections")}/$1.ts`,
      },
      {
        find: /^#media\/(.+)$/,
        replacement: `${webSource("media")}/$1.ts`,
      },
      {
        find: /^#playback\/(.+)$/,
        replacement: `${webSource("playback")}/$1.ts`,
      },
      {
        find: /^#render-preparation\/(.+)$/,
        replacement: `${webSource("render-preparation")}/$1.ts`,
      },
      {
        find: /^#renderers\/(.+)$/,
        replacement: `${webSource("renderers")}/$1.ts`,
      },
      {
        find: /^#sessions\/(.+)$/,
        replacement: `${webSource("sessions")}/$1.ts`,
      },
      {
        find: /^#types\/(.+)$/,
        replacement: `${webSource("types")}/$1.ts`,
      },
      {
        find: /^#workers\/(.+)$/,
        replacement: `${webSource("workers")}/$1.ts`,
      },
    ],
  },
  test: {
    environment: "node",
    include: [
      "packages/**/*.test.ts",
      "demo/src/**/*.test.ts",
      "examples/react-native/src/**/*.test.ts",
    ],
  },
});
