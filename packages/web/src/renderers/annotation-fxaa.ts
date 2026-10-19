/*!
 * The FXAA algorithm is adapted from PixiJS v7.4.3's official shader:
 * https://github.com/pixijs/pixijs/blob/v7.4.3/packages/filter-fxaa/src/fxaa.frag
 * It includes alpha in contrast, filters premultiplied RGBA, clamps samples,
 * limits the span to four pixels and mixes the center back for thin strokes.
 *
 * From: https://github.com/mitsuhiko/webgl-meincraft
 * Copyright (c) 2011 by Armin Ronacher. Some rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * Redistributions of source code must retain the above copyright notice,
 * this list of conditions and the following disclaimer.
 *
 * Redistributions in binary form must reproduce the above copyright notice,
 * this list of conditions and the following disclaimer in the documentation
 * and/or other materials provided with the distribution.
 *
 * The names of the contributors may not be used to endorse or promote
 * products derived from this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 */

export const annotationFxaaGl = `
vec4 applyAnnotationFxaa(vec2 uv) {
  vec2 pixel = uInputPixel.zw;
  vec4 center = readColor(uv);
  float nw = contrastValue(readColor(uv + vec2(-1.0, -1.0) * pixel));
  float ne = contrastValue(readColor(uv + vec2( 1.0, -1.0) * pixel));
  float sw = contrastValue(readColor(uv + vec2(-1.0,  1.0) * pixel));
  float se = contrastValue(readColor(uv + vec2( 1.0,  1.0) * pixel));
  float middle = contrastValue(center);
  float low = min(middle, min(min(nw, ne), min(sw, se)));
  float high = max(middle, max(max(nw, ne), max(sw, se)));
  if (high - low < max(0.03125, high * 0.0625)) {
    return center;
  }
  vec2 direction = vec2(-((nw + ne) - (sw + se)), (nw + sw) - (ne + se));
  float reduction = max((nw + ne + sw + se) * 0.03125, 0.0078125);
  direction *= 1.0 / (min(abs(direction.x), abs(direction.y)) + reduction);
  direction = clamp(direction, vec2(-4.0), vec2(4.0)) * pixel;
  vec4 narrow = 0.5 * (
    readColor(uv - direction / 6.0) +
    readColor(uv + direction / 6.0)
  );
  vec4 wide = 0.5 * narrow + 0.25 * (
    readColor(uv - direction * 0.5) +
    readColor(uv + direction * 0.5)
  );
  float value = contrastValue(wide);
  vec4 filtered = value < low || value > high ? narrow : wide;
  return mix(center, filtered, 0.75);
}
`;

export const annotationFxaaWgsl = `
fn applyAnnotationFxaa(uv: vec2<f32>) -> vec4<f32> {
  let pixel = gfu.uInputPixel.zw;
  let center = readColor(uv);
  let nw = contrastValue(readColor(uv + vec2<f32>(-1.0, -1.0) * pixel));
  let ne = contrastValue(readColor(uv + vec2<f32>( 1.0, -1.0) * pixel));
  let sw = contrastValue(readColor(uv + vec2<f32>(-1.0,  1.0) * pixel));
  let se = contrastValue(readColor(uv + vec2<f32>( 1.0,  1.0) * pixel));
  let middle = contrastValue(center);
  let low = min(middle, min(min(nw, ne), min(sw, se)));
  let high = max(middle, max(max(nw, ne), max(sw, se)));
  if (high - low < max(0.03125, high * 0.0625)) { return center; }
  var direction = vec2<f32>(-((nw + ne) - (sw + se)), (nw + sw) - (ne + se));
  let reduction = max((nw + ne + sw + se) * 0.03125, 0.0078125);
  direction *= 1.0 / (min(abs(direction.x), abs(direction.y)) + reduction);
  direction = clamp(direction, vec2<f32>(-4.0), vec2<f32>(4.0)) * pixel;
  let narrow = 0.5 * (readColor(uv - direction / 6.0) + readColor(uv + direction / 6.0));
  let wide = 0.5 * narrow + 0.25 * (readColor(uv - direction * 0.5) + readColor(uv + direction * 0.5));
  let value = contrastValue(wide);
  let filtered = select(wide, narrow, value < low || value > high);
  return mix(center, filtered, 0.75);
}
`;
