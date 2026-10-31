/**
 * The base map's city layer: with a city service present, the minimap draws its blocks,
 * parks, buildings and streets (avenues apart from side streets, each with a minimum screen
 * width), and grows to the city's bounds.
 */

import { describe, expect, it } from 'vitest';
import { Color, Vec3 } from '../../../core/index.js';
import type { ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel, t } from '../../kernel/index.js';
import type { KernelPlugin } from '../../kernel/index.js';
import { CITY_SERVICE, TERRAIN_SERVICE } from '../../services/index.js';
import type { CityMap, TerrainField } from '../../services/index.js';
import { BaseMapBuilder } from './base_map.js';

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

const CITY: CityMap = {
  bounds: [-60, -40, 60, 40],
  blocks: [[[-50, -30], [-10, -30], [-10, 30], [-50, 30]]],
  parks: [[[10, -30], [50, -30], [50, 30], [10, 30]]],
  buildings: [[[-45, -25], [-15, -25], [-15, 25], [-45, 25]]],
  streets: [
    { a: [0, -40], b: [0, 40], width: 14, major: true },
    { a: [-60, 0], b: [-10, 0], width: 8, major: false },
  ],
};

/** A flat 100 m field: asphalt west of x = 0, grass east of it. */
const FIELD = {
  width: 100, depth: 100, minX: -50, minZ: -50, columns: 11, rows: 11, minHeight: 0, maxHeight: 0, waterLevel: null,
  layers: [{ name: 'asphalt' }, { name: 'grass' }, { name: 'road' }],
  paths: [{ paint: 'road', points: [[-40, 0], [40, 0]], width: 10, closed: false }, { paint: 'grass', points: [[0, -40], [0, 40]], width: 6, closed: false }],
  heightAt: () => 0,
  surfaceAt: (x: number) => (x < 0 ? 'asphalt' : 'grass'),
} as unknown as TerrainField;

function start(city: CityMap | null, terrain: TerrainField | null = null): Kernel {
  const plugin: KernelPlugin = {
    id: 'stand_ins',
    components: [{ id: 'shape', schema: { kind: t.string({ default: 'box' }), size: t.vec3({ default: Vec3.ONE }), offset: t.vec3({ default: Vec3.ZERO }), color: t.color({ default: Color.WHITE }) } }],
    install(k) {
      if (city !== null) k.provide(CITY_SERVICE, { revision: 0, meshes: () => [], map: () => city });
      if (terrain !== null) k.provide(TERRAIN_SERVICE, { current: () => terrain } as never);
    },
  };
  const project = loadProject(files({
    'prefabs/pad.prefab.json': { components: { shape: { kind: 'box', size: [4, 0.2, 4] } } },
    'scenes/main/scene.json': { entities: [{ prefab: 'pad', id: 'pad', at: [0, 0, 0] }] },
  }));
  expect(project.diagnostics).toEqual([]);
  const kernel = new Kernel({ project, game: { components: [], events: [], behaviors: [], systems: [], resources: [] }, plugins: [plugin] });
  kernel.start('main');
  return kernel;
}

const svgOf = (uri: string): string => decodeURIComponent(uri.slice(uri.indexOf(',') + 1));

describe('base map city layer', () => {
  it('draws blocks, parks, buildings and a street hierarchy, and spans the city', () => {
    const kernel = start(CITY);
    const base = new BaseMapBuilder(kernel, '3d').build(kernel.world.query([]).map(([id]) => id))!;
    expect(base.city).toBe(CITY);
    expect(base.minU).toBeLessThanOrEqual(-60);
    expect(base.maxV).toBeGreaterThanOrEqual(40);
    const svg = svgOf(base.uri);
    expect(svg).toContain('fill="#30363f"'); // blocks
    expect(svg).toContain('fill="#33402f"'); // parks
    expect(svg).toContain('fill="#3a414c"'); // buildings
    // Avenue at its real width and at a minimum on-screen width; side streets likewise.
    expect(svg).toContain('stroke="#a8b3c3" stroke-width="14"');
    expect(svg).toContain('stroke="#6b7688" stroke-width="8"');
    expect(svg).toMatch(/stroke="#a8b3c3" stroke-width="2\.5"[^>]*vector-effect="non-scaling-stroke"/);
    // Side streets under avenues; a floor footprint (the pad) under the city.
    expect(svg.indexOf('#6b7688')).toBeLessThan(svg.indexOf('#a8b3c3'));
    expect(svg.indexOf('<polygon')).toBeLessThan(svg.indexOf('#30363f'));
  });

  it('draws no city layer without the city service', () => {
    const kernel = start(null);
    const base = new BaseMapBuilder(kernel, '3d').build(kernel.world.query([]).map(([id]) => id))!;
    expect(base.city).toBeNull();
    expect(svgOf(base.uri)).not.toContain('#a8b3c3');
  });

  it('draws paved terrain in the city ground tone and the rest on the height ramp', () => {
    const kernel = start(null, FIELD);
    const svg = svgOf(new BaseMapBuilder(kernel, '3d').build(kernel.world.query([]).map(([id]) => id))!.uri);
    expect(svg).toContain('fill="rgba(48, 54, 63, 1)"'); // asphalt: the block tone
    expect(svg).not.toMatch(/<rect x="-50"[^>]*fill="rgba\(63, 83, 48/); // no grass on the west half
    expect(svg).toMatch(/fill="rgba\(63, 83, 48/); // grass east of x = 0
    // The road path as a street stroke (its width, and the on-screen minimum); the grass path draws nothing.
    expect(svg).toContain('<path d="M-40,0L40,0" fill="none" stroke="#6b7688" stroke-width="10"');
    expect(svg).not.toContain('M0,40L0,-40');
  });
});
