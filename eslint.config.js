import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "docs/site/**",
      "tools/sam3-fixture/output/**",
      "tools/geometry-fixture/output/**",
    ],
  },
  {
    languageOptions: {
      globals: {
        console: "readonly",
        document: "readonly",
        window: "readonly",
      },
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@roboflow/video-engine/*",
                "!@roboflow/video-engine/analysis",
              ],
              message:
                "The video engine exposes two entries: @roboflow/video-engine and @roboflow/video-engine/analysis. Anything else is an internal module.",
            },
            {
              group: ["**/roboflow-video-runtime/**", "**/videoEngine/**"],
              message:
                "Import @roboflow/video-engine or @roboflow/video-engine/analysis. A path into the video engine checkout binds this repo to its file layout.",
            },
          ],
        },
      ],
    },
  },
];
