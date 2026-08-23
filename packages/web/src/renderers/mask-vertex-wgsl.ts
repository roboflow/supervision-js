const maskVertexPrologue = `
struct GlobalUniforms {
  uProjectionMatrix: mat3x3<f32>,
  uWorldTransformMatrix: mat3x3<f32>,
  uWorldColorAlpha: vec4<f32>,
  uResolution: vec2<f32>,
}

struct LocalUniforms {
  uTransformMatrix: mat3x3<f32>,
  uColor: vec4<f32>,
  uRound: f32,
}

@group(0) @binding(0) var<uniform> globalUniforms: GlobalUniforms;
@group(1) @binding(0) var<uniform> localUniforms: LocalUniforms;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) vUV: vec2<f32>,`;

const maskVertexBody = `
}

@vertex
fn mainVertex(
  @location(0) aPosition: vec2<f32>,
  @location(1) aUV: vec2<f32>,
) -> VertexOutput {
  let modelViewProjectionMatrix =
    globalUniforms.uProjectionMatrix *
    globalUniforms.uWorldTransformMatrix *
    localUniforms.uTransformMatrix;

  var output: VertexOutput;

  output.position = vec4<f32>(
    (modelViewProjectionMatrix * vec3<f32>(aPosition, 1.0)).xy,
    0.0,
    1.0
  );
  output.vUV = aUV;`;

const maskVertexEpilogue = `

  return output;
}
`;

const tintVarying = `
  @location(1) vColor: vec4<f32>,`;

const tintAssignment = `
  output.vColor = globalUniforms.uWorldColorAlpha * localUniforms.uColor;`;

/**
 * The vertex stage every mask shader draws with. Only the tint varies: a
 * fragment stage that multiplies the mask by the world color reads vColor,
 * one that samples the mask alone takes no such input.
 */
export const tintedMaskVertexWgsl = `${maskVertexPrologue}${tintVarying}${maskVertexBody}${tintAssignment}${maskVertexEpilogue}`;

export const untintedMaskVertexWgsl = `${maskVertexPrologue}${maskVertexBody}${maskVertexEpilogue}`;
