import typescript from "@rollup/plugin-typescript";

export default {
  input: {
    index: "src/index.ts",
  },
  external: ["supervision-js-core"],
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
