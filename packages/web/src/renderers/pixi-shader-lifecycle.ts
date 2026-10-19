import type { Shader as PixiShader } from "pixi.js";

/**
 * Pixi keys its program cache by source, so one program is shared by every
 * shader built from it. `destroy(true)` takes that program with it, leaving
 * both the peers still rendering through it and the next shader built from the
 * same source bound to nothing.
 */
export function destroyShaderKeepingProgram(shader: PixiShader): void {
  try {
    shader.destroy();
  } catch {
    // Pixi has already invalidated this shader's resource group.
  }
}

/**
 * Pixi uploads a placeholder while it builds a shader's first bind group, and
 * WebGPU rejects a canvas that was never given a rendering context.
 */
export function createShaderPlaceholderCanvas(): HTMLCanvasElement {
  if (typeof document === "undefined") {
    return { height: 1, width: 1 } as HTMLCanvasElement;
  }

  const canvas = document.createElement("canvas");

  canvas.height = 1;
  canvas.width = 1;
  canvas.getContext("2d");

  return canvas;
}
