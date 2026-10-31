/**
 * 3D effects beyond plain particles: the extended .vfx.json format, the built-in presets,
 * sub-emitters, lights, hazes, sounds and shakes, and ribbons (trails, beams, lightning).
 */

import { describe, expect, it } from 'vitest';
import { BUILTIN_EFFECTS, PARTICLE3D_STRIDE, ParallaxError, RIBBON_STRIDE, Vec3 } from '../../../core/index.js';
import type { EntityId, Frame3d, ProjectFiles } from '../../../core/index.js';
import { AssetCatalog, loadProject } from '../../../resource/index.js';
import { Kernel } from '../../kernel/index.js';
import type { GameDefinition, KernelPlugin } from '../../kernel/index.js';
import { AUDIO_SERVICE } from '../../services/index.js';
import type { PluginSound } from '../../services/index.js';
import { MemoryBinaryFiles, RecordingSurface3d } from '../../../platform/headless/render3d.js';
import { visuals } from '../visuals/index.js';
import { models } from '../models/index.js';
import { render3d } from './index.js';
import type { Render3dPlugin } from './index.js';
import { EffectLibrary, parseEffect } from './effects.js';
import { EFFECT_PRESETS } from './effect_presets.js';
import { FIRE_FLIPBOOK, SMOKE_FLIPBOOK } from './flipbook.js';
import { ParticleSystem3d } from './particles.js';
import type { EmitterSource } from './particles.js';
import { lightningRibbons, smoothPath, trailRibbon } from './ribbons.js';

const DT = 1 / 60;

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof ParallaxError) return e.diagnostic.code;
    throw e;
  }
  return 'no error';
}

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, typeof v === 'string' ? v : JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

const catalog = (extra: Record<string, unknown> = {}): AssetCatalog => new AssetCatalog(files({ 'assets/images/puff.png': '', ...extra }));
const parse = (doc: unknown, extra: Record<string, unknown> = {}): ReturnType<typeof parseEffect> =>
  parseEffect('assets/vfx/x.vfx.json', JSON.stringify(doc), catalog(extra));

describe('the 3D effect format', () => {
  it('parses every built-in effect, and only those names are built in', () => {
    expect(Object.keys(EFFECT_PRESETS).sort()).toEqual([...BUILTIN_EFFECTS].sort());
    const library = new EffectLibrary(catalog());
    for (const name of BUILTIN_EFFECTS) {
      const def = library.get(`effect/${name}`, 'test');
      expect(def.path).toBe(`effect/${name}`);
    }
    const boom = library.get('effect/explosion', 'test');
    expect(boom.flipbook).toBe('fire');
    expect(boom.blend).toBe('additive');
    expect(boom.light!.seconds).toBeGreaterThan(0);
    expect(boom.shake).not.toBeNull();
    expect(boom.haze!.ring).toBeGreaterThan(0);
    expect(boom.children.map((c) => c.def!.path)).toEqual(['effect/explosion#children.0', 'effect/explosion#children.1', 'effect/explosion#children.2', 'effect/explosion#children.3']);
    expect(library.get('effect/explosion#children.1', 'test').flipbook).toBe('smoke');
    expect(library.get('effect/explosion#children.1', 'test').lit).toBe(true);
    expect(code(() => library.get('effect/nope', 'test'))).toBe('PP2063');
  });

  it('reads the look keys with their defaults', () => {
    const plain = parse({ burst: 4, size: 0.4 });
    expect(plain).toMatchObject({ blend: 'alpha', shape: 'circle', flipbook: null, frames: [1, 1], facing: 'camera', stretch: 0, soft: 0.2, lit: false, intensity: 1 });
    const sparks = parse({ burst: 4, facing: 'velocity', blend: 'additive', shape: 'glow' });
    expect(sparks.stretch).toBe(0.05);
    const sheet = parse({ rate: 4, image: 'images/puff', frames: [4, 2], fade_in: 0.2, angle: [0, 360] });
    expect(sheet).toMatchObject({ image: 'assets/images/puff.png', frames: [4, 2], fadeIn: 0.2, angle: { lo: 0, hi: 360 } });
    expect(parse({ rate: 4, flipbook: 'smoke' })).toMatchObject({ frames: [8, 8], lit: true, blend: 'alpha' });
    expect(parse({ rate: 4, flipbook: 'fire' })).toMatchObject({ blend: 'additive', lit: false });
  });

  it('reports bad look keys, a frames without an image, both image and flipbook, and a malformed sound', () => {
    expect(code(() => parse({ burst: 1, blend: 'screen' }))).toBe('PP3808');
    expect(code(() => parse({ burst: 1, shape: 'star' }))).toBe('PP3808');
    expect(code(() => parse({ burst: 1, frames: [4, 4] }))).toBe('PP3808');
    expect(code(() => parse({ burst: 1, image: 'images/puff', frames: [0, 4] }))).toBe('PP3808');
    expect(code(() => parse({ burst: 1, image: 'images/puff', flipbook: 'fire' }))).toBe('PP3808');
    expect(code(() => parse({ burst: 1, sound: 'boom.ogg' }))).toBe('PP3808');
    expect(code(() => parse({ burst: 1, light: { color: '#fff', glow: 2 } }))).toBe('PP3808');
    expect(parse({ burst: 1, sound: 'sfx/boom' }).sound).toBe('sfx/boom');
  });

  it('extends another effect: its keys, overridden by the file\'s; a built-in; a circle is reported', () => {
    const own = parse({ extends: 'vfx/base', color: '#ff0000' }, { 'assets/vfx/base.vfx.json': { burst: 7, color: '#00ff00', size: 2 } });
    expect(own).toMatchObject({ burst: 7, size: { lo: 2, hi: 2 }, color: [1, 0, 0, 1] });
    const boom = parse({ extends: 'effect/explosion', sound: 'sfx/boom', shake: null });
    expect(boom).toMatchObject({ flipbook: 'fire', sound: 'sfx/boom', shake: null });
    expect(boom.children).toHaveLength(4);
    expect(code(() => parse({ extends: 'effect/nope' }))).toBe('PP3808');
    const loop = { 'assets/vfx/a.vfx.json': { extends: 'vfx/b' }, 'assets/vfx/b.vfx.json': { extends: 'vfx/a' } };
    expect(code(() => parseEffect('assets/vfx/a.vfx.json', JSON.stringify({ extends: 'vfx/b' }), catalog(loop)))).toBe('PP3808');
  });

  it('a composite needs no particles of its own: children or a light are enough', () => {
    expect(parse({ children: ['effect/sparks'] }).children[0]).toMatchObject({ ref: 'effect/sparks', def: null, delay: 0, scale: 1 });
    expect(parse({ light: { intensity: 5 } }).light).toMatchObject({ intensity: 5, range: 6, seconds: 0.25 });
    expect(code(() => parse({}))).toBe('PP3808');
    expect(code(() => parse({ children: [{ delay: 1 }] }))).toBe('PP3808');
    expect(code(() => parse({ children: ['vfx/missing'] }))).toBe('PP2063');
  });
});

/** A particle system over a project's effects, stepped with every attached emitter at the origin, emitting. */
function system(extra: Record<string, unknown>, seed = 7): { ps: ParticleSystem3d; step: (n: number) => void } {
  const ps = new ParticleSystem3d(new EffectLibrary(catalog(extra)));
  ps.reset(seed);
  const source = (): EmitterSource => ({ position: [0, 0, 0], emitting: true, rateScale: 1 });
  return { ps, step: (n) => { for (let i = 0; i < n; i++) ps.step(DT, source); } };
}

const at = (x = 0, y = 0, z = 0) => ({ position: [x, y, z] as const, color: null, scale: 1, direction: null });

describe('the 3D particle system', () => {
  it('plays children after their delay, offset and scaled with the shot', () => {
    const { ps, step } = system({
      'assets/vfx/boom.vfx.json': { burst: 2, lifetime: 2, speed: 0, children: [{ effect: { burst: 5, lifetime: 2, speed: 0 }, delay: 0.1, offset: [0, 1, 0], scale: 2 }] },
    });
    ps.play('vfx/boom', { ...at(3, 0, 0), scale: 2 }, 'test');
    step(1);
    expect(ps.liveParticles).toBe(2);
    step(6);
    expect(ps.liveParticles).toBe(7);
    const child = ps.draws().find((d) => d.count === 5)!;
    // At (3, 0, 0) + offset × shot scale; sizes × shot scale × child scale.
    expect([child.data[0], child.data[1], child.data[2]]).toEqual([3, 2, 0]);
    expect(child.data[3]).toBeCloseTo(0.15 * 4);
    expect(ps.takeEvents().map((e) => e.def.path)).toEqual(['assets/vfx/boom.vfx.json', 'assets/vfx/boom.vfx.json#children.0']);
  });

  it('play count= sets the effect\'s own particles (children keep theirs); color_end= reaches the children', () => {
    const { ps, step } = system({
      'assets/vfx/pop.vfx.json': { burst: 20, lifetime: 2, speed: 0, color: '#ff0000', children: [{ effect: { burst: 5, lifetime: 2, speed: 0 } }] },
    });
    ps.play('vfx/pop', { ...at(), count: 4, colorEnd: [0, 0, 1, 1] }, 'test');
    step(1);
    expect(ps.liveParticles).toBe(9);
    expect(ps.snapshot().emitters.map((e) => [e.amount, e.overrideEnd])).toEqual([[0.2, [0, 0, 1, 1]], [undefined, [0, 0, 1, 1]]]);
  });

  it('plays on_death where particles die, by chance from the seeded generator', () => {
    const effects = {
      'assets/vfx/firework.vfx.json': { burst: 6, lifetime: 0.1, speed: 3, on_death: { effect: { burst: 3, lifetime: 1, speed: 0 } } },
      'assets/vfx/maybe.vfx.json': { burst: 200, lifetime: 0.1, speed: 0, on_death: { effect: { burst: 1, lifetime: 1 }, chance: 0.25 } },
    };
    const { ps, step } = system(effects);
    ps.play('vfx/firework', at(), 'test');
    step(10);
    expect(ps.liveParticles).toBe(18);
    const one = system(effects, 3);
    one.ps.play('vfx/maybe', at(), 'test');
    one.step(10);
    expect(one.ps.liveParticles).toBeGreaterThan(25);
    expect(one.ps.liveParticles).toBeLessThan(80);
  });

  it('snapshots and restores children, deaths and turbulence exactly', () => {
    const { ps, step } = system({
      'assets/vfx/storm.vfx.json': {
        rate: 30, lifetime: [0.2, 0.6], speed: [1, 3], turbulence: 4, angle: [0, 90],
        on_death: { effect: { burst: 2, lifetime: 0.3, turbulence: 2 }, chance: 0.5 },
      },
      'assets/vfx/boom.vfx.json': { extends: 'effect/explosion' },
    });
    ps.attach(1 as EntityId, 'vfx/storm', 'test');
    ps.play('vfx/boom', at(0, 1, 0), 'test');
    step(20);
    const saved = JSON.parse(JSON.stringify(ps.snapshot()));
    step(25);
    const later = ps.draws().map((d) => [...d.data]);
    ps.restore(saved, () => true);
    step(25);
    expect(ps.draws().map((d) => [...d.data])).toEqual(later);
  });

  it('lights: a one-shot flash fades out over its seconds; a continuous emitter glows while it emits', () => {
    const { ps, step } = system({
      'assets/vfx/flash.vfx.json': { burst: 1, lifetime: 5, light: { color: '#ff8000', intensity: 10, range: 4, seconds: 0.5 } },
      'assets/vfx/torch.vfx.json': { rate: 5, light: { intensity: 3, flicker: 0.5 } },
    });
    ps.play('vfx/flash', { ...at(1, 2, 3), scale: 2 }, 'test');
    step(1);
    const [flash] = ps.lights();
    expect(flash).toMatchObject({ position: [1, 2, 3], range: 8, entity: null });
    expect(flash!.intensity).toBeGreaterThan(9);
    step(15);
    expect(ps.lights()[0]!.intensity).toBeLessThan(3);
    step(20);
    expect(ps.lights()).toEqual([]);
    ps.attach(4 as EntityId, 'vfx/torch', 'test');
    step(30);
    const torch = ps.lights().find((l) => l.entity === 4)!;
    expect(torch.intensity).toBeGreaterThan(1.4);
    expect(torch.intensity).toBeLessThanOrEqual(3);
  });

  it('hazes: a shockwave ring grows and weakens; the emitter outlives its particles until it ends', () => {
    const { ps, step } = system({ 'assets/vfx/wave.vfx.json': { burst: 1, lifetime: 0.05, haze: { radius: 6, ring: 0.3, seconds: 0.5 } } });
    ps.play('vfx/wave', at(), 'test');
    step(3);
    const early = ps.hazes()[0]!;
    step(12);
    const late = ps.hazes()[0]!;
    expect(late.radius).toBeGreaterThan(early.radius);
    expect(late.strength).toBeLessThan(early.strength);
    expect(late.ring).toBe(0.3);
    step(20);
    expect(ps.hazes()).toEqual([]);
  });

  it('draws velocity-facing particles with their stretch, fades in, sorts alpha particles back to front', () => {
    const { ps, step } = system({
      'assets/vfx/spark.vfx.json': { burst: 1, lifetime: 1, speed: 10, direction: 0, spread: 0, facing: 'velocity', stretch: 0.1 },
      'assets/vfx/puff.vfx.json': { burst: 30, lifetime: 1, speed: [0, 5], fade_in: 0.5, color: '#ffffff' },
    });
    ps.play('vfx/spark', at(), 'test');
    ps.play('vfx/puff', at(), 'test');
    step(6);
    const draws = ps.draws([0, 0, -20]);
    const spark = draws.find((d) => d.def.facing === 'velocity')!;
    expect(spark.data[10]).toBeCloseTo(1, 1);
    expect(spark.data[11]).toBeCloseTo(0);
    // Emitted on the first step, moved on the next five.
    expect(spark.data[13]).toBeCloseTo(5 / 60);
    const puff = draws.find((d) => d.def.fadeIn > 0)!;
    // Fading in: alpha is the life fraction over fade_in.
    expect(puff.data[9]).toBeCloseTo(5 / 60 / 0.5);
    const distance = (i: number): number => Math.hypot(puff.data[i * PARTICLE3D_STRIDE]!, puff.data[i * PARTICLE3D_STRIDE + 1]!, puff.data[i * PARTICLE3D_STRIDE + 2]! + 20);
    for (let i = 1; i < puff.count; i++) expect(distance(i)).toBeLessThanOrEqual(distance(i - 1) + 1e-9);
  });
});

describe('ribbons', () => {
  it('smooths a path through its points', () => {
    const smooth = smoothPath([0, 0, 0, 1, 1, 0, 2, 0, 0], 4);
    expect(smooth).toHaveLength(9 * 3);
    expect(smooth.slice(12, 15)).toEqual([1, 1, 0]);
    expect(smooth.slice(-3)).toEqual([2, 0, 0]);
  });

  it('a trail tapers and fades to its tail', () => {
    const r = trailRibbon([0, 0, 0, 0, 1, 0, 0, 0.1, 2, 0, 0, 0.2], { width: 0.4, color: [1, 1, 1, 1], glow: true }, 3)!;
    const n = r.points.length / RIBBON_STRIDE;
    expect(r.points[3]).toBeCloseTo(0.1);
    expect(r.points[7]).toBe(0);
    expect(r.points[(n - 1) * RIBBON_STRIDE + 3]).toBeCloseTo(0.4);
    expect(r.points[(n - 1) * RIBBON_STRIDE + 7]).toBe(1);
    expect(r).toMatchObject({ blend: 'additive', entity: 3 });
  });

  it('a lightning bolt runs from start to end with its forks, the same for the same seed, re-struck over time', () => {
    const bolt = { start: [0, 10, 0] as const, end: [0, 0, 0] as const, width: 0.1, color: [1, 1, 1, 1] as const, branches: 3, seed: 42, seconds: 0.5, age: 0 };
    const a = lightningRibbons(bolt);
    expect(a).toHaveLength(4);
    const main = a[0]!.points;
    expect([main[0], main[1], main[2]]).toEqual([0, 10, 0]);
    const last = main.length - RIBBON_STRIDE;
    expect([main[last], main[last + 1], main[last + 2]]).toEqual([0, 0, 0]);
    expect(main.length / RIBBON_STRIDE).toBeGreaterThan(16);
    expect(lightningRibbons(bolt)[1]!.points).toEqual(a[1]!.points);
    expect(lightningRibbons({ ...bolt, age: 0.2 })[0]!.points).not.toEqual(main);
    expect(lightningRibbons({ ...bolt, age: 0.5 })).toEqual([]);
  });
});

// ── In a kernel ────────────────────────────────────────────────────────────────

const NO_GAME: GameDefinition = { components: [], resources: [], events: [], behaviors: [], systems: [] };

interface Scene {
  readonly kernel: Kernel;
  readonly plugin: Render3dPlugin;
  readonly sounds: PluginSound[];
  readonly loops: Map<string, PluginSound>;
  frame(): Frame3d;
  id(placed: string): EntityId;
  steps(n: number): void;
}

async function scene(prefabs: Record<string, unknown>, entities: unknown[], extra: Record<string, unknown> = {}): Promise<Scene> {
  const project = files({
    ...Object.fromEntries(Object.entries(prefabs).map(([id, p]) => [`prefabs/${id}.prefab.json`, p])),
    'scenes/main/scene.json': { entities },
    ...extra,
  });
  const surface = new RecordingSurface3d();
  const plugin = render3d({ surface, files: project });
  const sounds: PluginSound[] = [];
  const loops = new Map<string, PluginSound>();
  const audio: KernelPlugin = {
    id: 'test-audio',
    install: (k) => k.provide(AUDIO_SERVICE, { play: (s) => sounds.push(s), loop: (key, s) => loops.set(key, s), stop: (key) => loops.delete(key) }),
  };
  const kernel = new Kernel({
    project: loadProject(project), game: NO_GAME, context: {}, fixedStep: DT,
    plugins: [visuals({ dimension: '3d' }), models({ files: project, binary: new MemoryBinaryFiles({}) }), audio, plugin],
  });
  plugin.engine.preload();
  await plugin.engine.whenLoaded();
  kernel.start('main');
  kernel.step(DT);
  return {
    kernel, plugin, sounds, loops,
    frame: () => surface.last!,
    id: (placed) => [...kernel.world.live()].find((r) => r.placedId === placed)!.id,
    steps: (n) => { for (let i = 0; i < n; i++) kernel.step(DT); },
  };
}

const CAMERA = { components: { camera: { fov: 60 } } };

describe('effects in a 3D game', () => {
  it('an explosion: flipbook fireball, sparks and smoke as particle batches, a flash of light, a shockwave haze, a camera kick, its sound', async () => {
    const s = await scene({ cam: CAMERA }, [{ id: 'cam', prefab: 'cam', at: [0, 2, -10] }], {
      'assets/vfx/boom.vfx.json': { extends: 'effect/explosion', sound: 'sfx/boom' },
    });
    const rest = s.frame().views[0]!.position;
    s.plugin.engine.play('vfx/boom', { point: [0, 1, 0] });
    s.steps(8);
    const frame = s.frame();
    const batches = frame.particles!;
    const fire = batches.find((b) => b.image === FIRE_FLIPBOOK)!;
    expect(fire).toMatchObject({ blend: 'additive', frames: [8, 8], lit: false });
    expect(fire.intensity).toBeGreaterThan(1);
    expect(batches.some((b) => b.image === SMOKE_FLIPBOOK && b.lit && b.blend === 'alpha')).toBe(true);
    expect(batches.some((b) => b.facing === 'velocity' && b.blend === 'additive')).toBe(true);
    expect(batches.some((b) => b.facing === 'up' && b.shape === 'ring')).toBe(true);
    // Alpha-blended batches come before additive ones.
    const firstAdditive = batches.findIndex((b) => b.blend === 'additive');
    expect(batches.slice(firstAdditive).every((b) => b.blend === 'additive')).toBe(true);
    expect(frame.lights.some((l) => l.kind === 'point' && l.entity === null && l.intensity > 1)).toBe(true);
    expect(frame.hazes!.some((h) => h.ring > 0)).toBe(true);
    expect(s.sounds.map((x) => [x.sound, x.at?.y])).toEqual([['sfx/boom', 1]]);
    expect(frame.views[0]!.position).not.toEqual(rest);
    for (const b of batches) expect([...b.data].every(Number.isFinite)).toBe(true);
    s.steps(240);
    expect(s.frame().particles).toBeUndefined();
    expect(s.frame().lights.filter((l) => l.entity === null)).toEqual([]);
  });

  it('a continuous built-in fire glows and loops its sound while it emits', async () => {
    const s = await scene({
      cam: CAMERA,
      fire: { components: { particles: { effect: 'vfx/campfire' } } },
    }, [{ id: 'cam', prefab: 'cam', at: [0, 2, -10] }, { id: 'fire', prefab: 'fire', at: [2, 0, 0] }], {
      'assets/vfx/campfire.vfx.json': { extends: 'effect/fire', sound: 'sfx/crackle' },
    });
    s.steps(30);
    const id = s.id('fire');
    expect(s.frame().particles!.some((b) => b.entity === id && b.image === FIRE_FLIPBOOK)).toBe(true);
    expect(s.frame().lights.some((l) => l.entity === id)).toBe(true);
    expect(s.loops.get(`vfx:${id}`)?.sound).toBe('sfx/crackle');
    s.kernel.world.require(id).components.get('particles')!['emitting'] = false;
    s.steps(2);
    expect(s.loops.size).toBe(0);
    expect(s.frame().lights.some((l) => l.entity === id)).toBe(false);
  });

  it('builtin effects play by name, lightning and glowing trails draw as ribbons', async () => {
    const s = await scene({ cam: CAMERA, orb: { components: {} } }, [{ id: 'cam', prefab: 'cam', at: [0, 2, -10] }, { id: 'orb', prefab: 'orb' }]);
    const engine = s.plugin.engine;
    engine.play('effect/muzzle_flash', { point: [0, 1, 0] }, { direction: [0, 0, 1] });
    engine.lightning([0, 8, 0], [0, 0, 0], { branches: 2, seconds: 0.3 });
    const trail = engine.trail(s.id('orb'), { glow: true, seconds: 0.5, width: 0.2 });
    for (let i = 0; i < 6; i++) {
      s.kernel.world.require(s.id('orb')).transform.position = new Vec3(i * 0.3, 1, 0);
      s.steps(1);
    }
    const frame = s.frame();
    expect(frame.particles!.length).toBeGreaterThan(0);
    const ribbons = frame.ribbons!;
    expect(ribbons.filter((r) => r.entity === null && r.core > 0)).toHaveLength(3);
    expect(ribbons.some((r) => r.entity === s.id('orb') && r.blend === 'additive')).toBe(true);
    trail.cancel();
    expect(code(() => engine.lightning([0, 0, 0], [1, 0, 0], { branches: -1 }))).toBe('PP3800');
    expect(code(() => engine.play('effect/nope', { point: [0, 0, 0] }))).toBe('PP2063');
    s.steps(40);
    expect(s.frame().ribbons).toBeUndefined();
  });
});
