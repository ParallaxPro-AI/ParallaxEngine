import { describe, expect, it } from 'vitest';
import { ParallaxError, Vec3 } from '../../../core/index.js';
import type { Placement, PrefabDoc, Project, SceneDoc } from '../../../resource/index.js';
import { Kernel, t } from '../../kernel/index.js';
import type { ComponentDef } from '../../kernel/index.js';
import { NAV_SERVICE } from '../../services/index.js';
import { bakedField, findPath, nav } from './index.js';

const COLLIDER: ComponentDef = {
  id: 'collider',
  schema: {
    shape: t.string({ default: 'box' }), size: t.vec3({ default: Vec3.ONE }), radius: t.number({ default: 0.5 }),
    height: t.number({ default: 1 }), offset: t.vec3({ default: Vec3.ZERO }), trigger: t.bool({ default: false }),
    layer: t.string({ default: 'default' }),
  },
};

const prefab = (id: string, components: PrefabDoc['components']): PrefabDoc =>
  ({ id, feature: undefined, path: `prefabs/${id}.prefab.json`, components, tags: [], behaviors: [], children: [] });
const place = (p: string, at: number[]): Placement => ({ prefab: p, at, components: {}, tags: [], params: {}, origin: { path: 'x', pointer: '' } });

function world(): Kernel {
  const scene: SceneDoc = {
    id: 's', path: 'scenes/s/scene.json', tags: [], ui: [], init: {}, regions: new Map(), plugins: {},
    entities: [place('wall', [0, 0, 0]), place('wall', [4, 0, 4]), place('block', [-3, 0, 5])],
  };
  const project: Project = {
    prefabs: new Map([
      prefab('wall', { collider: { shape: 'box', size: [1, 3, 10], offset: [0, 1.5, 0] } }),
      prefab('block', { collider: { shape: 'cylinder', radius: 1, height: 2, offset: [0, 1, 0] } }),
    ].map((p) => [p.id, p])),
    scenes: new Map([[scene.id, scene]]), config: new Map(), content: new Map(), locales: new Map(), audio: new Map(), dialogues: new Map(), diagnostics: [],
  };
  const kernel = new Kernel({ project, game: { components: [COLLIDER], resources: [], events: [], behaviors: [], systems: [] }, plugins: [nav()], context: {} });
  kernel.start('s');
  return kernel;
}

describe('nav jobs: searches over a bake', () => {
  it('give exactly the live path, and survive structured cloning', () => {
    const service = world().service(NAV_SERVICE);
    const data = structuredClone(service.bake({ minX: -12, minZ: -12, maxX: 12, maxZ: 12 }, 0.4));
    for (const [from, to] of [[new Vec3(-6, 0, 0), new Vec3(6, 0, 1)], [new Vec3(-6, 0, 8), new Vec3(8, 0, -6)], [new Vec3(2, 0, 4), new Vec3(-5, 0, 5)]] as const) {
      const live = service.path(from, to, 0.4)!;
      const baked = findPath(data, { start: from, goal: to, snap: 1 })!;
      expect(live.length).toBeGreaterThan(2);
      expect(baked.map((w) => [w.x, w.z])).toEqual(live.map((w) => [w.x, w.z]));
    }
    // Paths can't leave the bake.
    expect(findPath(data, { start: new Vec3(-6, 0, 0), goal: new Vec3(20, 0, 0), snap: 1 })).toBeNull();
  });

  it('a bake answers for its own radius only', () => {
    const data = world().service(NAV_SERVICE).bake({ minX: -2, minZ: -2, maxX: 2, maxZ: 2 }, 0.4);
    try {
      bakedField(data).standable(0, 0, 0, 0.5);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ParallaxError);
    }
    // -2..2 m at 0.25 m cells: indices -8..8.
    expect([data.i0, data.cols, data.rows]).toEqual([-8, 17, 17]);
  });

  it('the service: opaque cells, line of sight, nearest ground', () => {
    const service = world().service(NAV_SERVICE);
    expect(service.opaque(0, 0, 1.5, 0)).toBe(true);
    expect(service.opaque(0.8, 0, 1.5, 0)).toBe(false);
    expect(service.opaque(0.8, 0, 1.5, 0.5)).toBe(true);
    expect(service.opaque(0, 0, 3.5, 0)).toBe(false);
    expect(service.lineClear(new Vec3(-3, 1, 0), new Vec3(3, 1, 0), [])).toBe(false);
    expect(service.lineClear(new Vec3(-3, 1, -8), new Vec3(3, 1, -8), [])).toBe(true);
    // Beside the wall, closer than the agent's radius: not standable; the nearest ground is.
    expect(service.standable(new Vec3(0.7, 0, 0), 0.4)).toBe(false);
    const near = service.nearest(new Vec3(0.7, 0, 0), 0.4, 2)!;
    expect(service.standable(near, 0.4)).toBe(true);
    expect(near.distance_to(new Vec3(0.7, near.y, 0))).toBeLessThanOrEqual(2);
  });
});
