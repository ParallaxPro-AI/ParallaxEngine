import { describe, expect, it } from 'vitest';
import { Color, ParallaxError, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import type { JsonObject, Placement, PrefabDoc, Project, SceneDoc } from '../../../resource/index.js';
import { Kernel, t } from '../../kernel/index.js';
import type { GameDefinition, SystemDef } from '../../kernel/index.js';
import { ENVIRONMENT_SERVICE } from '../../services/index.js';
import { visuals } from '../visuals/index.js';
import { DAY_CHANGED, environment, readEnvironmentSpec } from './index.js';
import type { EnvironmentPlugin } from './index.js';

const ORIGIN = { path: 'x', pointer: '' };

function sceneDoc(id: string, environmentBlock: JsonObject | undefined, entities: Placement[] = []): SceneDoc {
  return {
    id, path: `scenes/${id}/scene.json`, tags: [], ui: [], init: {}, entities, regions: new Map(), plugins: {},
    ...(environmentBlock !== undefined && { environment: environmentBlock }),
  };
}

function placement(prefab: string, at: number[], components: Record<string, JsonObject> = {}): Placement {
  return { prefab, at, components, tags: [], params: {}, origin: ORIGIN };
}

function prefab(id: string, components: Record<string, JsonObject>): PrefabDoc {
  return { id, feature: undefined, path: `prefabs/${id}.prefab.json`, components, tags: [], behaviors: [], children: [] };
}

function project(scenes: SceneDoc[], prefabs: PrefabDoc[] = []): Project {
  return {
    prefabs: new Map(prefabs.map((p) => [p.id, p])), scenes: new Map(scenes.map((s) => [s.id, s])), config: new Map(),
    content: new Map(), locales: new Map(), audio: new Map(), dialogues: new Map(), diagnostics: [],
  };
}

/** physics3d's collider isn't built yet: its SDK fields, which visuals reads for zone volumes. */
const COLLIDER = {
  id: 'collider',
  schema: {
    shape: t.string({ default: 'box' }), size: t.vec3({ default: Vec3.ONE }), radius: t.number({ default: 0.5 }),
    height: t.number({ default: 1 }), offset: t.vec3({ default: Vec3.ZERO }), trigger: t.bool({ default: false }),
  },
};

const days: number[] = [];
const listener: SystemDef = {
  id: 'listener', scenes: [], handlers: [{ event: DAY_CHANGED, method: 'on_day' }],
  create: () => ({ on_day: (_ctx: unknown, e: { day: number }) => days.push(e.day) }),
};

function game(): GameDefinition {
  return { components: [COLLIDER], resources: [], events: [], behaviors: [], systems: [listener] };
}

function start(scenes: SceneDoc[], first: string, prefabs: PrefabDoc[] = []): { kernel: Kernel; env: EnvironmentPlugin } {
  const env = environment();
  const kernel = new Kernel({ project: project(scenes, prefabs), game: game(), plugins: [visuals({ dimension: '3d' }), env], context: {} });
  kernel.start(first);
  return { kernel, env };
}

function code(fn: () => unknown): string {
  try { fn(); } catch (e) { if (e instanceof ParallaxError) return e.diagnostic.code; throw e; }
  return 'no error';
}

const near = (a: Color, b: Color): boolean => Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) < 1e-6;

describe('environment block', () => {
  it('reads every shape the examples author', () => {
    const spec = readEnvironmentSpec(sceneDoc('a', {
      sky: 'atmosphere', time_of_day: 17.5, sun: { direction: [0.4, -0.7, 0.3], color: '#ffebcc', intensity: 3.2 }, ambient: '#21222a',
      fog: { density: 0.0012, color: '#8fadb5' }, post: { bloom: 1.3, preset: 'cyberpunk_neon' }, day_length: 720,
    }));
    expect(spec).toMatchObject({ sky: 'atmosphere', timeOfDay: 17.5, dayLength: 720, sunIntensity: 3.2, post: { preset: 'cyberpunk_neon', fields: { bloom: 1.3 } } });
    expect(spec.sunDirection!.length()).toBeCloseTo(1);
    const linear = readEnvironmentSpec(sceneDoc('b', { ambient: [0.55, 0.6, 0.7], fog: { near: 55, far: 125, color: [0.5, 0.55, 0.65] } }));
    expect(linear.fog).toMatchObject({ density: 0, near: 55, far: 125 });
    expect(readEnvironmentSpec(sceneDoc('c', undefined)).sky).toBe('clear_day');
  });

  it('rejects bad blocks with coded diagnostics and fixes', () => {
    const fails = (block: JsonObject): ParallaxError => {
      try { readEnvironmentSpec(sceneDoc('s', block)); } catch (e) { return e as ParallaxError; }
      throw new Error('accepted');
    };
    expect(fails({ skye: 'night' }).diagnostic).toMatchObject({ code: 'PP3220', pointer: '/environment/skye' });
    expect(fails({ sky: 'nigth' }).diagnostic).toMatchObject({ code: 'PP3221', pointer: '/environment/sky' });
    expect(fails({ sky: 'nigth' }).diagnostic.fix).toContain('"night"');
    expect(fails({ sky: 'storm' }).diagnostic).toMatchObject({ code: 'PP3221', pointer: '/environment/sky' });
    expect(fails({ sky: 'storm' }).diagnostic.fix).toContain('"weather": "storm"');
    expect(fails({ time_of_day: 25 }).diagnostic.pointer).toBe('/environment/time_of_day');
    expect(fails({ fog: { near: 5 } }).diagnostic.pointer).toBe('/environment/fog');
    expect(fails({ fog: { density: 0.1, near: 1, far: 2 } }).diagnostic.code).toBe('PP3220');
    expect(fails({ fog: { color: '#fff' } }).diagnostic.pointer).toBe('/environment/fog');
    expect(fails({ ambient: 'teal' }).diagnostic.pointer).toBe('/environment/ambient');
    expect(fails({ sun: { direction: [0, 0, 0] } }).diagnostic.pointer).toBe('/environment/sun/direction');
    expect(fails({ post: { glow: 1 } }).diagnostic.pointer).toBe('/environment/post/glow');
    const preset = fails({ post: { preset: 'nior' } }).diagnostic;
    expect(preset.pointer).toBe('/environment/post/preset');
    expect(preset.fix).toContain('"noir"');
    expect(() => readEnvironmentSpec(sceneDoc('s', { post: { preset: 'cyberpunk_neon' } }))).not.toThrow();
    expect(fails({ post: { vignette: 2 } }).diagnostic.pointer).toBe('/environment/post/vignette');
    expect(fails({ post: { stylize: { posterize: 3.5 } } }).diagnostic.code).toBe('PP3220');
    expect(fails({ post: { stylize: { edge_color: 'ink' } } }).diagnostic.pointer).toBe('/environment/post/stylize/edge_color');
    const outside = fails({ post: { pixelate: 3 } }).diagnostic;
    expect(outside.pointer).toBe('/environment/post/pixelate');
    expect(outside.fix).toContain('"stylize"');
    const wire = fails({ post: { mode: 'wireframe' } }).diagnostic;
    expect(wire.pointer).toBe('/environment/post/mode');
    expect(wire.fix).toContain('"debug"');
    expect(fails({ debug: { wireframe: 'yes' } }).diagnostic.pointer).toBe('/environment/debug/wireframe');
    expect(fails({ fog: { density: 0.01, volumetric: 1.5 } }).diagnostic.pointer).toBe('/environment/fog');
  });

  it('reads every post setting and fog volumetric', () => {
    const spec = readEnvironmentSpec(sceneDoc('p', {
      fog: { density: 0.01, volumetric: 0.6 },
      post: {
        preset: 'toon', exposure: 1.5, bloom: 0.4, bloom_threshold: 0.8, saturation: 1.2, contrast: 1.1, tint: '#ffeedd', vignette: 0.3,
        chromatic_aberration: 0.002, ambient_occlusion: 0.5, reflections: false, god_rays: 0.7, antialias: false,
        stylize: { pixelate: 3, posterize: 6, toon: 4, edges: 2, edge_color: [0.1, 0, 0] },
      },
      debug: { wireframe: true, wire_color: '#00ff66', wire_background: null },
    }));
    expect(spec.fog.volumetric).toBe(0.6);
    expect(spec.post.preset).toBe('toon');
    expect(Object.keys(spec.post.fields)).toHaveLength(17);
    expect(spec.post.fields).toMatchObject({ pixelate: 3, posterize: 6, reflections: false, godRays: 0.7 });
    expect(spec.debug).toMatchObject({ wireframe: true, wireBackground: null });
  });
});

describe('environment block: height fog, white balance, grain, skybox', () => {
  const fails = (block: JsonObject): ParallaxError => {
    try {
      readEnvironmentSpec(sceneDoc('s', block));
    } catch (error) {
      return error as ParallaxError;
    }
    throw new Error('expected a failure');
  };

  it('reads height fog and refuses it on linear fog', () => {
    const spec = readEnvironmentSpec(sceneDoc('h', { fog: { density: 0.02, height_falloff: 0.1, height: 4 } }));
    expect(spec.fog).toMatchObject({ density: 0.02, heightFalloff: 0.1, height: 4 });
    expect(readEnvironmentSpec(sceneDoc('u', { fog: { density: 0.02 } })).fog).toMatchObject({ heightFalloff: 0, height: 0 });
    expect(fails({ fog: { near: 5, far: 50, height_falloff: 0.1 } }).diagnostic.pointer).toBe('/environment/fog');
    expect(fails({ fog: { density: 0.01, height_falloff: -1 } }).diagnostic.pointer).toBe('/environment/fog');
  });

  it('reads temperature and grain as post settings', () => {
    const spec = readEnvironmentSpec(sceneDoc('g', { post: { temperature: 0.2, grain: 0.3 } }));
    expect(spec.post.fields).toMatchObject({ temperature: 0.2, grain: 0.3 });
    expect(fails({ post: { temperature: 2 } }).diagnostic.pointer).toBe('/environment/post/temperature');
  });

  it('reads a skybox: a project image, a hosted URL (canonical), or an object', () => {
    expect(readEnvironmentSpec(sceneDoc('a', { skybox: 'images/sky' })).skybox).toEqual({ texture: 'images/sky', rotation: 0, intensity: 1 });
    const hosted = readEnvironmentSpec(sceneDoc('b', { skybox: { texture: 'https://parallaxpro.ai/assets/sky/ab/x.jpg', rotation: 90, intensity: 1.5 } })).skybox;
    expect(hosted).toEqual({ texture: 'https://r2.parallaxpro.ai/assets/sky/ab/x.jpg', rotation: 90, intensity: 1.5 });
    expect(readEnvironmentSpec(sceneDoc('c', {})).skybox).toBeNull();
    expect(fails({ skybox: 'https://example.com/sky.jpg' }).diagnostic.pointer).toBe('/environment/skybox');
    expect(fails({ skybox: 'assets/models/sky.glb' }).diagnostic.pointer).toBe('/environment/skybox');
    expect(fails({ skybox: { texture: 'images/sky', spin: 1 } }).diagnostic.pointer).toBe('/environment/skybox/spin');
  });

  it('resolves the skybox and hides the stars behind it', () => {
    const { kernel } = start([sceneDoc('a', { sky: 'night', skybox: 'images/sky' })], 'a');
    const r = kernel.service(ENVIRONMENT_SERVICE).resolve();
    expect(r.skybox).toEqual({ texture: 'images/sky', rotation: 0, intensity: 1 });
    expect(r.stars).toBe(0);
  });
});

describe('environment plugin', () => {
  it('resolves the scene block, with preset defaults where it is silent', () => {
    const { kernel } = start([sceneDoc('bay', { sky: 'dusk', time_of_day: 19, fog: { density: 0.003, color: '#5b4a5e' } })], 'bay');
    const look = kernel.service(ENVIRONMENT_SERVICE).resolve();
    expect(look).toMatchObject({ sky: 'dusk', timeOfDay: 19, isNight: true, day: 0 });
    expect(look.fog).toMatchObject({ density: 0.003, near: null, far: null });
    expect(near(look.fog.color, Color.hex('#5b4a5e'))).toBe(true);
    expect(near(look.ambient, Color.hex('#4a4058'))).toBe(true);
    expect(look.sunDirection.y).toBeLessThan(0);
    expect(look.clear).toBe(look.horizon);
  });

  it('a fixed sun direction wins; otherwise the hour moves the sun east to west, light always from above', () => {
    const fixed = start([sceneDoc('s', { sun: { direction: [0, -1, 0] } })], 's').kernel.service(ENVIRONMENT_SERVICE).resolve();
    expect(fixed.sunDirection).toEqual(new Vec3(0, -1, 0));
    const { kernel, env } = start([sceneDoc('s', { time_of_day: 7 })], 's');
    const service = kernel.service(ENVIRONMENT_SERVICE);
    const morning = service.resolve().sunDirection;
    env.control().timeOfDay = 17;
    const evening = service.resolve().sunDirection;
    expect(morning.x).toBeLessThan(0); // light travels west in the morning
    expect(evening.x).toBeGreaterThan(0);
    env.control().timeOfDay = 23;
    expect(service.resolve().sunDirection.y).toBeLessThan(0);
  });

  it('the day cycle advances time, counts days at dawn and fires DayChanged', () => {
    days.length = 0;
    const { kernel, env } = start([sceneDoc('g', { sky: 'clear_day', time_of_day: 21, day_length: 240, sun: { intensity: 2 } })], 'g');
    const control = env.control();
    const service = kernel.service(ENVIRONMENT_SERVICE);
    expect(control.isNight).toBe(true);
    const night = service.resolve();
    // 240 s per day: 10 s per hour. 21:00 → 06:00 is 90 s.
    for (let i = 0; i < 60 * 89; i++) kernel.step(1 / 60);
    expect(control.day).toBe(0);
    for (let i = 0; i < 120; i++) kernel.step(1 / 60);
    expect(control.day).toBe(1);
    expect(days).toEqual([1]);
    expect(control.timeOfDay).toBeCloseTo(6.1, 1);
    for (let i = 0; i < 60 * 60; i++) kernel.step(1 / 60);
    const noon = service.resolve();
    expect(control.isNight).toBe(false);
    expect(noon.sunIntensity).toBeGreaterThan(night.sunIntensity * 5);
    expect(noon.zenith.b).toBeGreaterThan(night.zenith.b);
    // A whole day per step still counts every dawn.
    kernel.step(0); control.dayLength = 1;
    kernel.step(2.05);
    expect(control.day).toBeGreaterThanOrEqual(3);
  });

  it('without day_length, time stands still and setting it fires nothing', () => {
    days.length = 0;
    const { kernel, env } = start([sceneDoc('s', { time_of_day: 5 })], 's');
    for (let i = 0; i < 300; i++) kernel.step(1 / 60);
    expect(env.control().timeOfDay).toBe(5);
    env.control().timeOfDay = 8;
    kernel.step(1 / 60);
    expect(days).toEqual([]);
    expect(code(() => { env.control().timeOfDay = 30; })).toBe('PP3223');
    expect(code(() => { env.control().day = 1.5; })).toBe('PP3223');
    expect(code(() => { env.control().dayLength = -1; })).toBe('PP3223');
  });

  it('fog() and sky() blend over their seconds from where the look was', () => {
    const { kernel, env } = start([sceneDoc('s', { sky: 'clear_day', fog: { density: 0.01, color: '#000000' } })], 's');
    const service = kernel.service(ENVIRONMENT_SERVICE);
    env.control().fog({ density: 0.03, color: Color.WHITE, seconds: 2 });
    env.control().sky('night', 2);
    kernel.step(1);
    const half = service.resolve();
    expect(half.fog.density).toBeCloseTo(0.02, 4);
    expect(half.fog.color.r).toBeCloseTo(0.5, 2);
    expect(half.sky).toBe('night');
    kernel.step(1.5);
    const done = service.resolve();
    expect(done.fog.density).toBeCloseTo(0.03);
    expect(near(done.zenith, Color.hex('#050812'))).toBe(true);
    env.control().fog({ near: 10, far: 50, seconds: 0 });
    expect(service.resolve().fog).toMatchObject({ density: 0, near: 10, far: 50 });
    expect(code(() => env.control().fog({ seconds: 1 }))).toBe('PP3222');
    expect(code(() => env.control().fog({ near: 10, seconds: 1 }))).toBe('PP3222');
    expect(code(() => env.control().sky('sunny', 1))).toBe('PP3221');
  });

  it('EnvironmentZone overrides blend in by their weight as the camera enters', () => {
    const prefabs = [
      prefab('cam', { camera: {} }),
      prefab('squall', {
        collider: { shape: 'box', size: [20, 20, 20], trigger: true },
        environment_zone: { fog_density: 0.02, fog_color: '#ffffff', ambient: '#000000', sky_tint: '#000000', blend: 2 },
      }),
    ];
    const scene = sceneDoc('sea', { sky: 'clear_day', fog: { density: 0.0, near: 10, far: 100, color: '#000000' }, ambient: '#ffffff' }, [
      placement('cam', [100, 0, 0]),
      placement('squall', [0, 0, 0]),
    ]);
    const { kernel } = start([scene], 'sea', prefabs);
    const service = kernel.service(ENVIRONMENT_SERVICE);
    kernel.step(1 / 60);
    const outside = service.resolve();
    expect(outside.fog.density).toBe(0);
    let camera: EntityId | undefined;
    for (const record of kernel.world.live()) if (record.components.has('camera')) camera = record.id;
    kernel.world.require(camera!).transform.position = new Vec3(0, 0, 0);
    kernel.step(1);
    const half = service.resolve();
    expect(half.fog.density).toBeGreaterThan(0.008);
    expect(half.fog.density).toBeLessThan(0.012);
    expect(half.ambient.r).toBeGreaterThan(0.4);
    expect(half.ambient.r).toBeLessThan(0.6);
    expect(half.fog.near).toBe(10);
    kernel.step(1.5);
    const full = service.resolve();
    expect(full.fog.density).toBeCloseTo(0.02);
    expect(near(full.ambient, Color.BLACK)).toBe(true);
    expect(near(full.zenith, Color.BLACK)).toBe(true);
  });

  it('scene loads apply the new block, keep the day, and new_run=True zeroes it', () => {
    const { kernel, env } = start([sceneDoc('a', { time_of_day: 10 }), sceneDoc('b', { sky: 'night' })], 'a');
    env.control().day = 4;
    env.control().fog({ density: 0.5, seconds: 0 });
    kernel.requestScene('b');
    kernel.step(1 / 60);
    const look = kernel.service(ENVIRONMENT_SERVICE).resolve();
    expect(look).toMatchObject({ sky: 'night', timeOfDay: 12, day: 4 });
    expect(look.fog.density).toBe(0);
    kernel.requestScene('a', { newRun: true });
    kernel.step(1 / 60);
    expect(env.control().day).toBe(0);
  });

  it('snapshots and saves carry the run state', () => {
    const { kernel, env } = start([sceneDoc('a', { time_of_day: 10, day_length: 100 })], 'a');
    env.control().day = 2;
    env.control().fog({ density: 0.05, seconds: 4 });
    kernel.step(1);
    const snapshot = kernel.snapshot();
    const before = kernel.service(ENVIRONMENT_SERVICE).resolve();
    kernel.step(3);
    env.control().day = 9;
    kernel.restore(snapshot);
    const after = kernel.service(ENVIRONMENT_SERVICE).resolve();
    expect(after.timeOfDay).toBe(before.timeOfDay);
    expect(after.day).toBe(2);
    expect(after.fog.density).toBeCloseTo(before.fog.density, 10);

    const service = kernel.service(ENVIRONMENT_SERVICE);
    const saved = service.persist();
    expect(saved).toMatchObject({ day: 2, day_length: 100, sky: null });
    const other = start([sceneDoc('a', { time_of_day: 10, day_length: 100 })], 'a').kernel.service(ENVIRONMENT_SERVICE);
    other.load(JSON.parse(JSON.stringify(saved)));
    expect(other.persist()).toEqual(saved);
    expect(code(() => other.load({ hour: 3 }))).toBe('PP3224');
  });

  it('post settings: preset, scene fields, then the runtime layer; numbers blend over seconds', () => {
    const { kernel, env } = start([sceneDoc('a', { post: { preset: 'noir', bloom: 0.5 } })], 'a');
    const service = kernel.service(ENVIRONMENT_SERVICE);
    expect(service.resolve().post).toMatchObject({ preset: 'noir', saturation: 0, bloom: 0.5, ambientOcclusion: 1 });
    // Fields alone override the scene's look.
    env.control().post({ fields: { vignette: 0.8 }, seconds: 0 });
    expect(service.resolve().post).toMatchObject({ preset: 'noir', bloom: 0.5, vignette: 0.8 });
    // A preset replaces the look (the scene's fields go with it), blending over its seconds.
    env.control().post({ preset: 'dreamy', fields: {}, seconds: 2 });
    kernel.step(1);
    const halfway = service.resolve().post;
    expect(halfway.bloom).toBeLessThan(0.5);
    expect(halfway.bloom).toBeGreaterThan(0.15);
    kernel.step(1.5);
    expect(service.resolve().post).toMatchObject({ preset: 'dreamy', bloom: 0.15, saturation: 1.1 });
    // Saved and snapshotted.
    const saved = service.persist();
    expect(saved['post']).toMatchObject({ preset: 'dreamy' });
    const snapshot = kernel.snapshot();
    env.control().post({ fields: {}, seconds: 0 });
    expect(service.resolve().post).toMatchObject({ preset: 'noir', bloom: 0.5 });
    kernel.restore(snapshot);
    expect(service.resolve().post.preset).toBe('dreamy');
    expect(code(() => env.control().post({ fields: { glow: 1 }, seconds: 0 }))).toBe('PP3226');
    expect(code(() => env.control().post({ preset: 'nior', fields: {}, seconds: 0 }))).toBe('PP3226');
  });

  it('fog(volumetric=) changes the scattering and keeps the rest', () => {
    const { kernel, env } = start([sceneDoc('a', { fog: { density: 0.02 } })], 'a');
    env.control().fog({ volumetric: 0.7, seconds: 0 });
    expect(kernel.service(ENVIRONMENT_SERVICE).resolve().fog).toMatchObject({ density: 0.02, volumetric: 0.7 });
  });
});
