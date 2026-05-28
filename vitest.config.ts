import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const sourceAlias = (folder: string) => path.resolve(rootDir, "src", folder);

export default defineConfig({
  resolve: {
    alias: {
      "#constants": sourceAlias("constants"),
      "#media": sourceAlias("media"),
      "#playback": sourceAlias("playback"),
      "#renderers": sourceAlias("renderers"),
      "#types": sourceAlias("types"),
      "#utils": sourceAlias("utils"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
