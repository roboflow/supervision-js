import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

export default defineConfig({
  build: {
    emptyOutDir: true,
    outDir: path.join(repoRoot, "benchmark/masks/gpu/dist"),
    rollupOptions: {
      input: path.join(repoRoot, "benchmark/masks/gpu/index.html"),
    },
  },
  root: repoRoot,
  server: {
    fs: {
      allow: [repoRoot],
    },
    host: "127.0.0.1",
    port: 5176,
    strictPort: true,
  },
});
