import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import sourceConfig from "../../vitest.config.ts";

const root = fileURLToPath(new URL(".", import.meta.url));
export default defineConfig({
  root,
  resolve: sourceConfig.resolve,
  server: {
    host: "127.0.0.1",
    port: 7187,
    strictPort: true,
    fs: { allow: [fileURLToPath(new URL("../..", import.meta.url))] },
  },
});
