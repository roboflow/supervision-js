import {
  Buffer,
  BufferUsage,
  Mesh,
  MeshGeometry,
  Shader,
  Texture,
  TextureSource,
  type UniformGroup,
} from "pixi.js";
import { expect, it } from "vitest";
import { createPixiFocusHeatmapCutout } from "./pixi-focus-heatmap-cutout";

it("releases its coverage buffer while preserving its borrowed heatmap", () => {
  const source = new TextureSource({ width: 4, height: 4 });
  const texture = new Texture({ source });
  const artifact = {
    detectionIndex: 0,
    bounds: { x: 20, y: 15, width: 24, height: 16 },
    texture,
  };
  const cutout = createPixiFocusHeatmapCutout({
    artifact,
    Mesh,
    MeshGeometry,
    Shader: { from: (options) => Shader.from({ ...options, gl: undefined }) },
  });
  const uniforms = cutout.display.shader!.resources
    .heatmapCoverageUniforms as UniformGroup;
  const buffer = new Buffer({
    data: new Float32Array(4),
    usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
  });
  uniforms.buffer = buffer;
  try {
    cutout.render(artifact);
    expect(uniforms.uniforms.uAntialiasing).toBe(0);
    cutout.render(artifact, true);
    expect(uniforms.uniforms.uAntialiasing).toBe(1);
    expect(cutout.display.position).toMatchObject({ x: 8, y: 7 });
    expect(cutout.display.scale).toMatchObject({ x: 24, y: 16 });
    cutout.destroy();

    expect(buffer.destroyed).toBe(true);
    expect(uniforms.buffer).toBeUndefined();
    expect(source.destroyed).toBe(false);
    expect(texture.destroyed).toBe(false);
  } finally {
    if (!buffer.destroyed) cutout.destroy();
    texture.destroy(true);
  }
});
