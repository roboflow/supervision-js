import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { roboflowSam3Plugin } from "./server/roboflow-sam3-plugin";

const demoDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(demoDir, "..");

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), "VITE_");

  return {
    base: environment.VITE_DEMO_BASE_PATH || "/",
    plugins: [react(), roboflowSam3Plugin()],
    server: {
      fs: {
        allow: [workspaceRoot],
      },
      host: "0.0.0.0",
      port: 5173,
      strictPort: true,
    },
  };
});
