import typescript from "@rollup/plugin-typescript";

export default {
  input: {
    "adapters/executorch": "src/adapters/executorch.ts",
    "adapters/live-inference": "src/adapters/live-inference.ts",
    "adapters/vision-camera": "src/adapters/vision-camera.ts",
    "adapters/video-file": "src/adapters/video-file.ts",
    index: "src/index.ts",
    "media-session": "src/media-session.ts",
    react: "src/react/index.ts",
    sessions: "src/sessions.ts",
    skia: "src/skia.ts",
    "worklet-debug": "src/worklet-debug.ts",
  },
  external: [
    "@shopify/react-native-skia",
    "react",
    "react/jsx-runtime",
    "react-native",
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
