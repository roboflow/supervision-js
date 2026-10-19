import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

const folder = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(folder, "../..");
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function sources(server) {
  const paths = [
    ...new Set([
      ...[...server.moduleGraph.idToModuleMap.values()]
        .map((module) => module.file)
        .filter((path) => path?.startsWith(root))
        .map((path) => path.slice(root.length + 1)),
      "package.json",
      "package-lock.json",
      "tools/annotation-aa/vite.config.mjs",
      "packages/web/src/renderers/pixi-annotation-antialias.ts",
    ]),
  ];
  const hashes = Object.fromEntries(
    paths
      .filter((path) => existsSync(resolve(root, path)))
      .sort()
      .map((path) => [path, sha(readFileSync(resolve(root, path)))]),
  );
  return {
    head: git("rev-parse", "HEAD"),
    dirty: git("status", "--porcelain", "--untracked-files=normal"),
    pixiVersion: JSON.parse(
      readFileSync(resolve(root, "node_modules/pixi.js/package.json"), "utf8"),
    ).version,
    hashes,
    fingerprint: sha(JSON.stringify(hashes)),
  };
}

export default defineConfig({
  root: folder,
  resolve: {
    alias: [
      {
        find: /^#(constants|media|render-preparation|renderers|types|workers)\/(.+)$/,
        replacement: resolve(root, "packages/web/src/$1/$2"),
      },
    ],
  },
  plugins: [
    {
      name: "annotation-aa-validation",
      enforce: "pre",
      transform(source, id) {
        return id.endsWith("/pixi-focus-layer.ts")
          ? {
              code: `${source}\nexport { createFocusIdMaskRenderer };\n`,
              map: null,
            }
          : null;
      },
      configureServer(server) {
        mkdirSync(resolve(folder, "artifacts"), { recursive: true });
        server.middlewares.use(
          "/__annotation-aa-source",
          (_request, response) => {
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify(sources(server)));
          },
        );
        server.middlewares.use(
          "/__annotation-aa-report",
          (request, response) => {
            if (request.method !== "PUT") {
              response.statusCode = 405;
              response.end();
              return;
            }
            const chunks = [];
            request.on("data", (chunk) => chunks.push(chunk));
            request.on("end", () => {
              try {
                const { report, images } = JSON.parse(
                  Buffer.concat(chunks).toString(),
                );
                const directory = resolve(
                  folder,
                  "artifacts",
                  `${report.backend?.requested ?? "setup"}-${Date.now()}`,
                );
                mkdirSync(directory, { recursive: false });
                for (const image of images) {
                  if (!/^[a-z0-9.-]+$/.test(image.name))
                    throw Error("invalid artifact name");
                  writeFileSync(
                    resolve(directory, `${image.name}.png`),
                    Buffer.from(image.png.split(",")[1], "base64"),
                  );
                }
                writeFileSync(
                  resolve(directory, "report.json"),
                  JSON.stringify(report, null, 2) + "\n",
                );
                response.setHeader("content-type", "application/json");
                response.end(JSON.stringify({ directory }));
              } catch (error) {
                response.statusCode = 500;
                response.end(String(error));
              }
            });
          },
        );
      },
    },
  ],
  server: {
    host: "127.0.0.1",
    port: 5277,
    strictPort: true,
    hmr: false,
    fs: { allow: [root] },
  },
});
