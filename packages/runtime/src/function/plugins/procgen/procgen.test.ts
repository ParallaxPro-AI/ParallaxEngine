import { describe, expect, it } from 'vitest';
import { ParallaxError, SeededRandom, Vec3 } from '../../../core/index.js';
import type { ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel } from '../../kernel/index.js';
import type { Fields, GameDefinition } from '../../kernel/index.js';
import { PROCGEN_SERVICE } from '../../services/index.js';
import type { Surface } from './mesh.js';
import {
  BUILTIN_PROFILES, buildStructure, centerline, dressRoom, dungeonGeometry, layoutDungeon, latheMesh, nearestOn, PIECE, procgen,
  reachable, sampleAt, splineProblem, structureProblems, sweepLayer, WALL,
} from './index.js';
import type { DungeonSpec, PropKit, SplineSpec, StructureSpec, SweepLayerSpec } from './index.js';

const SPEC: SplineSpec = { points: [], closed: false, curve: 'catmull_rom', frame: 'level', bank: [], autoBank: 0, bankRadius: 20, spacing: 1 };

/** A circle of radius r in the xz plane, n control points, counter-clockwise seen from above. */
function ring(r: number, n: number, y = 0): [number, number, number][] {
  return Array.from({ length: n }, (_, i) => [r * Math.cos((2 * Math.PI * i) / n), y, r * Math.sin((2 * Math.PI * i) / n)]);
}

const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;

/** Every triangle's geometric normal agrees with its vertices' normals (front faces follow the normal). */
function windingAgrees(s: Surface): boolean {
  for (let t = 0; t < s.indices.length; t += 3) {
    const [a, b, c] = [s.indices[t]!, s.indices[t + 1]!, s.indices[t + 2]!];
    const p = (i: number) => [s.positions[i * 3]!, s.positions[i * 3 + 1]!, s.positions[i * 3 + 2]!];
    const ab = p(b).map((v, k) => v - p(a)[k]!);
    const ac = p(c).map((v, k) => v - p(a)[k]!);
    const n = [ab[1]! * ac[2]! - ab[2]! * ac[1]!, ab[2]! * ac[0]! - ab[0]! * ac[2]!, ab[0]! * ac[1]! - ab[1]! * ac[0]!];
    if (Math.hypot(n[0]!, n[1]!, n[2]!) < 1e-9) continue;
    const vn = [s.normals[a * 3]!, s.normals[a * 3 + 1]!, s.normals[a * 3 + 2]!];
    if (dot(n, vn) <= 0) return false;
  }
  return true;
}

/** Every undirected edge is shared by exactly two triangles, in opposite directions (closed, consistently oriented). */
function watertight(positions: Float32Array, indices: Uint32Array, weld = 1e-4): boolean {
  const ids = new Map<string, number>();
  const id = (i: number): number => {
    const key = [0, 1, 2].map((k) => Math.round(positions[i * 3 + k]! / weld)).join(',');
    let v = ids.get(key);
    if (v === undefined) ids.set(key, v = ids.size);
    return v;
  };
  const edges = new Map<string, number>();
  for (let t = 0; t < indices.length; t += 3) {
    const v = [id(indices[t]!), id(indices[t + 1]!), id(indices[t + 2]!)];
    if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) continue;
    for (let k = 0; k < 3; k++) {
      const key = `${v[k]}>${v[(k + 1) % 3]}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  for (const [key, count] of edges) {
    const [a, b] = key.split('>');
    if (count !== 1 || edges.get(`${b}>${a}`) !== 1) return false;
  }
  return edges.size > 0;
}

describe('splines', () => {
  it('measures arc length and samples evenly; closed loops wrap', () => {
    const line = centerline({ ...SPEC, points: ring(50, 12), closed: true, spacing: 2 });
    expect(line.length).toBeGreaterThan(2 * Math.PI * 50 * 0.995);
    expect(line.length).toBeLessThan(2 * Math.PI * 50 * 1.005);
    const steps = line.samples.slice(1).map((s, i) => s.distance - line.samples[i]!.distance);
    expect(Math.max(...steps) - Math.min(...steps)).toBeLessThan(1e-9);
    expect(Math.max(...steps)).toBeLessThanOrEqual(2);
    // The point at length L is the start again.
    const end = sampleAt(line, line.length);
    expect(Math.hypot(end.point[0] - line.samples[0]!.point[0], end.point[2] - line.samples[0]!.point[2])).toBeLessThan(1e-6);
    // Each control point is on the curve (catmull-rom interpolates).
    for (const p of ring(50, 12)) expect(nearestOn(line, p).offset).toBeLessThan(0.05);
  });

  it('level frames stay upright; nearest gives signed lateral offsets', () => {
    const line = centerline({ ...SPEC, points: [[0, 0, 0], [0, 5, 50], [0, 0, 100]] });
    for (const s of line.samples) {
      expect(Math.abs(s.right[1])).toBeLessThan(1e-9);
      expect(s.up[1]).toBeGreaterThan(0.9);
      expect(Math.abs(dot(s.right, s.tangent))).toBeLessThan(1e-9);
    }
    // Facing +z, right is +x.
    expect(line.samples[0]!.right[0]).toBeCloseTo(1, 6);
    const hit = nearestOn(line, [3, 0, 10]);
    expect(hit.lateral).toBeGreaterThan(2.9);
    expect(hit.sample.distance).toBeGreaterThan(9);
  });

  it('auto bank leans into turns, clamped; authored bank interpolates', () => {
    // Counter-clockwise from above is a left turn when travelling +z at x = r... check the sign against right.
    const line = centerline({ ...SPEC, points: ring(30, 16), closed: true, autoBank: 10, bankRadius: 20 });
    const s = line.samples[10]!;
    // Turning towards the center: the center is on the side the bank lowers.
    const toCenter = [-s.point[0], 0, -s.point[2]];
    expect(Math.abs(s.bank)).toBeGreaterThan(5);
    expect(Math.abs(s.bank)).toBeLessThanOrEqual(10 + 1e-9);
    // Banked: up tilts towards the turn's center.
    expect(dot(s.up, toCenter)).toBeGreaterThan(0);
    const authored = centerline({ ...SPEC, points: [[0, 0, 0], [0, 0, 50], [0, 0, 100]], curve: 'linear', bank: [0, 20, 0] });
    expect(sampleAt(authored, 50).bank).toBeCloseTo(20, 6);
    expect(sampleAt(authored, 25).bank).toBeCloseTo(10, 6);
  });

  it('transport frames follow a vertical loop and close their seam', () => {
    const loop: [number, number, number][] = Array.from({ length: 16 }, (_, i) => {
      const a = (2 * Math.PI * i) / 16;
      return [i * 0.3, 20 + 20 * Math.sin(a), 20 * Math.cos(a)];
    });
    const line = centerline({ ...SPEC, points: loop, closed: true, frame: 'transport' });
    for (const s of line.samples) {
      expect(Math.abs(dot(s.right, s.tangent))).toBeLessThan(1e-6);
      expect(Math.hypot(...s.up)).toBeCloseTo(1, 6);
    }
    const a = line.samples[0]!;
    const b = line.samples[line.samples.length - 1]!;
    expect(dot(a.right, b.right)).toBeGreaterThan(0.95);
  });

  it('bezier and spec problems', () => {
    expect(splineProblem({ ...SPEC, curve: 'bezier', points: [[0, 0, 0], [1, 0, 0], [2, 0, 0]] })).toContain('3k + 1');
    expect(splineProblem({ ...SPEC, points: [[0, 0, 0], [1, 0, 0]], bank: [1] })).toContain('bank');
    const line = centerline({ ...SPEC, curve: 'bezier', points: [[0, 0, 0], [0, 0, 10], [10, 0, 20], [20, 0, 20]] });
    line.samples[line.samples.length - 1]!.point.forEach((v, k) => expect(v).toBeCloseTo([20, 0, 20][k]!, 6));
  });
});

describe('sweeps', () => {
  const layer = (over: Partial<SweepLayerSpec> = {}): SweepLayerSpec => ({
    profile: BUILTIN_PROFILES['road']!, width: 8, height: 0.3, offset: [0, 0], uvLength: 4, uvWidth: 4, start: 0, end: undefined,
    caps: false, stripe: undefined, colors: [[1, 1, 1, 1]], ...over,
  });

  it('a closed road loop is watertight, wound outward, its top facing up', () => {
    const line = centerline({ ...SPEC, points: ring(40, 10), closed: true, spacing: 2 });
    const road = sweepLayer(line, layer());
    expect(windingAgrees(road)).toBe(true);
    expect(watertight(road.positions, road.indices)).toBe(true);
    let up = 0;
    for (let i = 1; i < road.normals.length; i += 3) if (road.normals[i]! > 0.99) up++;
    expect(up).toBeGreaterThan(0);
  });

  it('a capped tube on an open path is closed; a pipe faces inward', () => {
    const line = centerline({ ...SPEC, points: [[0, 0, 0], [5, 2, 20], [0, 4, 40]] });
    const tube = sweepLayer(line, layer({ profile: BUILTIN_PROFILES['tube']!, width: 2, height: 2, caps: true }));
    expect(windingAgrees(tube)).toBe(true);
    expect(watertight(tube.positions, tube.indices)).toBe(true);
    const pipe = sweepLayer(line, layer({ profile: BUILTIN_PROFILES['pipe']!, width: 4, height: 4 }));
    // Inward: normals point towards the path.
    const s = sampleAt(line, 20);
    let toward = 0;
    let total = 0;
    for (let i = 0; i < pipe.positions.length; i += 3) {
      const p = [pipe.positions[i]!, pipe.positions[i + 1]!, pipe.positions[i + 2]!];
      if (Math.abs(dot(p.map((v, k) => v - s.point[k]!), s.tangent)) > 0.5) continue;
      total++;
      if (dot([pipe.normals[i]!, pipe.normals[i + 1]!, pipe.normals[i + 2]!], s.point.map((v, k) => v - p[k]!)) > 0) toward++;
    }
    expect(total).toBeGreaterThan(0);
    expect(toward).toBe(total);
  });

  it('stripes change color sharply at band edges and partial sweeps stay in range', () => {
    const line = centerline({ ...SPEC, points: [[0, 0, 0], [0, 0, 20]], curve: 'linear', spacing: 2.5 });
    const kerb = sweepLayer(line, layer({ profile: BUILTIN_PROFILES['kerb']!, width: 1, height: 0.1, stripe: 2, colors: [[1, 0, 0, 1], [1, 1, 1, 1]], start: 1, end: 9 }));
    expect(windingAgrees(kerb)).toBe(true);
    let minZ = Infinity;
    let maxZ = -Infinity;
    const colorAt = new Map<string, Set<number>>();
    for (let v = 0; v < kerb.positions.length / 3; v++) {
      const z = kerb.positions[v * 3 + 2]!;
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
      const key = z.toFixed(4);
      const set = colorAt.get(key) ?? new Set();
      set.add(kerb.colors![v * 4 + 1]!);
      colorAt.set(key, set);
    }
    expect(minZ).toBeCloseTo(1, 6);
    expect(maxZ).toBeCloseTo(9, 6);
    // Band edges (2, 4, 6, 8) carry both colors; the 2.5 m samples between carry one.
    for (const edge of ['2.0000', '4.0000', '6.0000', '8.0000']) expect(colorAt.get(edge)?.size).toBe(2);
    // Band 0 (1..2 m) red, band 1 (2..4 m) white.
    expect([...colorAt.get('1.0000')!]).toEqual([0]);
    expect([...colorAt.get('2.5000')!]).toEqual([1]);
  });
});

describe('lathe', () => {
  it('a capped vase is watertight and faces outward', () => {
    const vase = latheMesh({ profile: [[0.3, 0], [0.5, 0.4], [0.25, 0.9], [0.3, 1]], segments: 16, sweep: 360, caps: true, hard: false, tile: 1 });
    expect(windingAgrees(vase)).toBe(true);
    expect(watertight(vase.positions, vase.indices)).toBe(true);
    const faceted = latheMesh({ profile: [[1, 0], [1, 2]], segments: 6, sweep: 360, caps: true, hard: true, tile: 1 });
    expect(watertight(faceted.positions, faceted.indices)).toBe(true);
    // Outward: side normals point away from the axis.
    for (let i = 0; i < faceted.positions.length; i += 3) {
      const r = [faceted.positions[i]!, 0, faceted.positions[i + 2]!];
      const n = [faceted.normals[i]!, faceted.normals[i + 1]!, faceted.normals[i + 2]!];
      if (Math.abs(n[1]!) < 0.5) expect(dot(r, n)).toBeGreaterThan(0);
    }
  });
});

const HOUSE: StructureSpec = {
  floors: [
    { plan: ['..........', '##+####=##', '#kkk#llll#', '#kkk+llll#', '#kkk#lll##', '#####=####'], height: 3 },
    { plan: ['..........', '..........', '##########', '#bbbbbbbb#', '#bbbbbbbb#', '##########'], height: 3 },
  ],
  legend: { k: { name: 'kitchen', floor: 'tiles' }, l: { name: 'living', floor: 'wood' } },
  cell: 1, slab: 0.2, doorHeight: 2.2, windowSill: 0.9, windowHeight: 1.2, roof: { type: 'gable', pitch: 30, overhang: 0.3 },
};

describe('structures', () => {
  it('builds rooms, doors and windows from the plan, deterministically', () => {
    expect(structureProblems(HOUSE)).toEqual([]);
    const a = buildStructure(HOUSE);
    const b = buildStructure(HOUSE);
    expect(JSON.stringify([...a.solid].map(([k, m]) => [k, m.positions]))).toBe(JSON.stringify([...b.solid].map(([k, m]) => [k, m.positions])));
    expect(a.rooms.map((r) => r.id)).toEqual(['kitchen', 'living', 'b@1']);
    const kitchen = a.rooms[0]!;
    expect(kitchen.area).toBe(9);
    const doors = a.openings.filter((o) => o.kind === 'door');
    expect(doors.map((d) => d.rooms)).toEqual([['kitchen', 'living'], ['kitchen', 'outside']]);
    // The kitchen–living door is in a wall along z: it faces +x.
    expect(doors[0]!.yaw).toBe(90);
    expect(a.openings.filter((o) => o.kind === 'window')).toHaveLength(2);
    expect(a.glass.triangleCount).toBeGreaterThan(0);
    for (const [, mesh] of a.solid) expect(windingAgrees(mesh.build())).toBe(true);
    // Every room is reachable from outside through doors (connectivity over the plan).
    const graph = new Map<string, Set<string>>();
    for (const d of doors) {
      for (const [x, y] of [[d.rooms[0], d.rooms[1]], [d.rooms[1], d.rooms[0]]] as const) {
        if (!graph.has(x)) graph.set(x, new Set());
        graph.get(x)!.add(y);
      }
    }
    const seen = new Set(['outside']);
    const queue = ['outside'];
    while (queue.length > 0) for (const n of graph.get(queue.shift()!) ?? []) if (!seen.has(n)) { seen.add(n); queue.push(n); }
    expect(seen.has('kitchen') && seen.has('living')).toBe(true);
  });

  it('roofs cover what nothing covers; pitched planes face up and out', () => {
    const g = buildStructure(HOUSE);
    const roof = g.solid.get('roof')!.build();
    // Half the roof triangles are undersides (closed eaves): count both directions.
    let up = 0;
    let down = 0;
    for (let i = 1; i < roof.normals.length; i += 3) (roof.normals[i]! > 0 ? up++ : down++);
    expect(up).toBe(down);
    expect(roof.max[1]).toBeGreaterThan(6);
    const flat = buildStructure({ ...HOUSE, roof: { type: 'flat', pitch: 30, overhang: 0 } });
    // The ground floor's front row (text row 1) has nothing above: it gets a flat slab at 3 m.
    expect(flat.solid.get('roof')!.build().min[1]).toBeCloseTo(3, 6);
    for (const type of ['hip', 'shed'] as const) {
      const r = buildStructure({ ...HOUSE, roof: { type, pitch: 35, overhang: 0.2 } });
      expect(windingAgrees(r.solid.get('roof')!.build())).toBe(true);
      expect(windingAgrees(r.solid.get('wall')!.build())).toBe(true);
    }
  });

  it('reports plan problems with positions', () => {
    const bad = structureProblems({ ...HOUSE, floors: [{ plan: ['#+#', '.+.', '#?#'], height: 3 }] });
    expect(bad.map((p) => [p.row, p.column])).toEqual([[1, 1], [2, 1]]);
    expect(bad[0]!.message).toContain('not in a wall line');
  });
});

const DUNGEON: DungeonSpec = { seed: 7, rooms: 14, locks: 2, treasures: 2, loops: 1, roomSize: [5, 9], corridor: 2, tile: 2, wallHeight: 4, ceiling: false };

describe('dungeons', () => {
  it('is deterministic in its seed', () => {
    const a = layoutDungeon(DUNGEON);
    expect(JSON.stringify({ ...a, tiles: [...a.tiles] })).toBe(JSON.stringify({ ...layoutDungeon(DUNGEON), tiles: [...layoutDungeon(DUNGEON).tiles] }));
    const other = layoutDungeon({ ...DUNGEON, seed: 8 });
    expect([...other.tiles]).not.toEqual([...a.tiles]);
  });

  it('every room is reachable collecting keys, and no lock is bypassable', () => {
    for (let seed = 0; seed < 40; seed++) {
      const spec = { ...DUNGEON, seed, rooms: 8 + (seed % 20), locks: seed % 4, corridor: 1 + (seed % 3) };
      const layout = layoutDungeon(spec);
      expect(layout.rooms).toHaveLength(spec.rooms);
      expect(new Set(reachable(layout)).size).toBe(spec.rooms);
      // Without the keys, the objective (behind every lock) is out of reach.
      if (spec.locks > 0) {
        const keyless = { ...layout, rooms: layout.rooms.map((r) => ({ ...r, key: null })) };
        const objective = layout.rooms.find((r) => r.role === 'objective')!;
        expect(reachable(keyless)).not.toContain(objective.id);
        // Each key lies before its lock: reachable with only the earlier keys.
        for (const room of layout.rooms.filter((r) => r.key !== null)) {
          const earlier = { ...layout, rooms: layout.rooms.map((r) => ({ ...r, key: r.key !== null && r.key < room.key! ? r.key : null })) };
          expect(reachable(earlier)).toContain(room.id);
        }
      }
      // Rooms never overlap; walls enclose every floor tile.
      const { width, depth, tiles } = layout;
      for (let j = 0; j < depth; j++) {
        for (let i = 0; i < width; i++) {
          const t = tiles[j * width + i]!;
          if (t !== 1 && t !== 2) continue;
          expect(i > 0 && j > 0 && i < width - 1 && j < depth - 1).toBe(true);
          for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) expect(tiles[(j + dj!) * width + i + di!]).not.toBe(0);
        }
      }
    }
  });

  it('meshes floors and walls, wound outward', () => {
    const layout = layoutDungeon(DUNGEON);
    const g = dungeonGeometry(layout, DUNGEON);
    expect(windingAgrees(g.floor.build())).toBe(true);
    expect(windingAgrees(g.walls.build())).toBe(true);
    expect([...layout.tiles].filter((t) => t === WALL).length).toBeGreaterThan(0);
  });
});

describe('prop kits', () => {
  const KIT: PropKit = {
    id: 'crypt', density: 20, maxPerRoom: 12, wallStep: 2, clearance: 1.5, inset: 0.5,
    props: [
      { prefab: 'brazier', place: 'corner', weight: 1, radius: 0.4, scale: [1, 1] },
      { prefab: 'coffin', place: 'wall', weight: 1, radius: 0.6, scale: [1, 1] },
      { prefab: 'bones', place: 'floor', weight: 1, radius: 0.3, scale: [0.8, 1.2] },
    ],
  };
  it('respects the budget, the room, keep-clear points and spacing; same seed, same props', () => {
    const room = { x0: 0, z0: 0, x1: 10, z1: 8 };
    const a = dressRoom(KIT, room, new SeededRandom(3), { keepClear: [[5, 0], [5, 4]], center: false });
    expect(a).toEqual(dressRoom(KIT, room, new SeededRandom(3), { keepClear: [[5, 0], [5, 4]], center: false }));
    expect(a.length).toBeLessThanOrEqual(12);
    expect(a.filter((p) => p.place === 'corner')).toHaveLength(4);
    for (const p of a) {
      expect(p.x).toBeGreaterThanOrEqual(0.5);
      expect(p.x).toBeLessThanOrEqual(9.5);
      expect(Math.hypot(p.x - 5, p.z - 4)).toBeGreaterThanOrEqual(1.5);
      expect(Math.hypot(p.x - 5, p.z - 0)).toBeGreaterThanOrEqual(1.5);
    }
    for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) expect(Math.hypot(a[i]!.x - a[j]!.x, a[i]!.z - a[j]!.z)).toBeGreaterThan(0.4);
  });
});

// ── The plugin in a kernel ─────────────────────────────────────────────────────

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

const PROJECT = {
  'prefabs/empty.prefab.json': { components: {} },
  'prefabs/key.prefab.json': { components: {} },
  'prefabs/gate.prefab.json': { components: {} },
  'prefabs/boss.prefab.json': { components: {} },
  'prefabs/bones.prefab.json': { components: {} },
  'prefabs/door.prefab.json': { components: {} },
  'content/prop_kit/crypt.json': { density: 10, props: [{ prefab: 'bones', place: 'floor', radius: 0.3 }] },
  'content/profile/gutter.json': { points: [[0.5, 0.2], [0.3, 0], [-0.3, 0], [-0.5, 0.2]], smooth: true },
  'scenes/s/scene.json': {
    mode: '3d',
    entities: [
      {
        id: 'track', prefab: 'empty', at: [100, 0, 0],
        components: {
          spline: { points: ring(60, 8), closed: true, auto_bank: 6 },
          sweep: { parts: [{ profile: 'road', width: 10 }, { profile: 'kerb', offset: [5.5, 0], mirror: true, stripe: 2, colors: ['#e0453f', '#f2ece0'] }, { profile: 'gutter', collide: false }] },
        },
      },
      { id: 'house', prefab: 'empty', at: [0, 0, 50], components: { structure: { floors: [{ plan: HOUSE.floors[0]!.plan }], door_prefab: 'door', kit: 'crypt', roof: { kind: 'hip' } } } },
      { id: 'crypt', prefab: 'empty', at: [0, 0, -200], components: { dungeon: { seed: 4, rooms: 8, locks: 1, key_prefab: 'key', gate_prefab: 'gate', objective_prefab: 'boss', kit: 'crypt' } } },
    ],
  },
};

function start(extra: Record<string, unknown> = {}) {
  const project = loadProject(files({ ...PROJECT, ...extra }));
  const game: GameDefinition = { components: [], resources: [], events: [], behaviors: [], systems: [] };
  const kernel = new Kernel({ project, game, plugins: [procgen()] });
  kernel.start('s');
  return kernel;
}

describe('procgen plugin', () => {
  it('serves meshes with world matrices and world-space collision, and paths', () => {
    const kernel = start();
    const service = kernel.service(PROCGEN_SERVICE);
    const meshes = service.meshes();
    expect(meshes.map((m) => m.key.split(':')[0])).toEqual(['dungeon', 'structure', 'sweep']);
    const track = meshes.find((m) => m.key.startsWith('sweep'))!;
    // road, kerb, mirrored kerb, gutter
    expect(track.parts).toHaveLength(4);
    expect(track.parts[1]!.geometry.colors).not.toBeNull();
    expect(track.world[12]).toBe(100);
    // Collision is world space and leaves the gutter out.
    const xs = Array.from(track.collision!.vertices.filter((_, i) => i % 3 === 0));
    expect(Math.min(...xs)).toBeGreaterThan(100 - 70);
    expect(service.meshes()[2]).toBe(track);
    const [path] = service.paths();
    expect(path!.length).toBeGreaterThan(2 * Math.PI * 60 * 0.99);
    const hit = path!.nearest(160, 0, 0);
    expect(hit.offset).toBeLessThan(0.5);
  });

  it('Spline methods answer in world space; edits rebuild', () => {
    const kernel = start();
    const [id, spline] = kernel.world.query(['spline'])[0]! as [never, Fields & Record<string, (...a: unknown[]) => unknown>];
    const length = spline['length']!() as number;
    const p = spline['sample']!(0) as { point: Vec3 };
    expect(p.point.x).toBeCloseTo(160, 3);
    const hit = spline['nearest']!(new Vec3(165, 0, 0)) as { lateral: number; distance: number };
    expect(Math.abs(hit.lateral)).toBeCloseTo(5, 1);
    expect(spline['progress']!(new Vec3(100, 0, 60)) as number).toBeGreaterThan(0.2);
    expect((spline['polyline']!(10) as Vec3[]).length).toBe(Math.round(length / 10));
    const before = kernel.service(PROCGEN_SERVICE).meshes().find((m) => m.key.startsWith('sweep'))!.version;
    (spline as Fields)['points'] = ring(80, 8).map(([x, y, z]) => new Vec3(x, y, z));
    expect(kernel.service(PROCGEN_SERVICE).meshes().find((m) => m.key.startsWith('sweep'))!.version).toBeGreaterThan(before);
    expect(kernel.service(PROCGEN_SERVICE).path(id)!.length).toBeGreaterThan(2 * Math.PI * 79);
    try { spline['sample']!('far'); } catch (e) { expect((e as ParallaxError).diagnostic.code).toBe('PP3643'); }
  });

  it('spawns pieces once, as children with generated_piece; snapshots keep them single', () => {
    const kernel = start();
    kernel.step(1 / 60);
    const pieces = () => kernel.world.query([PIECE]).map(([, f]) => (f as Fields)['role'] as string);
    const roles = pieces();
    expect(roles.filter((r) => r === 'key')).toHaveLength(1);
    expect(roles.filter((r) => r === 'gate')).toHaveLength(1);
    expect(roles.filter((r) => r === 'objective')).toHaveLength(1);
    expect(roles.filter((r) => r === 'door').length).toBe(2);
    expect(roles.filter((r) => r === 'prop').length).toBeGreaterThan(0);
    const count = roles.length;
    kernel.step(1 / 60);
    expect(pieces()).toHaveLength(count);
    const snap = kernel.snapshot();
    kernel.restore(snap);
    kernel.step(1 / 60);
    expect(pieces()).toHaveLength(count);
    // Changing the seed re-dresses: old pieces go, new ones come.
    const [, dungeon] = kernel.world.query(['dungeon'])[0]!;
    (dungeon as Fields)['seed'] = 5;
    kernel.step(1 / 60);
    expect(pieces().filter((r) => r === 'key')).toHaveLength(1);
  });

  it('bad data is a coded error', () => {
    const code = (fn: () => unknown): string | undefined => {
      try { fn(); } catch (e) { return (e as ParallaxError).diagnostic.code; }
      return undefined;
    };
    const k = start({ 'scenes/s/scene.json': { entities: [{ prefab: 'empty', components: { sweep: { parts: [{ profile: 'rode' }] } } }] } });
    expect(code(() => k.service(PROCGEN_SERVICE).meshes())).toBe('PP3641');
    const k2 = start({ 'scenes/s/scene.json': { entities: [{ prefab: 'empty', components: { spline: { points: [[0, 0, 0], [1, 0, 0]] }, sweep: { parts: [{ profile: 'rode' }] } } }] } });
    try { k2.service(PROCGEN_SERVICE).meshes(); } catch (e) { expect((e as ParallaxError).diagnostic.fix).toContain('road'); }
    const k3 = start({ 'scenes/s/scene.json': { entities: [{ prefab: 'empty', components: { structure: { floors: [{ plan: ['#+.'] }] } } }] } });
    expect(code(() => k3.service(PROCGEN_SERVICE).meshes())).toBe('PP3650');
  });
});
