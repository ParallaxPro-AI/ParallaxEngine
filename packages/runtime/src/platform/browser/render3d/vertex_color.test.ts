/**
 * Vertex colours are sRGB at the port (Geometry3d.colors: the glTF loader converts COLOR_0
 * to sRGB, generated meshes write sRGB), while the mesh shaders shade in linear space. The
 * mesh pass must linearize them as it does material colours and tints, or every
 * vertex-coloured surface draws washed out.
 */

import { describe, expect, it } from 'vitest';
import { glsl, wgsl } from './shaders.js';

describe('mesh vertex colours', () => {
  it('are linearized from sRGB before they multiply the linear tint (GLSL and WGSL, every variant)', () => {
    for (const skinned of [false, true]) {
      for (const mrt of [false, true]) {
        const vertex = glsl('mesh', { skinned, mrt }).vertex;
        expect(vertex).toContain('vColor = vec4(vertexColorLinear(color.rgb), color.a) * tint;');
        expect(vertex).not.toContain('vColor = color * tint;');
        const shader = wgsl('mesh', { skinned, mrt });
        expect(shader).toContain('out.color = vec4<f32>(vertexColorLinear(v.color.rgb), v.color.a) * v.tint;');
        expect(shader).not.toContain('out.color = v.color * v.tint;');
      }
    }
  });
});
