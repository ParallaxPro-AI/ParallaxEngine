/** A `light_grid` adds per-cell light to the 2D light map (blended between cell centers). */

import { describe, expect, it } from 'vitest';
import type { JsonObject, Placement, PrefabDoc, Project, SceneDoc } from '../../../resource/index.js';
import { RecordingSurface2d } from '../../../platform/headless/render.js';
import { Kernel } from '../../kernel/index.js';
import type { Fields } from '../../kernel/index.js';
import { visuals } from '../visuals/index.js';
import { render2d } from './index.js';
import { gridLightAt, lightAt } from './lighting.js';

const ORIGIN = { path: 'x', pointer: '' };

function placement(prefab: string, at: number[], components: Record<string, JsonObject> = {}): Placement {
  return { prefab, at, components, tags: [], params: {}, origin: ORIGIN };
}

function prefab(id: string, components: Record<string, JsonObject>): PrefabDoc {
  return { id, feature: undefined, path: `prefabs/${id}.prefab.json`, components, tags: [], behaviors: [], children: [] };
}

/** A camera (half-height `size`) at `cameraAt`, and the given extra prefabs placed at the origin. */
function run(cameraAt: number[], size: number, extra: Record<string, Record<string, JsonObject>>): { kernel: Kernel; surface: RecordingSurface2d } {
  const scene: SceneDoc = {
    id: 'main', path: 'scenes/main/scene.json', tags: [], ui: [], init: {}, regions: new Map(), plugins: {},
    environment: {},
    entities: [placement('camera', cameraAt), ...Object.keys(extra).map((id) => placement(id, [0, 0]))],
  };
  const prefabs = [prefab('camera', { camera: { mode: 'orthographic', size } }), ...Object.entries(extra).map(([id, c]) => prefab(id, c))];
  const project: Project = {
    prefabs: new Map(prefabs.map((p) => [p.id, p])), scenes: new Map([['main', scene]]), config: new Map(),
    content: new Map(), locales: new Map(), audio: new Map(), dialogues: new Map(), diagnostics: [],
  };
  const surface = new RecordingSurface2d({ keep: 1, width: 1600, height: 900 });
  const kernel = new Kernel({
    project, game: { components: [], resources: [], events: [], behaviors: [], systems: [] },
    plugins: [visuals({ dimension: '2d' }), render2d({ surface, files: { list: () => [], read: () => '' }, assetFiles: true })],
    context: {},
  });
  kernel.start('main');
  kernel.step(1 / 60);
  return { kernel, surface };
}

describe('light_grid', () => {
  const grid = { cell_size: [1, 1], levels: { a: '#000000', z: '#ffffff', r: '#ff0000' }, rows: ['zza', 'aar'] };

  it('turns 2D lighting on and carries its cells (top row first) at the entity', () => {
    const { surface } = run([0, 0], 5, { glow: { light_grid: grid } });
    const lighting = surface.last!.lighting!;
    expect(lighting).not.toBeNull();
    expect(lighting.lights).toEqual([]);
    const g = lighting.grids![0]!;
    expect([g.minX, g.minY, g.cols, g.rows, g.cellWidth, g.cellHeight]).toEqual([0, 0, 3, 2, 1, 1]);
    expect([...g.cells.slice(0, 4)]).toEqual([255, 255, 255, 255]);
    expect([...g.cells.slice(5 * 4, 6 * 4)]).toEqual([255, 0, 0, 255]);
  });

  it('light is the cell color at a cell center and blends between centers; nothing outside', () => {
    const { surface } = run([0, 0], 5, { glow: { light_grid: grid } });
    const g = surface.last!.lighting!.grids![0]!;
    expect(gridLightAt(g, 0.5, 1.5)).toEqual([1, 1, 1]);
    expect(gridLightAt(g, 2.5, 0.5)).toEqual([1, 0, 0]);
    const mid = gridLightAt(g, 1.5, 1.5);
    expect(mid[0]).toBeCloseTo(1, 6);
    expect(gridLightAt(g, 2, 1.5)[0]).toBeCloseTo(0.5, 6);
    expect(gridLightAt(g, 5, 5)).toEqual([0, 0, 0]);
    const lit = lightAt(surface.last!.lighting!, 0.5, 1.5);
    expect(lit).toEqual([1, 1, 1]);
  });

  it('is rebuilt only when its rows change', () => {
    const { kernel, surface } = run([0, 0], 5, { glow: { light_grid: grid } });
    const first = surface.last!.lighting!.grids![0]!;
    kernel.step(1 / 60);
    expect(surface.last!.lighting!.grids![0]).toBe(first);
    const [id] = kernel.world.query(['light_grid'])[0]!;
    (kernel.world.get(id)!.components.get('light_grid') as Fields)['rows'] = ['aaa', 'aaa'];
    kernel.step(1 / 60);
    const next = surface.last!.lighting!.grids![0]!;
    expect(next).not.toBe(first);
    expect(next.cells[0]).toBe(0);
  });

  it('a character with no level is PP3615', () => {
    expect(() => run([0, 0], 5, { glow: { light_grid: { ...grid, rows: ['zq'] } } })).toThrowError(/PP3615|not in levels/);
  });
});
