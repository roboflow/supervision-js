import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), "VITE_");

  return {
    base: environment.VITE_VANILLA_BASE_PATH || "/examples/vanilla/",
  };
});
