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
                "supervision-js-video-engine/*",
                "!supervision-js-video-engine/analysis",
                "!supervision-js-video-engine/worker",
              ],
              message:
                "The video engine exposes three entries: supervision-js-video-engine, supervision-js-video-engine/analysis, and supervision-js-video-engine/worker. Anything else is an internal module.",
            },
            {
              group: ["**/video-engine/src/**"],
              message:
                "Import supervision-js-video-engine or supervision-js-video-engine/analysis. A path into the engine's source binds the importer to its file layout.",
            },
          ],
        },
      ],
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
