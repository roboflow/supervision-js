import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const resultsDir = path.join(repoRoot, "benchmark/depth/results");
const isolationHeaders = {
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
};

/**
 * Browsers the runner cannot drive over CDP open the page with
 * `?report=<name>`; the page PUTs its result here and it lands in
 * `results/latest-<name>.json`.
 */
function resultsEndpoint(): Plugin {
  return {
    configureServer(server) {
      server.middlewares.use(
        "/__depth-benchmark/results/",
        (request, response) => {
          const name = decodeURIComponent(request.url ?? "")
            .replace(/^\//, "")
            .replace(/[^a-z0-9-]/gi, "");

          if (request.method !== "PUT" || !name) {
            response.statusCode = 405;
            response.end();
            return;
          }

          const chunks: Buffer[] = [];

          request.on("data", (chunk: Buffer) => chunks.push(chunk));
          request.on("end", async () => {
            await mkdir(resultsDir, { recursive: true });
            await writeFile(
              path.join(resultsDir, `latest-${name}.json`),
              Buffer.concat(chunks),
            );
            response.statusCode = 204;
            response.end();
          });
        },
      );
    },
    name: "depth-benchmark-results",
  };
}

export default defineConfig({
  build: {
    emptyOutDir: true,
    outDir: path.join(repoRoot, "benchmark/depth/gpu/dist"),
    rollupOptions: {
      input: path.join(repoRoot, "benchmark/depth/gpu/index.html"),
    },
  },
  plugins: [resultsEndpoint()],
  resolve: {
    // The library modules under test import their siblings through the web
    // package's private aliases, which the package manifest maps to dist.
    alias: [
      {
        find: /^#(constants|media|render-preparation|renderers|types|workers)\/(.+)$/,
        replacement: path.join(repoRoot, "packages/web/src/$1/$2"),
      },
    ],
  },
  root: repoRoot,
  // Cross-origin isolation gives performance.now() microsecond resolution;
  // without it browsers round it to 0.1 ms, coarser than a 720p upload.
  preview: { headers: isolationHeaders },
  server: {
    fs: {
      allow: [repoRoot],
    },
    headers: isolationHeaders,
    host: "127.0.0.1",
    port: Number(process.env.DEPTH_BENCHMARK_PORT ?? 5187),
    strictPort: true,
  },
});
