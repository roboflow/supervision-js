import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const sourceAlias = (folder: string) => path.resolve(rootDir, "src", folder);

export default defineConfig({
  resolve: {
    alias: {
      "#constants": sourceAlias("constants"),
      "#detections": sourceAlias("detections"),
      "#interactions": sourceAlias("interactions"),
      "#media": sourceAlias("media"),
      "#playback": sourceAlias("playback"),
      "#render-preparation": sourceAlias("render-preparation"),
      "#renderers": sourceAlias("renderers"),
      "#sessions": sourceAlias("sessions"),
      "#styles": sourceAlias("styles"),
      "#types": sourceAlias("types"),
      "#utils": sourceAlias("utils"),
      "#workers": sourceAlias("workers"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "demo/server/**/*.test.ts"],
  },
});
