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
        find: /^#web-video-engine$/,
        replacement: path.resolve(
          rootDir,
          "packages/video-engine/src/index.ts",
        ),
      },
      {
        find: /^#web-video-engine\/analysis$/,
        replacement: path.resolve(
          rootDir,
          "packages/video-engine/src/analysis.ts",
        ),
      },
      {
        find: /^supervision\/web-video-engine$/,
        replacement: path.resolve(
          rootDir,
          "packages/web/src/web-video-engine/index.ts",
        ),
      },
      {
        find: /^supervision\/web-video-engine\/analysis$/,
        replacement: path.resolve(
          rootDir,
          "packages/video-engine/src/analysis.ts",
        ),
      },
      {
        find: "supervision/editing",
        replacement: path.resolve(rootDir, "packages/web/src/editing.ts"),
      },
      {
        find: "supervision",
        replacement: path.resolve(rootDir, "packages/web/src/index.ts"),
      },
      {
        find: "supervision-js-core",
        replacement: path.resolve(rootDir, "packages/core/src/index.ts"),
      },
      {
        find: /^#detections\/(array-detection-frame-source|buffered-detection-timeline|cold-detection-frame-source|composite-detection-frame-source|editable-annotation-frame-session|memory-cold-detection-frame-store|projected-detection-frame-source|writable-detection-frame-source)$/,
        replacement: `${coreSource("detections")}/$1.ts`,
      },
      {
        find: /^#interactions\/(.+)$/,
        replacement: `${coreSource("interactions")}/$1.ts`,
      },
      {
        find: /^#post-processing\/(byte-track-tracker|cbiou-tracker|oc-sort-tracker|sort-tracker|tracking|tracking-association|tracking-kalman)$/,
        replacement: `${coreSource("post-processing")}/$1.ts`,
      },
      {
        find: /^#styles\/(.+)$/,
        replacement: `${coreSource("styles")}/$1.ts`,
      },
      {
        find: /^#types\/(annotation-renderer|box-style|detection-timeline|detections|editing|ellipse-style|focus-style|interaction|interaction-style|keypoint-style|label-style|mask-style|media|media-rendering|paint-style|polygon-style|polyline-style|post-processing|session-lifecycle|shape-style|style|viewport)$/,
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
        find: /^#editing\/(.+)$/,
        replacement: `${webSource("editing")}/$1.ts`,
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
        find: /^#post-processing\/(.+)$/,
        replacement: `${webSource("post-processing")}/$1.ts`,
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
      "demo/src/**/*.test.tsx",
      "examples/react-native/src/**/*.test.ts",
      "tools/**/*.test.ts",
    ],
  },
});
