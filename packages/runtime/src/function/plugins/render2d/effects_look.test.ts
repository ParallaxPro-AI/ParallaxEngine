/** 2D effect looks: additive blending, vector gravity and shockwave ripples (vfx `haze`, `heat_haze` pulses). */

import { describe, expect, it } from 'vitest';
import { ParallaxError } from '../../../core/index.js';
import type { ParticlesDraw, ProjectFiles } from '../../../core/index.js';
import { AssetCatalog } from './assets.js';
import { EffectLibrary, parseEffect } from './effects.js';
import { pulseRipple } from './engine.js';
import { ParticleSystem } from './particles.js';

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

const catalog = new AssetCatalog(files({}), true);
const parse = (doc: unknown): ReturnType<typeof parseEffect> => parseEffect('assets/vfx/x.vfx.json', JSON.stringify(doc), catalog);

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ParallaxError) return error.diagnostic.code;
    throw error;
  }
  throw new Error('expected a ParallaxError');
}

function system(effects: Record<string, unknown>): ParticleSystem {
  const project = files(Object.fromEntries(Object.entries(effects).map(([name, doc]) => [`assets/vfx/${name}.vfx.json`, doc])));
  const particles = new ParticleSystem(new EffectLibrary(new AssetCatalog(project, true), () => {}));
  particles.reset(1);
  return particles;
}

const shot = { x: 2, y: 3, z: null, color: null, scale: 1, direction: null };
const none = (): never => { throw new Error('no continuous emitters'); };

describe('2D effect looks', () => {
  it('reads blend, vector gravity and haze, with defaults', () => {
    expect(parse({ burst: 1 })).toMatchObject({ blend: 'alpha', gravity: [0, 0], haze: null });
    // One schema with 3D: its keys are accepted and ignored; "glow" draws as a circle.
    expect(parse({ burst: 1, flipbook: 'fire', light: { intensity: 2 }, sound: 'sfx/boom', shape: 'glow' })).toMatchObject({ shape: 'circle' });
    expect(code(() => parse({ burst: 1, blend: 'normal' }))).toBe('PP3808');
    expect(parse({ burst: 1, gravity: -9 }).gravity).toEqual([0, -9]);
    expect(parse({ burst: 1, gravity: [2, -9], blend: 'additive' })).toMatchObject({ gravity: [2, -9], blend: 'additive' });
    expect(parse({ burst: 1, haze: { radius: 3 } }).haze).toEqual({ radius: 3, strength: 0.5, ring: 0.3, seconds: 0.5 });
  });

  it('rejects bad looks with PP3808', () => {
    expect(code(() => parse({ burst: 1, blend: 'screen' }))).toBe('PP3808');
    expect(code(() => parse({ burst: 1, gravity: [1, 2, 3] }))).toBe('PP3808');
    expect(code(() => parse({ burst: 1, haze: { radius: 2, wobble: 1 } }))).toBe('PP3808');
    expect(code(() => parse({ burst: 1, haze: { strength: 2 } }))).toBe('PP3808');
    expect(code(() => parse({ burst: 1, haze: 5 }))).toBe('PP3808');
  });

  it('pulls particles along gravity x and y', () => {
    const particles = system({ fall: { burst: 1, speed: 0, lifetime: 5, gravity: [4, -2] } });
    particles.play('vfx/fall', shot, 'test');
    particles.step(0, none);
    particles.step(0.5, none);
    const data = (particles.draws()[0] as ParticlesDraw).data;
    // v = g·dt after one step, then x += v·dt.
    expect(data[0]).toBeCloseTo(2 + 4 * 0.5 * 0.5, 6);
    expect(data[1]).toBeCloseTo(3 - 2 * 0.5 * 0.5, 6);
  });

  it('marks additive draws and leaves normal ones unmarked', () => {
    const particles = system({ glow: { burst: 3, blend: 'additive' }, plain: { burst: 3 } });
    particles.play('vfx/glow', shot, 'test');
    particles.play('vfx/plain', shot, 'test');
    particles.step(1 / 60, none);
    const [glow, plain] = particles.draws();
    expect(glow!.blend).toBe('additive');
    expect(plain!.blend).toBeUndefined();
  });

  it('grows a one-shot haze into a fading ripple, scaled by play scale, and keeps it in snapshots', () => {
    const particles = system({ boom: { burst: 1, haze: { radius: 4, strength: 0.8, ring: 0.25, seconds: 1 } } });
    particles.play('vfx/boom', { ...shot, scale: 2 }, 'test');
    particles.step(0.25, none);
    const [r] = particles.ripples();
    expect(r).toMatchObject({ x: 2, y: 3, width: 2 });
    expect(r!.radius).toBeCloseTo(8 * 0.25, 6);
    expect(r!.strength).toBeCloseTo(0.8 * 0.75 * 0.75, 6);
    const saved = particles.snapshot();
    const copy = system({ boom: { burst: 1, haze: { radius: 4, strength: 0.8, ring: 0.25, seconds: 1 } } });
    copy.restore(saved, () => true);
    expect(copy.ripples()).toEqual(particles.ripples());
    particles.step(1, none);
    expect(particles.ripples()).toEqual([]);
  });

  it('turns a heat_haze pulse into a ripple while it grows', () => {
    const haze = { pulse_at: 10, pulse_seconds: 0.5, pulse_radius: 6, pulse_strength: 1 };
    expect(pulseRipple({ ...haze, pulse_at: null }, 0, 0, 10)).toBeNull();
    expect(pulseRipple(haze, 1, 1, 9.9)).toBeNull();
    expect(pulseRipple(haze, 1, 1, 10.5)).toBeNull();
    const r = pulseRipple(haze, 1, 2, 10.25)!;
    expect(r).toMatchObject({ x: 1, y: 2, radius: 3, strength: 0.25 });
    expect(r.width).toBeCloseTo(2.1, 6);
  });
});
