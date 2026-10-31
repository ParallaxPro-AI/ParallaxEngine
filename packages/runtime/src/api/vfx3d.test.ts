import { describe, expect, it } from 'vitest';
import { BUILTIN_EFFECTS, Color, ParallaxError, Vec3 } from '../core/index.js';
import type { ProjectFiles } from '../core/index.js';
import { Kernel } from '../function/kernel/index.js';
import type { GameDefinition } from '../function/kernel/index.js';
import { models } from '../function/plugins/models/index.js';
import { visuals } from '../function/plugins/visuals/index.js';
import { MemoryBinaryFiles, RecordingSurface3d } from '../platform/headless/render3d.js';
import { loadProject } from '../resource/index.js';
import { kw } from './kwargs.js';
import { render3dPlugin, VfxApi3d } from './render3d.js';
import { Effect } from './types.js';

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, typeof v === 'string' ? v : JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

const NO_GAME: GameDefinition = { components: [], resources: [], events: [], behaviors: [], systems: [] };

function game(): { kernel: Kernel; surface: RecordingSurface3d; vfx: VfxApi3d } {
  const contents = files({
    'prefabs/cam.prefab.json': { components: { camera: {} } },
    'prefabs/orb.prefab.json': { components: {} },
    'scenes/main/scene.json': { entities: [{ prefab: 'cam', at: [0, 2, -10] }, { prefab: 'orb' }] },
  });
  const surface = new RecordingSurface3d();
  const plugin = render3dPlugin({ surface, files: contents });
  const kernel = new Kernel({ project: loadProject(contents), game: NO_GAME, plugins: [visuals({ dimension: '3d' }), models({ files: contents, binary: new MemoryBinaryFiles({}) }), plugin], context: {} });
  const vfx = plugin.namespace!.create(kernel) as VfxApi3d;
  kernel.start('main');
  return { kernel, surface, vfx };
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof ParallaxError) return e.diagnostic.code;
    throw e;
  }
  return 'no error';
}

describe('ctx.vfx in 3D', () => {
  it('has a handle for every built-in effect', () => {
    for (const name of BUILTIN_EFFECTS) expect((Effect as unknown as Record<string, { path: string }>)[name]!.path).toBe(`effect/${name}`);
  });

  it('plays built-ins, strikes lightning, glows beams and trails, binding arguments like Python', () => {
    const { kernel, surface, vfx } = game();
    const orb = [...kernel.world.live()].find((r) => r.prefab === 'orb')!.id;
    vfx.play(Effect.explosion, kw({ at: new Vec3(0, 1, 0), scale: 0.5 }));
    vfx.lightning(new Vec3(0, 10, 0), new Vec3(0, 0, 0), kw({ branches: 2, color: Color.hex('#aaccff') }));
    vfx.beam(new Vec3(0, 1, 0), new Vec3(5, 1, 0), kw({ intensity: 4, seconds: 1 }));
    vfx.trail(orb, kw({ glow: true, seconds: 1 }));
    kernel.step(1 / 60);
    const frame = surface.last!;
    expect(frame.particles!.length).toBeGreaterThan(2);
    expect(frame.ribbons!.filter((r) => r.entity === null).length).toBe(1 + 3);
    expect(code(() => vfx.lightning(new Vec3(0, 0, 0)))).not.toBe('no error');
    expect(code(() => vfx.trail(orb, kw({ glow: 'yes' })))).toBe('PP3800');
    expect(code(() => vfx.beam(new Vec3(0, 0, 0), new Vec3(1, 0, 0), kw({ intensity: -1 })))).toBe('PP3800');
  });
});
