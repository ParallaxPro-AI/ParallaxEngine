import { describe, expect, it } from 'vitest';
import { Color, ParallaxError, Vec2, Vec3 } from '../core/index.js';
import type { ProjectFiles } from '../core/index.js';
import { Kernel, t } from '../function/kernel/index.js';
import type { GameDefinition } from '../function/kernel/index.js';
import { RecordingSurface2d } from '../platform/headless/render.js';
import { loadProject } from '../resource/index.js';
import { kw } from './kwargs.js';
import { render2dPlugin, VfxApi } from './render2d.js';
import { Handle } from './time.js';
import { EffectRef, ImageRef } from './types.js';

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, typeof v === 'string' ? v : JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

const GAME: GameDefinition = {
  components: [
    { id: 'camera', schema: { mode: t.string({ default: 'orthographic' }), size: t.number({ default: 5 }), fit: t.json({ default: null }), fit_margin: t.number({ default: 0 }), background: t.json({ default: null }), viewport: t.json({ default: [0, 0, 1, 1] }) } },
    { id: 'shape', schema: { kind: t.string({ default: 'rect' }), size: t.vec3({ default: Vec3.ONE }), offset: t.vec3({ default: Vec3.ZERO }), color: t.color({ default: Color.WHITE }), texture: t.json({ default: null }) } },
  ],
  resources: [], events: [], behaviors: [], systems: [],
};

function game(): { kernel: Kernel; surface: RecordingSurface2d; vfx: VfxApi } {
  const contents = files({
    'prefabs/camera.prefab.json': { components: { camera: {} } },
    'prefabs/block.prefab.json': { z: 3, components: { shape: {} } },
    'scenes/main/scene.json': { entities: [{ prefab: 'camera' }, { prefab: 'block', at: [2, 1] }] },
    'assets/vfx/sparks.vfx.json': { burst: 3, lifetime: 1 },
  });
  const surface = new RecordingSurface2d();
  const plugin = render2dPlugin({ surface, files: contents, assetFiles: true });
  const kernel = new Kernel({ project: loadProject(contents), game: GAME, plugins: [plugin] });
  const vfx = plugin.namespace!.create(kernel) as VfxApi;
  kernel.start('main');
  return { kernel, surface, vfx };
}

const block = (kernel: Kernel): number => [...kernel.world.live()].find((r) => r.prefab === 'block')!.id;

describe('ctx.vfx', () => {
  it('mounts as ctx.vfx', () => {
    const plugin = render2dPlugin({ surface: new RecordingSurface2d(), files: files({}), assetFiles: true });
    expect(plugin.namespace?.name).toBe('vfx');
  });

  it('plays an effect handle at an entity, a Vec2 (on top) or a Vec3 (its z)', () => {
    const { kernel, surface, vfx } = game();
    const sparks = new EffectRef('vfx/sparks');
    vfx.play(sparks, kw({ at: block(kernel), color: Color.RED, scale: 2 }));
    vfx.play(sparks, kw({ at: new Vec2(0, 0) }));
    vfx.play(sparks, kw({ at: new Vec3(0, 0, -1), direction: new Vec2(0, 1) }));
    kernel.step(1 / 60);
    const effects = surface.last!.commands.filter((c) => c.kind === 'particles');
    expect(effects.map((c) => c.z)).toEqual([-1, 3, Infinity]);
  });

  it('binds arguments like Python and rejects the wrong kinds', () => {
    const { kernel, vfx } = game();
    const sparks = new EffectRef('vfx/sparks');
    const error = (fn: () => unknown): string => {
      try { fn(); } catch (e) { if (e instanceof ParallaxError) return e.diagnostic.code; throw e; }
      return 'none';
    };
    expect(error(() => vfx.play(sparks))).toBe('PP3030'); // at= is required
    expect(error(() => vfx.play(sparks, kw({ at: new Vec2(), size: 2 })))).toBe('PP3030');
    expect(error(() => vfx.play(new ImageRef('images/x'), kw({ at: new Vec2() })))).toBe('PP3600');
    expect(error(() => vfx.play(sparks, kw({ at: 'here' })))).toBe('PP3600');
    expect(error(() => vfx.play(sparks, kw({ at: new Vec2(), color: '#fff' })))).toBe('PP3600');
    expect(error(() => vfx.play(sparks, kw({ at: new Vec2(), direction: Vec2.ZERO })))).toBe('PP3600');
    expect(error(() => vfx.play(new EffectRef('vfx/nope'), kw({ at: new Vec2() })))).toBe('PP2063');
    expect(error(() => vfx.trail(block(kernel), kw({ width: 0 })))).toBe('PP3600');
  });

  it('draws beams and returns a trail handle', () => {
    const { kernel, surface, vfx } = game();
    vfx.beam(new Vec2(0, 0), new Vec3(1, 1, 0), kw({ color: Color.YELLOW, width: 0.1 }));
    const trail = vfx.trail(block(kernel));
    expect(trail).toBeInstanceOf(Handle);
    kernel.step(1 / 60);
    expect(surface.last!.commands.filter((c) => c.kind === 'line')).toEqual([
      expect.objectContaining({ points: [0, 0, 1, 1], width: 0.1, color: [1, 1, 0, 1] }),
    ]);
    trail.cancel();
    expect(trail.active).toBe(false);
  });
});
