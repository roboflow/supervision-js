import type {
  Mesh as PixiMesh,
  MeshGeometry as PixiMeshGeometry,
  Shader as PixiShader,
} from "pixi.js";

/**
 * A shader built from the GLSL program alone draws nothing under the WebGPU
 * renderer and raises nothing while doing it, so both programs are required of
 * every renderer that builds one and of every renderer that hands the factory
 * on to another.
 */
export type InjectedShaderFactory = {
  from(options: {
    gl: { fragment: string; vertex: string };
    gpu: {
      fragment: { entryPoint: string; source: string };
      vertex: { entryPoint: string; source: string };
    };
    resources: Record<string, unknown>;
  }): PixiShader;
};

export type InjectedMeshGeometryConstructor = new (options: {
  indices: Uint32Array;
  positions: Float32Array;
  shrinkBuffersToFit: boolean;
  topology: "triangle-list";
  uvs: Float32Array;
}) => PixiMeshGeometry;

export type InjectedMeshConstructor<
  TMesh extends PixiMesh<PixiMeshGeometry, PixiShader>,
> = new (options: { geometry: PixiMeshGeometry; shader: PixiShader }) => TMesh;
