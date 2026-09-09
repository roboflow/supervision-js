import { defineConfig, type Plugin } from "vite";

/**
 * Vite's build hash is eight base64url characters. Requiring a digit or a
 * capital keeps an ordinary eight-letter word from passing as a hash: a missed
 * hash only costs a revalidation, while a word mistaken for one pins a mutable
 * file in every visitor's cache for a year.
 */
export const IMMUTABLE_ASSET_PATH =
  /\/assets\/.+-(?=[\w-]{8}\.)[\w-]*[A-Z0-9_-][\w-]*\.[^/]+$/;
const ONE_YEAR_SECONDS = 31_536_000;

/**
 * Vite's preview server answers every request with `Cache-Control: no-cache`,
 * which costs the deployed site a full round trip per detection chunk and per
 * media byte range even when the browser already holds the bytes.
 */
function cacheHashedAssets(): Plugin {
  return {
    configurePreviewServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = (request.url ?? "").split("?")[0];

        response.setHeader(
          "Cache-Control",
          IMMUTABLE_ASSET_PATH.test(path)
            ? `public, max-age=${ONE_YEAR_SECONDS}, immutable`
            : "no-cache",
        );

        next();
      });
    },
    name: "cache-hashed-assets",
  };
}

export default defineConfig({
  plugins: [cacheHashedAssets()],
});
