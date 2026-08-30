import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "local_claude/**",
      "docs/site/**",
      "tools/sam3-fixture/output/**",
      "tools/geometry-fixture/output/**",
    ],
  },
  {
    languageOptions: {
      globals: {
        clearInterval: "readonly",
        clearTimeout: "readonly",
        console: "readonly",
        document: "readonly",
        setInterval: "readonly",
        setTimeout: "readonly",
        window: "readonly",
      },
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      /* A leading underscore marks a binding the code is required to accept and
       * has no use for: a parameter the worker protocol carries, or the value of
       * a generator drained for its side effects. */
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "supervision/web-video-engine/*",
                "!supervision/web-video-engine/analysis",
                "!supervision/web-video-engine/worker",
              ],
              message:
                "The web video engine exposes three entries: supervision/web-video-engine, supervision/web-video-engine/analysis, and supervision/web-video-engine/worker. Anything else is an internal module.",
            },
            {
              group: [
                "supervision-js-web-video-engine",
                "supervision-js-web-video-engine/**",
              ],
              message:
                "The web video engine is a private workspace package that ships inside supervision. Import supervision/web-video-engine or supervision/web-video-engine/analysis.",
            },
            {
              group: ["#web-video-engine", "#web-video-engine/**"],
              message:
                "#web-video-engine is the browser package's own alias for the staged engine build. Import supervision/web-video-engine or supervision/web-video-engine/analysis.",
            },
            {
              group: ["**/video-engine/src/**"],
              message:
                "Import supervision/web-video-engine or supervision/web-video-engine/analysis. A path into the engine's source binds the importer to its file layout.",
            },
          ],
        },
      ],
    },
  },
  {
    /* The media seam and the subpath barrel are the two places that adapt the
     * staged engine build, so they are the two that may name it. */
    files: [
      "packages/web/src/media/video-engine-media-source.ts",
      "packages/web/src/media/video-engine-media-source.test.ts",
      "packages/web/src/web-video-engine/index.ts",
    ],
    rules: {
      "no-restricted-imports": "off",
    },
  },
  {
    files: ["packages/video-engine/src/decode-scheduler.test.ts"],
    rules: {
      /* Doubles for a decode that hangs: the generator awaits a promise that
       * never settles, so it can never reach a yield. Being a generator is what
       * the caller consumes, not an accident of how it was written. */
      "require-yield": "off",
    },
  },
];
