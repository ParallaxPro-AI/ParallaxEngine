import { describe, expect, it } from 'vitest';
import { ParallaxError } from '../../../core/index.js';
import type { JsonObject } from '../../../resource/index.js';
import { instantiate } from '../../kernel/index.js';
import { buildCrowd, CROWD, CROWD_SCHEMA, crowdSpec, PROCGEN_SCHEMAS, procgen } from './index.js';
import type { CrowdGeometry } from './index.js';

const spec = (json: JsonObject = {}) => crowdSpec(instantiate(CROWD_SCHEMA, json, 'crowd'), 'crowd');
const part = (g: CrowdGeometry, name: string) => g.parts.find((p) => p.name === `crowd:${name}`);

describe('crowd', () => {
  it('is a procgen component', () => {
    expect(PROCGEN_SCHEMAS[CROWD]).toBe(CROWD_SCHEMA);
    expect(procgen().components?.map((c) => c.id)).toContain(CROWD);
  });

  it('fills rows along x, stepping back and up, everyone inside the run', () => {
    const g = buildCrowd(spec({ length: 30, rows: 5, row_gap: 0.8, row_rise: 0.4, density: 1.5 }));
    expect(g.spectators).toBe(5 * 45);
    const people = part(g, 'spectators')!.surface;
    expect(people.min[0]).toBeGreaterThanOrEqual(-15.6);
    expect(people.max[0]).toBeLessThanOrEqual(15.6);
    expect(people.min[1]).toBeGreaterThanOrEqual(-1e-6);
    expect(people.max[1]).toBeGreaterThan(4 * 0.4 + 1);
    expect(people.max[2]).toBeLessThan(0.5);
    expect(people.min[2]).toBeGreaterThan(-5 * 0.8 - 0.5);
    expect(part(g, 'spectators')!.collide).toBe(false);
  });

  it('builds the stepped stand under the rows, solid when asked', () => {
    const g = buildCrowd(spec({ length: 10, rows: 4, row_rise: 0.5, stand_depth: 0.3 }));
    const stands = part(g, 'stands')!;
    expect(stands.collide).toBe(true);
    expect(stands.surface.max[1]).toBeCloseTo(3 * 0.5, 5);
    expect(stands.surface.min[1]).toBeCloseTo(-0.3, 5);
    expect(stands.surface.min[2]).toBeCloseTo(-4 * 0.8, 5);
    expect(part(buildCrowd(spec({ stands: false })), 'stands')).toBeUndefined();
    expect(part(buildCrowd(spec({ collide: false })), 'stands')!.collide).toBe(false);
  });

  it('is the same crowd for the same seed, another for another', () => {
    const a = part(buildCrowd(spec({ seed: 4 })), 'spectators')!.surface;
    const b = part(buildCrowd(spec({ seed: 4 })), 'spectators')!.surface;
    const c = part(buildCrowd(spec({ seed: 5 })), 'spectators')!.surface;
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    expect(Array.from(a.positions)).not.toEqual(Array.from(c.positions));
  });

  it('deals the spectators into groups that together are the whole crowd', () => {
    const whole = buildCrowd(spec({ length: 40, rows: 8, seed: 2 })).spectators;
    let sum = 0;
    for (let group = 0; group < 3; group++) {
      const g = buildCrowd(spec({ length: 40, rows: 8, seed: 2, groups: 3, group }));
      expect(g.spectators).toBeGreaterThan(whole / 6);
      sum += g.spectators;
    }
    expect(sum).toBe(whole);
  });

  it('leaves seats empty by fill, and stops at max', () => {
    const full = buildCrowd(spec({ length: 40, rows: 8 })).spectators;
    const half = buildCrowd(spec({ length: 40, rows: 8, fill: 0.5 })).spectators;
    expect(half).toBeGreaterThan(full * 0.4);
    expect(half).toBeLessThan(full * 0.6);
    expect(buildCrowd(spec({ length: 40, rows: 8, max: 25 })).spectators).toBe(25);
    expect(part(buildCrowd(spec({ fill: 0 })), 'spectators')).toBeUndefined();
  });

  it('adds raised arms and scarves as more geometry', () => {
    const calm = part(buildCrowd(spec({ arms_up: 0 })), 'spectators')!.surface;
    const arms = part(buildCrowd(spec({ arms_up: 1 })), 'spectators')!.surface;
    const scarves = part(buildCrowd(spec({ arms_up: 1, scarves: 1, scarf_colors: ['#ff0000'] })), 'spectators')!.surface;
    expect(arms.indices.length).toBeGreaterThan(calm.indices.length);
    expect(scarves.indices.length).toBeGreaterThan(arms.indices.length);
    expect(scarves.max[1]).toBeGreaterThan(arms.max[1] - 0.2);
  });

  it('rejects data it cannot build, with a coded error', () => {
    const bads: JsonObject[] = [{ rows: 0 }, { length: 0 }, { fill: 1.5 }, { groups: 2, group: 2 }, { density: -1 }];
    for (const bad of bads) {
      expect(() => spec(bad)).toThrow(ParallaxError);
    }
    try {
      spec({ group: 3 });
    } catch (error) {
      expect((error as ParallaxError).diagnostic.code).toBe('PP3657');
    }
  });
});
