import { describe, expect, it } from 'vitest';
import type { TerrainMaterial3d } from '../../../core/index.js';
import { linearRgb, MATERIAL_SLOT, offsetOf, TERRAIN_FIELDS } from './layout.js';
import { glsl, GLSL_UNITS, wgsl } from './shaders.js';
import { NO_WATER, packLayerMode, packPattern, packTerrainBlock } from './terrain_plan.js';

const GRASS: TerrainMaterial3d = {
  texture: null, tile: 7, color: [0.4, 0.6, 0.3], tint: [1, 0.5, 1], roughness: 0.8, detail: null, detailTile: 1, detailStrength: 0,
  pattern: 'grass', variation: 0.5, relief: 1, normal: null, recolor: false,
};
const ROAD: TerrainMaterial3d = {
  texture: { id: 'road', source: { kind: 'file', path: 'assets/images/road.png' }, colorSpace: 'srgb', wrapU: 'repeat', wrapV: 'repeat', filter: 'linear' },
  tile: 3, color: [0.3, 0.3, 0.3], tint: [1, 1, 1], roughness: 0.6, detail: null, detailTile: 2, detailStrength: 0.4,
  pattern: 'paved', variation: 0.25, relief: 1.5,
  normal: { id: 'road_n', source: { kind: 'file', path: 'assets/images/road_n.png' }, colorSpace: 'srgb', wrapU: 'repeat', wrapV: 'repeat', filter: 'linear' },
  recolor: true,
};

describe('terrain block', () => {
  it('fits a material slot', () => {
    expect(offsetOf(TERRAIN_FIELDS, 'terrainParams') + 4).toBeLessThanOrEqual(MATERIAL_SLOT);
  });

  it('packs relief, normal-map strength, pattern and variation, array layers per slot, and the water level', () => {
    const out = new Float32Array(MATERIAL_SLOT);
    packTerrainBlock([GRASS, ROAD], [1, 0], 30, 40, out, 0, { waterLevel: 1.5, layers: [0, 5], splat: { width: 100, depth: 80, rows: 81, planes: 1 } });
    const at = (field: string): number[] => [...out.subarray(offsetOf(TERRAIN_FIELDS, field), offsetOf(TERRAIN_FIELDS, field) + 4)];
    expect(at('layerRelief')).toEqual([1.5, 1, 0, 0]);
    expect(at('terrainSplat')).toEqual([100, 80, 81, 1]);
    expect(packLayerMode(ROAD, 1)).toBe(2 + 4 + 8);
    expect(packLayerMode(GRASS, 0)).toBe(0);
    expect(at('layerPattern')).toEqual([4.125, 1.25, 0, 0]);
    expect(packPattern('snow', 1)).toBe(5.5);
    expect(out[offsetOf(TERRAIN_FIELDS, 'layerSurface') + 3]).toBe(5);
    expect(out[offsetOf(TERRAIN_FIELDS, 'layerColor') + 3]).toBe(14);
    expect(out[offsetOf(TERRAIN_FIELDS, 'layerColor') + 7]).toBe(0);
    expect(at('terrainParams')[3]).toBe(1.5);
    packTerrainBlock([GRASS], [0], 30, 40, out, 0);
    expect(at('terrainParams')[3]).toBe(NO_WATER);
  });

  it('packs the palette in order, its geomorph window, and safe tiles for empty slots', () => {
    const out = new Float32Array(MATERIAL_SLOT);
    packTerrainBlock([GRASS, ROAD], [1, 0], 30, 40, out, 0);
    const at2 = (field: string): number[] => [...out.subarray(offsetOf(TERRAIN_FIELDS, field), offsetOf(TERRAIN_FIELDS, field) + 4)];
    const color = offsetOf(TERRAIN_FIELDS, 'layerColor');
    const tint = offsetOf(TERRAIN_FIELDS, 'layerTint');
    const surface = offsetOf(TERRAIN_FIELDS, 'layerSurface');
    expect(out[color + 3]).toBe(14);
    expect(at2('terrainSplat')[3]).toBe(0);
    expect(out[color + 4 + 3]).toBe(0);
    const g = linearRgb(GRASS.color);
    expect(out[color + 4 + 1]).toBeCloseTo(g[1] * 0.5, 6);
    expect([out[tint + 3], out[tint + 7], out[tint + 11]]).toEqual([3, 7, 1]);
    expect([out[surface], out[surface + 4]]).toEqual([Math.fround(0.6), Math.fround(0.8)]);
    expect([...out.subarray(offsetOf(TERRAIN_FIELDS, 'terrainParams'), offsetOf(TERRAIN_FIELDS, 'terrainParams') + 3)]).toEqual([2, 30, 40]);
  });

  it('both languages geomorph in the vertex shader, sample the terrain arrays, and shade with triplanar, height blending and relief', () => {
    for (const mrt of [false, true]) {
      const w = wgsl('terrain', { mrt });
      expect(w).toContain('p.y = mix(p.y, v.morph.x, k)');
      expect(w).toContain('@binding(1) var albedoArray: texture_2d_array<f32>');
      expect(w).toContain('@binding(7) var layerSampler');
      const g = glsl('terrain', { mrt });
      expect(g.vertex).toContain('p.y = mix(p.y, morph.x, k)');
      expect(g.fragment).toContain('uniform sampler2DArray terrainNormal;');
      expect(g.fragment).toContain('uniform sampler2D detail3;');
      expect(g.fragment).toContain('uniform sampler2D splatMap;');
      expect(w).toContain('@binding(8) var splatMap: texture_2d<f32>');
      for (const source of [w, g.fragment]) {
        expect(source).toContain('surfaceOf(3, w0.w');
        expect(source).toContain('groundAt(pr.sx, px)');
        expect(source).toMatch(/wh = max\(b - vec4(<f32>)?\(top - 0\.25\)/);
      }
      expect(w).toContain('dpdx(height)');
      expect(g.fragment).toContain('dFdx(height)');
    }
    expect(new Set([GLSL_UNITS.terrainAlbedo, GLSL_UNITS.terrainNormal, GLSL_UNITS.splatMap, GLSL_UNITS.detail0, GLSL_UNITS.detail3, GLSL_UNITS.envCube]).size).toBe(6);
  });
});
