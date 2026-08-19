import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { roboflowSam3Plugin } from "./server/roboflow-sam3-plugin";

const demoDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(demoDir, "..");
const videoEngineDir = path.resolve(
  demoDir,
  "../../roboflow-video-runtime/app/src/scripts/videoEngine",
);

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), "VITE_");

  return {
    base: environment.VITE_DEMO_BASE_PATH || "/",
    plugins: [react(), roboflowSam3Plugin()],
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
    server: {
      // Setting `allow` replaces Vite's default of the workspace root, so the
      // root has to be listed alongside the engine checkout.
      fs: {
        allow: [workspaceRoot, videoEngineDir],
      },
      host: "0.0.0.0",
      port: 5173,
      strictPort: true,
    },
  };
});
