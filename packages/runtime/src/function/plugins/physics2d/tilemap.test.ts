/** Tilemap colliders: solid cells (merged into row runs) are static ground; `solid: false` cells and empty ones are not. */

import { beforeAll, describe, expect, it } from 'vitest';
import { Color, Vec2, Vec3 } from '../../../core/index.js';
import type { ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel, t } from '../../kernel/index.js';
import type { BehaviorDef, ComponentDef, Fields, GameDefinition, LogicInstance } from '../../kernel/index.js';
import { initPhysics2d, PHYSICS_EVENTS, physics2d } from './index.js';
import type { Hit, PhysicsNamespace } from './index.js';

const DT = 1 / 60;
beforeAll(async () => { await initPhysics2d(); });

// The visuals plugin's tilemap fields (read by id); defined here so the test needs no other plugin.
const TILEMAP: ComponentDef = {
  id: 'tilemap',
  schema: {
    tile_size: t.vec2({ default: Vec2.ONE }),
    rows: t.list({ kind: 'string' }, { default: [] }),
    tiles: { type: { kind: 'dict', of: { kind: 'record', fields: {
      image: { type: { kind: 'optional', of: { kind: 'string' } }, default: null },
      color: t.color({ default: Color.WHITE }),
      solid: t.bool({ default: true }),
    } } }, default: {} },
    collide: t.bool({ default: false }),
    layer: t.string({ default: 'default' }),
    friction: t.number({ default: 0.5 }),
  },
};

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

function world(rows: string[], collide = true): { kernel: Kernel; physics: PhysicsNamespace } {
  const project = loadProject(files({
    'prefabs/ground.prefab.json': { components: { tilemap: {
      tile_size: [1, 1], rows, collide, tiles: { G: {}, g: { solid: false } },
    } } },
    'prefabs/ball.prefab.json': { components: { rigidbody: {}, collider: { shape: 'circle', radius: 0.25 } } },
    'scenes/main/scene.json': { entities: [
      { id: 'ground', prefab: 'ground', at: [0, 0] },
      { id: 'ball', prefab: 'ball', at: [0.5, 4] },
      { id: 'ball2', prefab: 'ball', at: [2.5, 4] },
    ] },
  }));
  expect(project.diagnostics).toEqual([]);
  const plugin = physics2d({});
  const def: GameDefinition = { components: [TILEMAP], resources: [], events: [], behaviors: [], systems: [] };
  const kernel = new Kernel({ project, game: def, plugins: [plugin], context: {}, fixedStep: DT });
  const physics = plugin.namespace!.create(kernel) as PhysicsNamespace;
  kernel.start('main');
  return { kernel, physics };
}

const y = (k: Kernel, id: string): number => [...k.world.live()].find((r) => r.placedId === id)!.transform.position.y;

describe('tilemap colliders', () => {
  it('a ball lands on a solid cell (top of the bottom row is y = 1) and falls through a solid: false one', () => {
    const { kernel } = world(['....', 'GGgG']);
    for (let i = 0; i < 180; i++) kernel.step(DT);
    expect(y(kernel, 'ball')).toBeCloseTo(1.25, 1);
    expect(y(kernel, 'ball2')).toBeLessThan(0);
  });

  it('a raycast hits the tilemap entity; without collide there is nothing to hit', () => {
    const solid = world(['GGGG']);
    solid.kernel.step(DT); // queries see colliders after a step
    const hit = solid.physics.raycast(new Vec3(1.5, 3, 0), new Vec3(0, -1, 0), 10) as Hit | null;
    expect(hit?.point.y).toBeCloseTo(1, 5);
    const none = world(['GGGG'], false);
    none.kernel.step(DT);
    const miss = none.physics.raycast(new Vec3(1.5, 3, 0), new Vec3(0, -1, 0), 10) as Hit | null;
    expect(miss === null || miss.point.y < 1).toBe(true); // only the balls are there
  });

  it('a character with no tile is PP3615', () => {
    expect(() => world(['GX'])).toThrow(/PP3615|not in tiles/);
  });

  it('a body resting across two tile runs gets one collided and no collision_ended', () => {
    const log: string[] = [];
    const listen: BehaviorDef = {
      id: 'listen', params: {}, state: {}, requires: [],
      handlers: [{ event: PHYSICS_EVENTS.collided, method: 'hit' }, { event: PHYSICS_EVENTS.collisionEnded, method: 'ended' }],
      create: () => ({ hit: () => log.push('hit'), ended: () => log.push('ended') }) as unknown as LogicInstance,
    };
    // 'G.G': two runs (x 0..1 and 2..3); the plank spans both and settles on them.
    const project = loadProject(files({
      'prefabs/ground.prefab.json': { components: { tilemap: { tile_size: [1, 1], rows: ['G.G'], collide: true, tiles: { G: {} } } } },
      'prefabs/plank.prefab.json': {
        components: { rigidbody: {}, collider: { shape: 'box', size: [3, 0.5] } },
        behaviors: { listen: {} },
      },
      'scenes/main/scene.json': { entities: [{ prefab: 'ground', at: [0, 0] }, { id: 'plank', prefab: 'plank', at: [1.5, 2] }] },
    }));
    expect(project.diagnostics).toEqual([]);
    const def: GameDefinition = { components: [TILEMAP], resources: [], events: [], behaviors: [listen], systems: [] };
    const kernel = new Kernel({ project, game: def, plugins: [physics2d({})], context: {}, fixedStep: DT });
    kernel.start('main');
    for (let i = 0; i < 120; i++) kernel.step(DT);
    expect(y(kernel, 'plank')).toBeCloseTo(1.25, 1);
    expect(log).toEqual(['hit']);
  });

  it('rows edited in place rebuild the colliders on the next step', () => {
    const { kernel } = world(['GGGG']);
    for (let i = 0; i < 120; i++) kernel.step(DT);
    expect(y(kernel, 'ball')).toBeCloseTo(1.25, 1);
    const ground = [...kernel.world.live()].find((r) => r.placedId === 'ground')!;
    (ground.components.get('tilemap') as Fields)['rows'] = ['....'];
    for (let i = 0; i < 60; i++) kernel.step(DT);
    expect(y(kernel, 'ball')).toBeLessThan(0);
  });
});
