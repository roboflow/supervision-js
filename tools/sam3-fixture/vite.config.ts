import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(fixtureRoot, "../..");

export default defineConfig({
  build: {
    emptyOutDir: true,
    outDir: "dist",
    rollupOptions: {
      input: {
        index: path.resolve(fixtureRoot, "index.html"),
        proxy: path.resolve(fixtureRoot, "proxy.html"),
      },
    },
  },
  root: fixtureRoot,
  server: {
    fs: {
      allow: [repoRoot],
    },
    // Extraction and proxy encodes hold this page for minutes to hours. A hot
    // patch reloads it mid-run and throws the work away.
    hmr: false,
    host: "127.0.0.1",
    port: 5175,
  },
});
