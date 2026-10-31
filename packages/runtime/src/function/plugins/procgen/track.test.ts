import { describe, expect, it } from 'vitest';
import { ParallaxError, Vec3 } from '../../../core/index.js';
import type { ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import type { JsonObject } from '../../../resource/index.js';
import { Kernel } from '../../kernel/index.js';
import type { Fields, GameDefinition } from '../../kernel/index.js';
import { PROCGEN_SERVICE, TERRAIN_SERVICE } from '../../services/index.js';
import type { GeneratedMesh } from '../../services/index.js';
import { readTerrainSpec, terrain } from '../terrain/index.js';
import { barrierOffset, buildTrack, centerline, procgen, trackGradePaths, trackSpec, TRACK_SCHEMA } from './index.js';
import type { SplineSpec, TrackGeometry } from './index.js';
import { instantiate } from '../../kernel/index.js';
import type { Surface } from './mesh.js';

/** A stadium loop: two 120 m straights joined by two semicircles of radius 50, clockwise seen from above (always turning right). */
function stadium(): [number, number, number][] {
  const pts: [number, number, number][] = [];
  for (let z = -60; z < 60; z += 20) pts.push([50, 0, z]);
  for (let a = 0; a < 180; a += 20) pts.push([50 * Math.cos((a * Math.PI) / 180), 0, 60 + 50 * Math.sin((a * Math.PI) / 180)]);
  for (let z = 60; z > -60; z -= 20) pts.push([-50, 0, z]);
  for (let a = 180; a < 360; a += 20) pts.push([50 * Math.cos((a * Math.PI) / 180), 0, -60 + 50 * Math.sin((a * Math.PI) / 180)]);
  // Built counter-clockwise (heading +z up the x = 50 straight, then turning left); reversed: clockwise.
  return pts.reverse();
}

const SPLINE: SplineSpec = { points: stadium(), closed: true, curve: 'catmull_rom', frame: 'level', bank: [], autoBank: 0, bankRadius: 20, spacing: 2 };
const spec = (json: JsonObject = {}) => trackSpec(instantiate(TRACK_SCHEMA, json, 'track'), 'track');
const part = (g: TrackGeometry, name: string): Surface | undefined => g.parts.find((p) => p.name === `track:${name}`)?.surface;

/** Undirected edges used by exactly one triangle (welded positions). */
function boundary(s: Surface, weld = 1e-3): [number[], number[]][] {
  const key = (i: number) => [0, 1, 2].map((k) => Math.round(s.positions[i * 3 + k]! / weld)).join(',');
  const count = new Map<string, { n: number; a: number; b: number }>();
  for (let t = 0; t < s.indices.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = s.indices[t + k]!;
      const b = s.indices[t + ((k + 1) % 3)]!;
      const [ka, kb] = [key(a), key(b)];
      if (ka === kb) continue;
      const id = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const e = count.get(id) ?? { n: 0, a, b };
      e.n++;
      count.set(id, e);
    }
  }
  const pos = (i: number) => [s.positions[i * 3]!, s.positions[i * 3 + 1]!, s.positions[i * 3 + 2]!];
  return [...count.values()].filter((e) => e.n === 1).map((e) => [pos(e.a), pos(e.b)]);
}

/** Highest surface of a triangle soup straight under (x, z), or null. */
function rayDown(vertices: ArrayLike<number>, indices: ArrayLike<number>, x: number, z: number): number | null {
  let best: number | null = null;
  for (let t = 0; t < indices.length; t += 3) {
    const p = [0, 1, 2].map((k) => [vertices[indices[t + k]! * 3]!, vertices[indices[t + k]! * 3 + 1]!, vertices[indices[t + k]! * 3 + 2]!]);
    const [a, b, c] = p as [number[], number[], number[]];
    const d = (b[0]! - a[0]!) * (c[2]! - a[2]!) - (c[0]! - a[0]!) * (b[2]! - a[2]!);
    if (Math.abs(d) < 1e-12) continue;
    const u = ((x - a[0]!) * (c[2]! - a[2]!) - (c[0]! - a[0]!) * (z - a[2]!)) / d;
    const v = ((b[0]! - a[0]!) * (z - a[2]!) - (x - a[0]!) * (b[2]! - a[2]!)) / d;
    if (u < -1e-9 || v < -1e-9 || u + v > 1 + 1e-9) continue;
    const y = a[1]! + u * (b[1]! - a[1]!) + v * (c[1]! - a[1]!);
    if (best === null || y > best) best = y;
  }
  return best;
}

/** rayDown over a big soup, bucketed on a 4 m grid of xz cells. */
function rayIndex(vertices: ArrayLike<number>, indices: ArrayLike<number>): (x: number, z: number) => number | null {
  const cell = 4;
  const buckets = new Map<string, number[]>();
  for (let t = 0; t < indices.length; t += 3) {
    const xs = [0, 1, 2].map((k) => vertices[indices[t + k]! * 3]!);
    const zs = [0, 1, 2].map((k) => vertices[indices[t + k]! * 3 + 2]!);
    for (let i = Math.floor(Math.min(...xs) / cell); i <= Math.floor(Math.max(...xs) / cell); i++) {
      for (let j = Math.floor(Math.min(...zs) / cell); j <= Math.floor(Math.max(...zs) / cell); j++) {
        const key = `${i},${j}`;
        const list = buckets.get(key) ?? [];
        list.push(indices[t]!, indices[t + 1]!, indices[t + 2]!);
        buckets.set(key, list);
      }
    }
  }
  return (x, z) => {
    const list = buckets.get(`${Math.floor(x / cell)},${Math.floor(z / cell)}`);
    return list === undefined ? null : rayDown(vertices, list, x, z);
  };
}

describe('track geometry', () => {
  it('is deterministic: same data, same bytes; the seed only moves the crowd', () => {
    const line = centerline(SPLINE);
    const s = spec({ crowd: { sections: [[0, 0.2]] }, signs: { every: 60 } });
    const a = buildTrack(line, s, null);
    const b = buildTrack(line, s, null);
    expect(a.parts.map((p) => p.name)).toEqual(b.parts.map((p) => p.name));
    a.parts.forEach((p, i) => {
      expect(Array.from(p.surface.positions)).toEqual(Array.from(b.parts[i]!.surface.positions));
      expect(Array.from(p.surface.colors ?? [])).toEqual(Array.from(b.parts[i]!.surface.colors ?? []));
    });
    expect(a.spectators).toBeGreaterThan(100);
    const c = buildTrack(line, spec({ crowd: { sections: [[0, 0.2]] }, signs: { every: 60 }, seed: 7 }), null);
    expect(Array.from(part(c, 'tarmac')!.positions)).toEqual(Array.from(part(a, 'tarmac')!.positions));
    expect(Array.from(part(c, 'crowd')!.positions)).not.toEqual(Array.from(part(a, 'crowd')!.positions));
  });

  it('builds every piece of the cross-section', () => {
    const g = buildTrack(centerline(SPLINE), spec({ crowd: { sections: [[0.9, 0.1]] }, signs: { every: 60 } }), null);
    for (const name of ['tarmac', 'edge_lines', 'kerbs', 'runoff', 'barrier', 'props_solid', 'props', 'lamps', 'finish_line', 'stands', 'crowd']) {
      expect(part(g, name), name).toBeDefined();
    }
    // Striped kerbs: two colors per vertex.
    const kerb = part(g, 'kerbs')!;
    const reds = new Set<string>();
    for (let i = 0; i < kerb.colors!.length; i += 4) reds.add(kerb.colors![i]!.toFixed(2));
    expect(reds.size).toBe(2);
    // The barrier stands at its offset either side.
    const bar = part(g, 'barrier')!;
    const x = barrierOffset(spec());
    let far = 0;
    for (let i = 0; i < bar.positions.length; i += 3) far = Math.max(far, Math.hypot(bar.positions[i]!, bar.positions[i + 2]! - Math.sign(bar.positions[i + 2]!) * Math.min(60, Math.abs(bar.positions[i + 2]!))));
    expect(far).toBeGreaterThan(50 + x - 0.2);
    expect(far).toBeLessThan(50 + x + 0.3);
  });

  it('is connected: the tarmac closes on itself, its only open edges are the skirts\' bottoms', () => {
    const g = buildTrack(centerline(SPLINE), spec({ gantry: null, finish_line: false }), null);
    const open = boundary(part(g, 'tarmac')!);
    expect(open.length).toBeGreaterThan(0);
    for (const [a, b] of open) {
      expect(a[1]).toBeCloseTo(-0.4, 3);
      expect(b[1]).toBeCloseTo(-0.4, 3);
    }
    // The armco rail is a closed tube round the lap: no open edges at all.
    expect(boundary(part(g, 'barrier')!)).toHaveLength(0);
  });

  it('finds the corners: kerbs only there, on both sides or the apex side; the racing line cuts the apex', () => {
    const line = centerline(SPLINE);
    const g = buildTrack(line, spec(), null);
    expect(g.corners).toHaveLength(2);
    // Clockwise from above: always turning right, so the inside is the right side.
    for (const c of g.corners) {
      expect(c.side).toBe(1);
      expect(c.radius).toBeGreaterThan(40);
      expect(c.radius).toBeLessThan(60);
    }
    expect(new Set(g.kerbs.map((k) => k.side))).toEqual(new Set([1, -1]));
    const kerbed = g.kerbs.reduce((sum, k) => sum + (k.end - k.start), 0) / 2;
    expect(kerbed).toBeLessThan(line.length * 0.8);
    expect(kerbed).toBeGreaterThan(Math.PI * 50 * 2 * 0.9);
    const apex = buildTrack(line, spec({ kerbs: { on: 'apex' } }), null);
    expect(apex.kerbs.every((k) => k.side === 1)).toBe(true);
    expect(buildTrack(line, spec({ kerbs: { on: 'full' } }), null).kerbs.reduce((s, k) => s + k.end - k.start, 0)).toBeCloseTo(line.length * 2, 3);
    // At each apex the line is inside (right); mid-straight it is near the outside or the middle.
    for (const c of g.corners) {
      const i = line.samples.findIndex((s) => s.distance >= c.apex);
      expect(g.racing[i]!).toBeGreaterThan(3);
      expect(Math.abs(g.racing[i]!)).toBeLessThanOrEqual(18 / 2 - 1.5 + 1e-9);
    }
  });

  it('keeps the drivable section above the ground and stands the run-off on it', () => {
    const line = centerline(SPLINE);
    const ground = (x: number, z: number): number => 0.6 * Math.sin(x * 0.05) + 0.4 * Math.cos(z * 0.07);
    const g = buildTrack(line, spec(), ground);
    const tarmac = part(g, 'tarmac')!;
    for (let k = 0; k < 40; k++) {
      const sample = line.samples[(k * 37) % line.samples.length]!;
      const u = ((k % 9) - 4) * 2;
      const x = sample.point[0] + sample.right[0] * u;
      const z = sample.point[2] + sample.right[2] * u;
      const y = rayDown(tarmac.positions, tarmac.indices, x, z);
      expect(y).not.toBeNull();
      expect(y! - ground(x, z)).toBeGreaterThan(0.005);
    }
    const crownTop = g.lift.map((l, i) => line.samples[i]!.point[1] + l + 0.1 - ground(line.samples[i]!.point[0], line.samples[i]!.point[2]));
    expect(Math.min(...crownTop)).toBeGreaterThan(0.1);
    // Lift ramps: never more than 1 in 16 between neighbouring samples.
    const step = line.length / line.samples.length;
    for (let i = 0; i < g.lift.length; i++) expect(Math.abs(g.lift[i]! - g.lift[(i + 1) % g.lift.length]!)).toBeLessThanOrEqual(step / 16 + 1e-9);
  });

  it('rejects bad specs with PP3645', () => {
    const code = (fn: () => unknown): string | undefined => {
      try { fn(); } catch (e) { return (e as ParallaxError).diagnostic.code; }
      return undefined;
    };
    expect(code(() => spec({ width: 0 }))).toBe('PP3645');
    expect(code(() => spec({ crowd: { sections: [[0.5, 0.5]] } }))).toBe('PP3645');
    expect(code(() => spec({ surface: { crown: 6 } }))).toBe('PP3645');
    expect(code(() => spec())).toBeUndefined();
  });
});

// ── In a kernel, on terrain ─────────────────────────────────────────────────────

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

const TRACK_JSON: JsonObject = { crowd: { sections: [[0.95, 0.05]] }, signs: { every: 80 }, grade: { paint: 'sand' } };

function start(track: JsonObject = TRACK_JSON, withTerrain = true, spline: JsonObject = {}): Kernel {
  const project = loadProject(files({
    'prefabs/circuit.prefab.json': { components: {} },
    'scenes/s/scene.json': {
      mode: '3d',
      ...(withTerrain && { terrain: { size: [400, 400], max_height: 12, seed: 5, layers: ['grass', 'sand'], default_layer: 'grass' } }),
      entities: [{
        id: 'circuit', prefab: 'circuit',
        components: { spline: { points: stadium(), closed: true, spacing: 2, ...(withTerrain && { ground: 'terrain' }), ...spline }, track },
      }],
    },
  }));
  const game: GameDefinition = { components: [], resources: [], events: [], behaviors: [], systems: [] };
  const kernel = new Kernel({ project, game, plugins: withTerrain ? [terrain(), procgen()] : [procgen()] });
  kernel.start('s');
  return kernel;
}

const trackMesh = (k: Kernel): GeneratedMesh => k.service(PROCGEN_SERVICE).meshes().find((m) => m.key.startsWith('track:'))!;

describe('the Track component', () => {
  it('grades the terrain under it: a flat corridor, painted with grade.paint', () => {
    const k = start();
    const scene = k.project.scenes.get('s')!;
    const paths = trackGradePaths(scene);
    expect(paths.map((p) => p.layer)).toEqual([null, 'sand']);
    expect(paths[0]!.width).toBeCloseTo(2 * (barrierOffset(trackSpec(instantiate(TRACK_SCHEMA, {}, 't'), 't')) + 1), 6);
    const terrainSpec = readTerrainSpec(scene, paths)!;
    expect(terrainSpec.paths.filter((p) => p.flatten !== null)).toHaveLength(1);
    // Flat across the road: the ground at the edges matches the ground at the centerline.
    const field = k.service(TERRAIN_SERVICE).current()!;
    for (const z of [-40, 0, 40]) {
      const mid = field.heightAt(50, z);
      expect(Math.abs(field.heightAt(50 - 9, z) - mid)).toBeLessThan(0.15);
      expect(Math.abs(field.heightAt(50 + 9, z) - mid)).toBeLessThan(0.15);
    }
  });

  it('collides: a ray down the centerline hits the crowned road; barriers are solid, the crowd is not', () => {
    const k = start();
    const mesh = trackMesh(k);
    const { vertices, indices } = mesh.collision!;
    const field = k.service(TERRAIN_SERVICE).current()!;
    for (const z of [-30, 10, 50]) {
      const y = rayDown(vertices, indices, 50, z)!;
      expect(y).not.toBeNull();
      expect(y - field.heightAt(50, z)).toBeGreaterThan(0.08);
      expect(y - field.heightAt(50, z)).toBeLessThan(0.6);
    }
    // Off the road but inside the barrier: only the kerb (if any) or nothing; at the barrier: the rail.
    const x = 50 + barrierOffset(trackSpec(instantiate(TRACK_SCHEMA, TRACK_JSON, 't'), 't'));
    let rail = 0;
    for (let i = 0; i < vertices.length; i += 3) if (Math.abs(vertices[i]! - x) < 0.1 && Math.abs(vertices[i + 2]!) < 40) rail++;
    expect(rail).toBeGreaterThan(10);
    const crowd = mesh.parts.find((p) => p.geometry.id.length > 0 && p.material.id.includes('track:crowd'))!;
    expect(crowd).toBeDefined();
    const solidCount = mesh.parts.length;
    expect(indices.length / 3).toBeLessThan(mesh.parts.reduce((n, p) => n + p.geometry.indices.length / 3, 0));
    expect(solidCount).toBeGreaterThan(8);
  });

  it('answers racing_line, surface_at and corners; the spline still serves the path', () => {
    const k = start();
    const [, fields] = k.world.query(['track'])[0]! as [never, Fields & Record<string, (...a: unknown[]) => unknown>];
    const line = fields['racing_line']!(5) as Vec3[];
    const path = k.service(PROCGEN_SERVICE).paths()[0]!;
    expect(line.length).toBe(Math.round(path.length / 5));
    for (const p of line) expect(Math.abs(path.nearest(p.x, p.y, p.z).lateral)).toBeLessThanOrEqual(7.5 + 0.05);
    expect(fields['surface_at']!(new Vec3(50, 0, 0))).toBe('road');
    expect(fields['surface_at']!(new Vec3(50 + 9 + 2.5, 0, 0))).toBe('runoff');
    expect(fields['surface_at']!(new Vec3(50 + 30, 0, 0))).toBe('off');
    expect(fields['surface_at']!(new Vec3(0, 0, 60 + 50 + 9.5))).toBe('kerb');
    expect((fields['corners']!() as unknown[]).length).toBe(2);
  });

  it('rebuilds on edits, the same bytes for the same data, and reports a missing spline', () => {
    const a = trackMesh(start());
    const b = trackMesh(start());
    expect(Array.from(a.collision!.vertices)).toEqual(Array.from(b.collision!.vertices));
    const k = start();
    const before = trackMesh(k).version;
    const [, fields] = k.world.query(['track'])[0]!;
    (fields as Fields)['width'] = 14;
    expect(trackMesh(k).version).toBeGreaterThan(before);
    const bare = loadProject(files({
      'prefabs/circuit.prefab.json': { components: {} },
      'scenes/s/scene.json': { entities: [{ prefab: 'circuit', components: { track: {} } }] },
    }));
    const kernel = new Kernel({ project: bare, game: { components: [], resources: [], events: [], behaviors: [], systems: [] }, plugins: [procgen()] });
    kernel.start('s');
    try {
      kernel.service(PROCGEN_SERVICE).meshes();
      expect.unreachable();
    } catch (e) {
      expect((e as ParallaxError).diagnostic.code).toBe('PP3645');
    }
  });

  it('drives on what it shows: across banked corners the physics surface is the visible surface', () => {
    // Hard auto-bank (12° at a 50 m turn): the outside edge rides well above the graded corridor.
    const k = start({ ...TRACK_JSON, crowd: { sections: [] } }, true, { auto_bank: 12, bank_radius: 50 });
    const mesh = trackMesh(k);
    const field = k.service(TERRAIN_SERVICE).current()!;
    const path = k.service(PROCGEN_SERVICE).paths()[0]!;
    const visibleParts = mesh.parts.filter((p) => /track:(tarmac|kerbs|runoff|barrier|props_solid)\b/.test(p.material.id));
    expect(visibleParts).toHaveLength(5);
    const visible = visibleParts.map((p) => rayIndex(p.geometry.positions, p.geometry.indices));
    const collider = rayIndex(mesh.collision!.vertices, mesh.collision!.indices);
    const s = trackSpec(instantiate(TRACK_SCHEMA, TRACK_JSON, 't'), 't');
    const shoulder = barrierOffset(s) - s.barrierGap;
    let banked = 0;
    let checked = 0;
    for (let d = 0; d < path.length; d += 7) {
      const f = path.at(d);
      if (Math.abs(f.bank) > 6) banked++;
      const h = Math.hypot(f.right[0], f.right[2]);
      for (let u = -shoulder + 0.25; u <= shoulder - 0.25; u += 0.5) {
        const x = f.point[0] + (f.right[0] / h) * u;
        const z = f.point[2] + (f.right[2] / h) * u;
        const ground = field.heightAt(x, z);
        const shown = Math.max(ground, ...visible.map((ray) => ray(x, z) ?? -Infinity));
        const solid = Math.max(ground, collider(x, z) ?? -Infinity);
        expect(Math.abs(solid - shown), `d=${d.toFixed(1)} u=${u.toFixed(2)} bank=${f.bank.toFixed(1)}`).toBeLessThan(0.05);
        checked++;
      }
    }
    expect(banked).toBeGreaterThan(10);
    expect(checked).toBeGreaterThan(1000);
  });

  it('works without terrain (flat, no grading)', () => {
    const k = start(TRACK_JSON, false);
    const mesh = trackMesh(k);
    expect(rayDown(mesh.collision!.vertices, mesh.collision!.indices, 50, 0)).toBeCloseTo(0.1, 2);
  });
});
