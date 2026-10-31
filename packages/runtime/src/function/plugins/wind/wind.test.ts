import { describe, expect, it } from 'vitest';
import { ParallaxError } from '../../../core/index.js';
import type { JsonObject, Project, SceneDoc } from '../../../resource/index.js';
import { Kernel } from '../../kernel/index.js';
import type { GameDefinition } from '../../kernel/index.js';
import { WIND_SERVICE } from '../../services/index.js';
import { bearing, readWindSpec, wind, windAt } from './index.js';

function scene(block: JsonObject | undefined, id = 'level'): SceneDoc {
  return { id, path: `scenes/${id}/scene.json`, tags: [], ui: [], init: {}, entities: [], regions: new Map(), plugins: block === undefined ? {} : { wind: block } };
}

function code(fn: () => unknown): string {
  try { fn(); } catch (e) { if (e instanceof ParallaxError) return e.diagnostic.code; throw e; }
  return 'no error';
}

const empty: GameDefinition = { components: [], resources: [], events: [], behaviors: [], systems: [] };
function kernelWith(scenes: SceneDoc[]): Kernel {
  const project: Project = {
    prefabs: new Map(), scenes: new Map(scenes.map((s) => [s.id, s])), config: new Map(), content: new Map(),
    locales: new Map(), audio: new Map(), dialogues: new Map(), diagnostics: [],
  };
  const kernel = new Kernel({ project, game: empty, plugins: [wind()] });
  kernel.start(scenes[0]!.id);
  return kernel;
}

describe('wind block', () => {
  it('reads bearings and vectors; calm without a block', () => {
    const s = readWindSpec(scene({ direction: 90, speed: 5, gusts: 0.5, streaks: true, debris: 12 }));
    expect(s.dirX).toBeCloseTo(1, 14);
    expect(s.dirZ).toBeCloseTo(0, 14);
    expect(s).toMatchObject({ speed: 5, gusts: 0.5, streaks: true, debris: 12, scale: 40, period: 6 });
    expect(readWindSpec(scene({ direction: [3, 4] }))).toMatchObject({ dirX: 0.6, dirZ: 0.8, speed: 3 });
    expect(readWindSpec(scene(undefined)).speed).toBe(0);
    expect(bearing(0)).toEqual([cosOf(90), 1]);
  });

  it('rejects bad data with PP3236 and a pointer', () => {
    const bad = (b: JsonObject): string | undefined => {
      try { readWindSpec(scene(b)); } catch (e) { return (e as ParallaxError).diagnostic.pointer; }
      return undefined;
    };
    expect(bad({ sped: 3 })).toBe('/wind/sped');
    expect(bad({ gusts: 2 })).toBe('/wind/gusts');
    expect(bad({ direction: [0, 0] })).toBe('/wind/direction');
    expect(bad({ debris: 1.5 })).toBe('/wind/debris');
  });
});

function cosOf(d: number): number {
  return bearing(90 - d)[0];
}

describe('wind field', () => {
  const s = readWindSpec(scene({ direction: 0, speed: 4, gusts: 0.6 }));
  const out = new Float64Array(2);

  it('blows downwind on average, varies with gusts, and is a pure function of place and time', () => {
    let sumX = 0;
    let sumZ = 0;
    let lo = Infinity;
    let hi = -Infinity;
    const n = 4000;
    for (let i = 0; i < n; i++) {
      windAt(s, (i % 63) * 7.1, Math.floor(i / 63) * 5.3, i * 0.37, out);
      sumX += out[0]!;
      sumZ += out[1]!;
      const speed = Math.hypot(out[0]!, out[1]!);
      lo = Math.min(lo, speed);
      hi = Math.max(hi, speed);
    }
    expect(sumZ / n).toBeGreaterThan(3);
    expect(sumZ / n).toBeLessThan(5);
    expect(Math.abs(sumX / n)).toBeLessThan(0.5);
    expect(hi - lo).toBeGreaterThan(2);
    const a = windAt(s, 12.5, -3, 7.25, new Float64Array(2));
    const b = windAt(s, 12.5, -3, 7.25, new Float64Array(2));
    expect([...a]).toEqual([...b]);
  });

  it('gusts travel downwind: the field at (p + v·t, t) repeats the field at (p, 0)', () => {
    const steady = { ...s, gusts: 0.6, period: 1e9 };
    const t = 3;
    const a = windAt(steady, 10, 0, 0, new Float64Array(2));
    const b = windAt(steady, 10, steady.speed * t, t, new Float64Array(2));
    expect(b[1]).toBeCloseTo(a[1]!, 2);
  });

  it('calm air is zero', () => {
    expect([...windAt(readWindSpec(scene(undefined)), 3, 4, 5, out)]).toEqual([0, 0]);
  });
});

describe('wind plugin', () => {
  it('eases changes in over game time, and snapshots the change in progress', () => {
    const kernel = kernelWith([scene({ direction: 0, speed: 2, gusts: 0 })]);
    const service = kernel.service(WIND_SERVICE);
    expect(service.settings().speed).toBe(2);
    service.set({ speed: 6, dirX: 1, dirZ: 0, seconds: 2 });
    for (let i = 0; i < 60; i++) kernel.step(1 / 60);
    const mid = service.settings();
    expect(mid.speed).toBeCloseTo(4, 1);
    expect(Math.hypot(mid.dirX, mid.dirZ)).toBeCloseTo(1, 9);
    const snapshot = kernel.snapshot();
    for (let i = 0; i < 90; i++) kernel.step(1 / 60);
    expect(service.settings()).toMatchObject({ speed: 6, dirX: 1, dirZ: 0 });
    kernel.restore(snapshot);
    expect(service.settings().speed).toBeCloseTo(4, 1);
    expect([...service.mean()].map((v) => +v.toFixed(3))).toEqual([+(mid.dirX * mid.speed).toFixed(3), +(mid.dirZ * mid.speed).toFixed(3)]);
  });

  it('bad changes are PP3237', () => {
    const service = kernelWith([scene(undefined)]).service(WIND_SERVICE);
    expect(code(() => service.set({ speed: -1 }))).toBe('PP3237');
    expect(code(() => service.set({ dirX: 0, dirZ: 0 }))).toBe('PP3237');
    expect(code(() => service.set({ gusts: 3 }))).toBe('PP3237');
  });
});
