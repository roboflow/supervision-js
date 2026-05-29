import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { roboflowSam3Plugin } from "./server/roboflow-sam3-plugin";

export default defineConfig({
  plugins: [react(), roboflowSam3Plugin()],
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
});
