import { describe, expect, it } from 'vitest';
import { Color, ParallaxError, SeededRandom, Vec2, Vec3 } from '../core/index.js';
import type { JsonObject, Project, SceneDoc } from '../resource/index.js';
import { Kernel, t } from '../function/kernel/index.js';
import type { GameDefinition, KernelPlugin } from '../function/kernel/index.js';
import { coreEnvironment, DayChanged, EnvironmentApi } from './environment.js';
import { kw } from './kwargs.js';
import { Arrived, nav, NavAgent, NavApi } from './nav.js';
import { setActiveRandom } from './random.js';
import { terrain, TerrainApi } from './terrain.js';

const COLLIDER = { id: 'collider', schema: { shape: t.string({ default: 'box' }), offset: t.vec3({ default: Vec3.ZERO }) } };

function scene(id: string, blocks: { environment?: JsonObject; terrain?: JsonObject } = {}): SceneDoc {
  return {
    id, path: `scenes/${id}/scene.json`, tags: [], ui: [], init: {}, entities: [], regions: new Map(),
    plugins: blocks.terrain === undefined ? {} : { terrain: blocks.terrain },
    ...(blocks.environment !== undefined && { environment: blocks.environment }),
  };
}

function run(plugins: KernelPlugin[], scenes: SceneDoc[]): { kernel: Kernel; ns: Record<string, unknown> } {
  const project: Project = {
    prefabs: new Map(), scenes: new Map(scenes.map((s) => [s.id, s])), config: new Map(), content: new Map(),
    locales: new Map(), audio: new Map(), dialogues: new Map(), diagnostics: [],
  };
  const game: GameDefinition = { components: [COLLIDER], resources: [], events: [], behaviors: [], systems: [] };
  const kernel = new Kernel({ project, game, plugins, context: {} });
  kernel.start(scenes[0]!.id);
  const ns: Record<string, unknown> = {};
  for (const p of plugins) if (p.namespace !== undefined) ns[p.namespace.name] = p.namespace.create(kernel);
  return { kernel, ns };
}

function code(fn: () => unknown): string {
  try { fn(); } catch (e) { if (e instanceof ParallaxError) return e.diagnostic.code; throw e; }
  return 'no error';
}

describe('parallax.terrain', () => {
  it('ctx.terrain binds Python arguments onto the field', () => {
    const { ns } = run([terrain()], [scene('t', { terrain: { size: [20, 20], base_height: 3, layers: ['grass'] } }), scene('menu')]);
    const api = ns['terrain'] as TerrainApi;
    expect(api).toBeInstanceOf(TerrainApi);
    expect(api.height_at(new Vec3(1, 99, 2))).toBeCloseTo(3);
    expect(api.height_at(kw({ point: new Vec3(1, 0, 2) }))).toBeCloseTo(3);
    expect(api.normal_at(Vec3.ZERO)).toEqual(new Vec3(0, 1, 0));
    expect(api.surface_at(Vec3.ZERO)).toBe('grass');
    expect(api.ground(new Vec3(1, 50, 1))).toEqual(new Vec3(1, 3, 1));
    expect(code(() => api.height_at(1, 2))).toBe('PP3030');
    expect(code(() => api.height_at(1))).toBe('PP3202');
    expect(code(() => api.ground(new Vec2(1, 1)))).toBe('PP3202');
    expect(code(() => terrain(1))).toBe('PP3030');
  });

  it('PP3204 in scenes without terrain', () => {
    const { ns } = run([terrain()], [scene('menu')]);
    expect(code(() => (ns['terrain'] as TerrainApi).height_at(Vec3.ZERO))).toBe('PP3204');
  });
});

describe('ctx.environment', () => {
  it('properties, fog() and sky() with keywords', () => {
    const { kernel, ns } = run([coreEnvironment()], [scene('s', { environment: { time_of_day: 21, day_length: 720 } })]);
    const env = ns['environment'] as EnvironmentApi;
    expect(env.time_of_day).toBe(21);
    expect(env.is_night).toBe(true);
    env.time_of_day = 9;
    env.day += 1;
    expect([env.time_of_day, env.day, env.day_length, env.is_night]).toEqual([9, 1, 720, false]);
    env.fog(kw({ near: 10, far: 40, color: Color.WHITE, seconds: 0 }));
    env.sky('night', kw({ seconds: 0 }));
    env.fog(0.02, kw({ seconds: 0 }));
    expect(code(() => env.fog(kw({ colour: Color.WHITE })))).toBe('PP3030');
    expect(code(() => env.fog(kw({ color: '#fff' })))).toBe('PP3223');
    expect(code(() => env.sky('sunnny'))).toBe('PP3221');
    expect(code(() => { env.time_of_day = 'noon' as unknown as number; })).toBe('PP3223');
    expect(DayChanged.__event_id__).toBe('day_changed');
    expect(kernel.scene?.id).toBe('s');
  });
});

describe('parallax.nav', () => {
  it('handles, the plugin factory and ctx.nav', () => {
    setActiveRandom(new SeededRandom(3));
    expect(NavAgent.__component_id__).toBe('nav_agent');
    expect(Arrived.__event_id__).toBe('arrived');
    expect(code(() => nav(kw({ agent_radius: 'x' })))).toBe('PP3243');
    expect(code(() => nav(kw({ radius: 1 })))).toBe('PP3030');
    const { ns } = run([nav(kw({ agent_radius: 0.5, cell_size: 0.5 }))], [scene('open')]);
    const api = ns['nav'] as NavApi;
    expect(api.path(new Vec3(0, 0, 0), new Vec3(4, 0, 0))).toEqual([new Vec3(0, 0, 0), new Vec3(4, 0, 0)]);
    expect(api.reachable(kw({ start: new Vec3(0, 0, 0), end: new Vec3(1, 0, 1) }))).toBe(true);
    const point = api.random_point(new Vec3(0, 0, 0), 5)!;
    expect(Math.hypot(point.x, point.z)).toBeLessThanOrEqual(5);
    expect(code(() => api.path(new Vec2(0, 0), new Vec3(1, 0, 0)))).toBe('PP3242');
    expect(code(() => api.can_see(1, 2, kw({ fov: 'wide' })))).toBe('PP3243');
  });
});
