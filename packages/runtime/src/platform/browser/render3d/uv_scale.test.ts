/** `Material3d.uvScale` (Shape.uv_scale) reaches the mesh shaders through the material block's `grain.yz`. */

import { describe, expect, it } from 'vitest';
import type { Material3d } from '../../../core/index.js';
import { MATERIAL_FIELDS, MATERIAL_SLOT, offsetOf, packMaterial } from './layout.js';
import { glsl, wgsl } from './shaders.js';

const BASE: Material3d = {
  id: 'm', baseColor: [1, 1, 1, 1], baseColorTexture: null, metallic: 0, roughness: 1, metallicRoughnessTexture: null,
  emissive: [0, 0, 0], emissiveTexture: null, alphaMode: 'opaque', alphaCutoff: 0.5, doubleSided: false, unlit: false,
};

describe('uv tiling', () => {
  it('packs uvScale into grain.yz, [1, 1] when absent', () => {
    const at = offsetOf(MATERIAL_FIELDS, 'grain');
    const out = new Float32Array(MATERIAL_SLOT * 2);
    packMaterial(BASE, out, 0);
    packMaterial({ ...BASE, uvScale: [8, 2] }, out, 1);
    expect([out[at + 1], out[at + 2]]).toEqual([1, 1]);
    expect([out[MATERIAL_SLOT + at + 1], out[MATERIAL_SLOT + at + 2]]).toEqual([8, 2]);
  });

  it('samples every map at the tiled uv in both backends', () => {
    expect(wgsl('mesh')).toContain('let tiled = in.uv * material.grain.yz;');
    expect(glsl('mesh').fragment).toContain('vec2 tiled = vUv * grain.yz;');
  });
});
