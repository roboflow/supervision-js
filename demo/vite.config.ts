import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { roboflowSam3Plugin } from "./server/roboflow-sam3-plugin";

export default defineConfig({
  plugins: [react(), roboflowSam3Plugin()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
  },
});
