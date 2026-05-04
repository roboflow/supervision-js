import typescript from "@rollup/plugin-typescript";

export default {
  input: "src/index.ts",
  external: ["mediabunny", "pixi.js"],
  output: {
    file: "dist/index.js",
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
