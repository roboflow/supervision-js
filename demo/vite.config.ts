import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { roboflowSam3Plugin } from "./server/roboflow-sam3-plugin";

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), "VITE_");

  return {
    base: environment.VITE_DEMO_BASE_PATH || "/",
    plugins: [react(), roboflowSam3Plugin()],
    server: {
      host: "0.0.0.0",
      port: 5173,
      strictPort: true,
    },
  };
});
