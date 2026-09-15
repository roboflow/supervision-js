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

/**
 * The GL counterpart of the tinted vertex stage. Pixi caches a program under
 * both of its stages' source text, so shaders that share this one still get a
 * program each from their own fragment stage.
 */
export const tintedMaskVertexGlsl = `#version 300 es
precision highp float;

in vec2 aPosition;
in vec2 aUV;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform vec4 uWorldColorAlpha;
uniform mat3 uTransformMatrix;
uniform vec4 uColor;

out vec2 vUV;
out vec4 vColor;

void main(void) {
  mat3 modelViewProjectionMatrix =
    uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;

  gl_Position =
    vec4((modelViewProjectionMatrix * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vUV = aUV;
  vColor = uWorldColorAlpha * uColor;
}
`;
