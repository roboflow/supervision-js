import typescript from "@rollup/plugin-typescript";

export default {
  input: {
    "adapters/executorch": "src/adapters/executorch.ts",
    index: "src/index.ts",
    "media-session": "src/media-session.ts",
    sessions: "src/sessions.ts",
    skia: "src/skia.ts",
  },
  external: [
    "@shopify/react-native-skia",
    "react-native-reanimated",
    "react-native-vision-camera-worklets",
    "react-native-worklets",
    "supervision-js-core",
  ],
  output: {
    dir: "dist",
    entryFileNames: "[name].js",
    format: "es",
    sourcemap: true,
  },
  plugins: [
    typescript({
      tsconfig: "./tsconfig.json",
      declaration: false,
      declarationMap: false,
    }),
  ],
  treeshake: {
    moduleSideEffects: false,
  },
};
