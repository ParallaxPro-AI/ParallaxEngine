/** Light `when` ("always" | "night" | "day") by the environment's hour, and the 2D frame's post settings. */

import { describe, expect, it } from 'vitest';
import { Color, Vec3 } from '../../../core/index.js';
import type { JsonObject, Placement, PrefabDoc, Project, SceneDoc } from '../../../resource/index.js';
import { Kernel, t } from '../../kernel/index.js';
import type { EntityRecord, Fields } from '../../kernel/index.js';
import { ENVIRONMENT_SERVICE, lightShare } from '../../services/index.js';
import type { PostSettings } from '../../services/index.js';
import { environment } from '../environment/index.js';
import { lightOf } from '../render3d/draw.js';
import { visuals } from '../visuals/index.js';
import { RecordingSurface2d } from '../../../platform/headless/render.js';
import { render2d } from './index.js';
import { lighting2d } from './lighting.js';
import { Placements } from './placement.js';
import { post2d } from './post.js';

const ORIGIN = { path: 'x', pointer: '' };

function placement(prefab: string, at: number[]): Placement {
  return { prefab, at, components: {}, tags: [], params: {}, origin: ORIGIN };
}

function prefab(id: string, components: Record<string, JsonObject>): PrefabDoc {
  return { id, feature: undefined, path: `prefabs/${id}.prefab.json`, components, tags: [], behaviors: [], children: [] };
}

const COLLIDER = {
  id: 'collider',
  schema: {
    shape: t.string({ default: 'box' }), size: t.vec3({ default: Vec3.ONE }), radius: t.number({ default: 0.5 }),
    height: t.number({ default: 1 }), offset: t.vec3({ default: Vec3.ZERO }), trigger: t.bool({ default: false }),
  },
};

function start(timeOfDay: number, post?: JsonObject, surface?: RecordingSurface2d): Kernel {
  const scene: SceneDoc = {
    id: 'main', path: 'scenes/main/scene.json', tags: [], ui: [], init: {}, regions: new Map(), plugins: {},
    environment: { time_of_day: timeOfDay, ...(post !== undefined && { post }) },
    entities: [placement('camera', [0, 0]), placement('lamp', [0, 0]), placement('streetlight', [4, 0]), placement('sunbeam', [8, 0])],
  };
  const prefabs = [
    prefab('camera', { camera: { mode: 'orthographic', size: 5 } }),
    prefab('lamp', { light: { range: 3 } }),
    prefab('streetlight', { light: { range: 3, intensity: 2, when: 'night' } }),
    prefab('sunbeam', { light: { range: 3, when: 'day' } }),
  ];
  const project: Project = {
    prefabs: new Map(prefabs.map((p) => [p.id, p])), scenes: new Map([['main', scene]]), config: new Map(),
    content: new Map(), locales: new Map(), audio: new Map(), dialogues: new Map(), diagnostics: [],
  };
  const kernel = new Kernel({
    project, game: { components: [COLLIDER], resources: [], events: [], behaviors: [], systems: [] },
    plugins: [
      visuals({ dimension: '2d' }), environment(),
      ...(surface === undefined ? [] : [render2d({ surface, files: { list: () => [], read: () => '' }, assetFiles: true })]),
    ],
    context: {},
  });
  kernel.start('main');
  return kernel;
}

function lit2d(timeOfDay: number): Array<[number, number]> {
  const kernel = start(timeOfDay);
  const env = kernel.service(ENVIRONMENT_SERVICE).resolve();
  const lighting = lighting2d(kernel.world, new Placements(kernel.world), [0.1, 0.1, 0.1], env)!;
  return lighting.lights.map((l) => [l.x, l.intensity]);
}

describe('Light when', () => {
  it('the environment eases `night` from 0 by day to 1 at night, over dusk', () => {
    const night = (hour: number): number => start(hour).service(ENVIRONMENT_SERVICE).resolve().night!;
    expect(night(12)).toBe(0);
    expect(night(0)).toBe(1);
    expect(night(23)).toBe(1);
    const dusk = [17, 17.5, 18, 18.3, 18.6].map(night);
    expect(dusk[0]).toBe(0);
    for (let i = 1; i < dusk.length; i++) expect(dusk[i]!).toBeGreaterThan(dusk[i - 1]!);
    expect(dusk[2]!).toBeGreaterThan(0.2);
    expect(dusk[2]!).toBeLessThan(1);
    expect(dusk[4]).toBe(1);
  });

  it('lightShare: always 1; night the environment\'s night; day the rest; isNight without a night value; day without an environment', () => {
    const env = { isNight: true, night: 0.25 };
    expect(lightShare('always', env)).toBe(1);
    expect(lightShare(undefined, env)).toBe(1);
    expect(lightShare('night', env)).toBe(0.25);
    expect(lightShare('day', env)).toBe(0.75);
    expect(lightShare('night', { isNight: true })).toBe(1);
    expect(lightShare('day', { isNight: true })).toBe(0);
    expect(lightShare('night', undefined)).toBe(0);
    expect(lightShare('day', undefined)).toBe(1);
  });

  it('2D: a night light is left out by day and shines at night; a day light the reverse; lighting stays on', () => {
    expect(lit2d(12)).toEqual([[0, 1], [8, 1]]);
    expect(lit2d(0)).toEqual([[0, 1], [4, 2]]);
    // At dusk both fade: the street light part way in, the day light part way out.
    const dusk = lit2d(18);
    expect(dusk.map(([x]) => x)).toEqual([0, 4, 8]);
    expect(dusk[1]![1]).toBeGreaterThan(0);
    expect(dusk[1]![1]).toBeLessThan(2);
    expect(dusk[1]![1] / 2 + dusk[2]![1]).toBeCloseTo(1, 9);
  });

  it('2D: a scene whose only light is out still draws lit (ambient, no pools)', () => {
    const kernel = start(12);
    for (const record of [...kernel.world.live()]) {
      if (record.prefab !== 'streetlight') kernel.world.destroy(record.id);
    }
    kernel.step(1 / 60);
    const env = kernel.service(ENVIRONMENT_SERVICE).resolve();
    expect(lighting2d(kernel.world, new Placements(kernel.world), [0.1, 0.1, 0.1], env)).toEqual({ ambient: [0.1, 0.1, 0.1], lights: [] });
  });

  it('3D: lightOf scales the intensity by the share', () => {
    const record = { id: 1, prefab: 'streetlight', components: new Map() } as unknown as EntityRecord;
    const fields = { kind: 'point', color: Color.WHITE, intensity: 4, range: 5, angle: 45, shadows: false, when: 'night' } as unknown as Fields;
    const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 3, 4, 1];
    const at = { m } as unknown as Parameters<typeof lightOf>[2];
    expect(lightOf(record, fields, at).intensity).toBe(4);
    expect(lightOf(record, fields, at, lightShare('night', { isNight: false, night: 0.5 })).intensity).toBe(2);
  });
});

describe('2D post', () => {
  const settings = (over: Partial<PostSettings>): Pick<PostSettings, 'bloom' | 'bloomThreshold' | 'vignette'> =>
    ({ bloom: 0.25, bloomThreshold: 1, vignette: 0, ...over });

  it('is null when nothing would show: the default bloom (threshold 1) and no vignette', () => {
    expect(post2d(undefined)).toBeNull();
    expect(post2d(settings({}))).toBeNull();
    expect(post2d(settings({ bloom: 0, bloomThreshold: 0.5 }))).toBeNull();
  });

  it('carries bloom under a threshold below 1, and the vignette (clamped)', () => {
    expect(post2d(settings({ bloom: 0.8, bloomThreshold: 0.7 }))).toEqual({ bloom: 0.8, bloomThreshold: 0.7, vignette: 0 });
    expect(post2d(settings({ vignette: 0.4 }))).toEqual({ bloom: 0, bloomThreshold: 1, vignette: 0.4 });
    expect(post2d(settings({ bloom: 2, bloomThreshold: 0.6, vignette: 3 }))).toEqual({ bloom: 2, bloomThreshold: 0.6, vignette: 1 });
  });

  it('the 2D frame carries the scene\'s "post" bloom and vignette; none by default', () => {
    const plain = new RecordingSurface2d({ keep: 1 });
    start(12, undefined, plain).step(1 / 60);
    expect(plain.last!.post).toBeUndefined();
    const surface = new RecordingSurface2d({ keep: 1 });
    start(12, { bloom: 0.8, bloom_threshold: 0.7, vignette: 0.3 }, surface).step(1 / 60);
    expect(surface.last!.post).toEqual({ bloom: 0.8, bloomThreshold: 0.7, vignette: 0.3 });
  });
});
