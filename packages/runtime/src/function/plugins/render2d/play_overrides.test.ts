/** `vfx.play(color_end=, count=)` in 2D and 3D: an end colour replacing the effect's, and a per-play particle count. */

import { describe, expect, it } from 'vitest';
import { PARTICLE_STRIDE } from '../../../core/index.js';
import type { ParticlesDraw, ProjectFiles } from '../../../core/index.js';
import { AssetCatalog } from './assets.js';
import { EffectLibrary } from './effects.js';
import { countAmount, ParticleSystem } from './particles.js';

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

function system(effects: Record<string, unknown>): ParticleSystem {
  const project = files(Object.fromEntries(Object.entries(effects).map(([name, doc]) => [`assets/vfx/${name}.vfx.json`, doc])));
  const particles = new ParticleSystem(new EffectLibrary(new AssetCatalog(project, true), () => {}));
  particles.reset(1);
  return particles;
}

const shot = { x: 0, y: 0, z: null, color: null, scale: 1, direction: null };
const none = (): never => { throw new Error('no continuous emitters'); };

describe('2D vfx.play overrides', () => {
  it('count= scales the burst; color_end= replaces the end colour, keeping the effect\'s end alpha', () => {
    const particles = system({ pop: { burst: 10, speed: 0, lifetime: 2, color: '#ff0000', color_end: '#0000ff80' } });
    particles.play('vfx/pop', { ...shot, count: 3, colorEnd: [0, 1, 0, 1] }, 'test');
    particles.step(0, none);
    particles.step(1, none);
    const draw = particles.draws()[0] as ParticlesDraw;
    expect(draw.data.length / PARTICLE_STRIDE).toBe(3);
    // Halfway through life: red → green, and alpha halfway from 1 to the effect's 0.5.
    const [r, g, b, a] = draw.data.slice(4, 8);
    expect([r, g, b]).toEqual([0.5, 0.5, 0]);
    expect(a).toBeCloseTo(0.75, 2);
    const again = system({ pop: { burst: 10, speed: 0, lifetime: 2 } });
    again.play('vfx/pop', shot, 'test');
    again.step(0, none);
    expect((again.draws()[0] as ParticlesDraw).data.length / PARTICLE_STRIDE).toBe(10);
  });

  it('count= is a total over burst and rate; an empty effect stays empty', () => {
    expect(countAmount({ burst: 10, rate: 20, duration: 0.5 }, 40)).toBe(2);
    expect(countAmount({ burst: 10, rate: 0, duration: 0 }, null)).toBe(1);
    expect(countAmount({ burst: 0, rate: 0, duration: 0 }, 5)).toBe(1);
  });

  it('a snapshot keeps both overrides', () => {
    const particles = system({ pop: { burst: 4, rate: 10, duration: 1, speed: 0, lifetime: 2, color: '#ff0000' } });
    particles.play('vfx/pop', { ...shot, count: 28, colorEnd: [0, 0, 1, 1] }, 'test');
    particles.step(0, none);
    const saved = particles.snapshot();
    expect(saved.emitters[0]).toMatchObject({ overrideEnd: [0, 0, 1, 1], amount: 2 });
    const copy = system({ pop: { burst: 4, rate: 10, duration: 1, speed: 0, lifetime: 2, color: '#ff0000' } });
    copy.restore(saved, () => true);
    copy.step(0.5, none);
    particles.step(0.5, none);
    expect(copy.draws()).toEqual(particles.draws());
  });
});
