import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(fixtureRoot, "../..");
const videoEngineDir = path.resolve(
  repoRoot,
  "../roboflow-video-runtime/app/src/scripts/videoEngine",
);

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
  resolve: {
    alias: [
      {
        find: /^@roboflow\/video-engine$/,
        replacement: path.join(videoEngineDir, "index.ts"),
      },
      {
        find: /^@roboflow\/video-engine\/analysis$/,
        replacement: path.join(videoEngineDir, "analysis.ts"),
      },
    ],
  },
  root: fixtureRoot,
  server: {
    // Setting `allow` replaces Vite's default of the workspace root, so the
    // root has to be listed alongside the engine checkout.
    fs: {
      allow: [repoRoot, videoEngineDir],
    },
    // Extraction and proxy encodes hold this page for minutes to hours. A hot
    // patch reloads it mid-run and throws the work away.
    hmr: false,
    host: "127.0.0.1",
    port: 5175,
  },
});
