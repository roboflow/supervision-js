import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(fixtureRoot, "../..");

export default defineConfig({
  build: {
    emptyOutDir: true,
    outDir: "dist",
  },
  root: fixtureRoot,
  server: {
    fs: {
      allow: [repoRoot],
    },
    host: "127.0.0.1",
    port: 5175,
  },
});
