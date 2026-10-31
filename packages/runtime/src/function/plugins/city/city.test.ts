import { describe, expect, it } from 'vitest';
import { ParallaxError, Vec3 } from '../../../core/index.js';
import type { ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel } from '../../kernel/index.js';
import type { GameDefinition, KernelPlugin } from '../../kernel/index.js';
import { CITY_SERVICE, STREAMING_SERVICE } from '../../services/index.js';
import {
  buildChunkJob, buildLanes, buildWalkGraph, chunkCollision, chunkGeometry, city, CITY_CAR, CITY_PIECE, CITY_WALKER, cityModel, generateCity,
  indexChunks, inQuad, pathAt, quadCenter, readCitySpec, signalState,
} from './index.js';
import type { CitySpec } from './index.js';

const AREA = { center: [0, 0], size: [600, 520] };

function spec(extra: Record<string, unknown> = {}): CitySpec {
  return readCitySpec({ seed: 11, area: AREA, ...extra } as never);
}

function digest(value: unknown): string {
  const text = JSON.stringify(value, (_k, v) => (ArrayBuffer.isView(v) ? Array.from(v as Float32Array).map((n) => Math.round(n * 1000)) : v));
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 31) + text.charCodeAt(i)) | 0;
  return `${text.length}:${h}`;
}

describe('city spec', () => {
  it('fills a style\'s defaults and keeps authored overrides', () => {
    const s = spec({ style: 'suburb', roads: { block: [100, 80] } });
    expect(s.roads.block).toEqual([100, 80]);
    expect(s.roads.merge).toBeGreaterThan(0.1);
    expect(s.buildings.height[1]).toBeLessThan(20);
    expect(s.traffic.signals.cycle).toBe(30);
  });

  it('reports bad data with a pointer and a fix', () => {
    const bad = (block: unknown): ParallaxError => {
      try {
        readCitySpec(block as never, 'city');
      } catch (e) {
        return e as ParallaxError;
      }
      throw new Error('expected a failure');
    };
    expect(bad({}).message).toMatch(/city\/area: is required/);
    expect(bad({ area: AREA, stlye: 'grid' }).message).toMatch(/"stlye" is not a field/);
    expect(bad({ area: AREA, stlye: 'grid' }).diagnostic.fix).toMatch(/style/);
    expect(bad({ area: AREA, style: 'metropoliss' }).diagnostic.fix).toMatch(/metropolis/);
    expect(bad({ area: AREA, traffic: { cars: 4 } }).message).toMatch(/traffic\/prefabs/);
    expect(bad({ area: AREA, landmarks: [{ kind: 'bridge', from: [0, 0] }] }).message).toMatch(/landmarks\/0\/to/);
    expect(bad({}).diagnostic.code).toBe('PP7600');
    // Regions are footprints: old corner lists fail naming the schema.
    expect(bad({ area: [[-300, -260], [300, 260]] }).diagnostic.fix).toMatch(/"center"/);
    expect(bad({ area: AREA, exclude: [[-20, -100, 20, 100]] }).message).toMatch(/exclude\/0/);
    expect(bad({ area: { center: [0, 0], radius: 300 } }).message).toMatch(/unrotated/);
  });
});

describe('city plan', () => {
  const s = spec({ landmarks: [{ kind: 'tower', at: [10, 10], height: 260 }, { kind: 'park', at: [-180, 120], size: [150, 110] }] });
  const layout = generateCity(s, 0);

  it('leaves an excluded rectangle alone but builds right up to it', () => {
    const rect = [-20, -100, 20, 100] as const;
    const cut = generateCity(spec({ exclude: [{ center: [0, 0], size: [40, 200] }] }), 0);
    const hits = (x: number, z: number): boolean => x >= rect[0] && x <= rect[2] && z >= rect[1] && z <= rect[3];
    for (const c of cut.cells) for (const [x, z] of c.curb) expect(hits(x, z)).toBe(false);
    for (const e of cut.edges) {
      const A = cut.nodes[e.a]!;
      const B = cut.nodes[e.b]!;
      expect(hits((A.x + B.x) / 2, (A.z + B.z) / 2)).toBe(false);
    }
    // Blocks reaching into it are cut back to its edge (plus the 4 m margin), not dropped.
    const gap = Math.min(...cut.cells.filter((c) => c.curb.some(([, z]) => Math.abs(z) < 90)).map((c) => Math.min(...c.curb.map(([x]) => Math.abs(x) - 20))));
    expect(gap).toBeLessThan(12);
  });

  it('is deterministic from the seed', () => {
    expect(digest(generateCity(s, 0))).toBe(digest(layout));
    expect(digest(generateCity({ ...s, seed: 12 }, 0))).not.toBe(digest(layout));
  });

  it('lays out streets, blocks, buildings and furniture in sensible numbers', () => {
    expect(layout.edges.length).toBeGreaterThan(40);
    expect(layout.cells.length).toBeGreaterThan(20);
    expect(layout.buildings.length).toBeGreaterThan(150);
    expect(layout.props.filter((p) => p.role === 'streetlight').length).toBeGreaterThan(100);
    expect(layout.edges.filter((e) => e.major).length).toBeGreaterThan(5);
    const downtown = layout.buildings.filter((b) => b.district === 'downtown');
    expect(Math.max(...downtown.map((b) => b.height))).toBeGreaterThan(60);
    expect(layout.buildings.some((b) => b.archetype === 'spire' && b.height === 260)).toBe(true);
    expect(layout.cells.filter((c) => c.kind === 'park').length).toBeGreaterThan(0);
  });

  it('keeps buildings inside their lots and apart from each other', () => {
    for (const b of layout.buildings) {
      const cell = layout.cells[b.cell]!;
      const c = quadCenter(b.footprint);
      expect(inQuad(cell.lot, c[0], c[1])).toBe(true);
      for (const p of b.footprint) expect(inQuad(cell.corners, p[0], p[1])).toBe(true);
    }
    for (const cell of layout.cells) {
      const inCell = layout.buildings.filter((b) => b.cell === cell.id);
      for (const a of inCell) {
        for (const b of inCell) {
          if (a === b) continue;
          const c = quadCenter(b.footprint);
          expect(inQuad(a.footprint, c[0], c[1])).toBe(false);
        }
      }
    }
  });

  it('is one connected street network; every lane leads on and reaches every other', () => {
    const seen = new Set<number>([layout.edges[0]!.a]);
    const stack = [layout.edges[0]!.a];
    while (stack.length > 0) {
      const n = layout.nodes[stack.pop()!]!;
      for (const e of n.edges) {
        const edge = layout.edges[e]!;
        const o = edge.a === n.id ? edge.b : edge.a;
        if (!seen.has(o)) {
          seen.add(o);
          stack.push(o);
        }
      }
    }
    expect(seen.size).toBe(layout.nodes.filter((n) => n.edges.length > 0).length);
    const graph = buildLanes(layout, { drive: 'right', speed: 12, seed: s.seed, signals: s.traffic.signals });
    expect(graph.lanes.every((l) => l.out.length > 0)).toBe(true);
    const reached = new Set<number>([0]);
    const queue = [0];
    while (queue.length > 0) {
      const lane = graph.lanes[queue.shift()!]!;
      for (const c of lane.out) {
        const to = graph.connectors[c]!.to;
        if (!reached.has(to)) {
          reached.add(to);
          queue.push(to);
        }
      }
    }
    expect(reached.size).toBe(graph.lanes.length);
  });

  it('signals never show green to crossing axes at once, and cycle through yellow', () => {
    const graph = buildLanes(layout, { drive: 'right', speed: 12, seed: s.seed, signals: s.traffic.signals });
    expect(graph.signals.size).toBeGreaterThan(5);
    let yellow = 0;
    for (let t = 0; t < 60; t += 0.5) {
      for (const node of graph.signals.keys()) {
        const approaches = graph.approaches.filter((a) => a.node === node);
        const green = approaches.filter((a) => signalState(graph, a, t, s.traffic.signals) !== 'red');
        expect(new Set(green.map((a) => a.phase)).size).toBeLessThanOrEqual(1);
        yellow += approaches.filter((a) => signalState(graph, a, t, s.traffic.signals) === 'yellow').length;
      }
    }
    expect(yellow).toBeGreaterThan(0);
  });

  it('connects the sidewalks into one walkable network with crosswalks', () => {
    const walk = buildWalkGraph(layout);
    expect(walk.edges.filter((e) => e.crossing !== null).length).toBeGreaterThan(30);
    const seen = new Set([0]);
    const stack = [0];
    while (stack.length > 0) {
      for (const e of walk.nodes[stack.pop()!]!.edges) {
        const edge = walk.edges[e]!;
        for (const o of [edge.a, edge.b]) {
          if (!seen.has(o)) {
            seen.add(o);
            stack.push(o);
          }
        }
      }
    }
    expect(seen.size / walk.nodes.length).toBeGreaterThan(0.9);
  });

  it('builds every chunk at three levels, coarser ones lighter; collision everywhere; jobs match', () => {
    const model = cityModel(s, 0);
    const counts = [0, 0, 0];
    for (const content of model.index.chunks.values()) {
      for (const lod of [0, 1, 2] as const) {
        const g = chunkGeometry(model.layout, model.graph, content, lod, { builtinLamps: true, drive: 'right' });
        for (const part of Object.values(g.parts)) counts[lod]! += part === null ? 0 : part.positions.length / 3;
      }
      expect(chunkCollision(model.layout, content).indices.length).toBeGreaterThan(0);
    }
    expect(counts[0]!).toBeGreaterThan(counts[1]! * 2);
    expect(counts[1]!).toBeGreaterThan(counts[2]!);
    const key = [...model.index.chunks.keys()][0]!;
    const direct = chunkGeometry(model.layout, model.graph, model.index.chunks.get(key)!, 0, { builtinLamps: true, drive: 'right' });
    expect(digest(buildChunkJob({ spec: s, ground: 0, chunk: key, lod: 0, builtinLamps: true }))).toBe(digest(direct));
  });

  it('faces streets in asphalt and masonry walls in brick or plaster, with seamless world-projected UVs', () => {
    const model = cityModel(s, 0);
    let asphalt = 0;
    let masonry = 0;
    for (const content of model.index.chunks.values()) {
      const g = chunkGeometry(model.layout, model.graph, content, 0, { builtinLamps: false, drive: 'right' });
      asphalt += g.parts.asphalt?.indices.length ?? 0;
      masonry += (g.parts.brick?.indices.length ?? 0) + (g.parts.plaster?.indices.length ?? 0);
      const road = g.parts.asphalt;
      if (road !== null) {
        // Horizontal: u, v = x, z over the 8 m tile, so neighbouring strips line up.
        expect(road.uvs[0]!).toBeCloseTo(road.positions[0]! / 8, 4);
        expect(road.uvs[1]!).toBeCloseTo(road.positions[2]! / 8, 4);
      }
    }
    expect(asphalt).toBeGreaterThan(0);
    expect(masonry).toBeGreaterThan(0);
  });

  it('faces building walls outward', () => {
    const model = cityModel(s, 0);
    const b = model.layout.buildings.find((x) => x.archetype === 'block')!;
    const content = indexChunks(model.layout, model.graph, s.lod.chunk);
    const chunk = [...content.chunks.values()].find((c) => c.buildings.includes(b.id))!;
    const g = chunkGeometry(model.layout, model.graph, { ...chunk, edges: [], nodes: [], cells: [], props: [], approaches: [], landmarks: [], buildings: [b.id] }, 2, { builtinLamps: false, drive: 'right' });
    const m = g.parts.matte!;
    const [cx, cz] = quadCenter(b.footprint);
    let walls = 0;
    for (let i = 0; i < m.normals.length; i += 3) {
      if (Math.abs(m.normals[i + 1]!) > 0.5) continue;
      walls++;
      const out = (m.positions[i]! - cx) * m.normals[i]! + (m.positions[i + 2]! - cz) * m.normals[i + 2]!;
      expect(out).toBeGreaterThan(0);
    }
    expect(walls).toBeGreaterThan(0);
  });
});

// ── The plugin in a kernel ──────────────────────────────────────────────────────

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

/** A streaming source the test moves (stands in for the core streaming plugin). */
function source(at: { p: Vec3 }): KernelPlugin {
  return {
    id: 'test_source',
    install(k) {
      k.provide(STREAMING_SERVICE, { current: () => null, sources: () => [{ entity: 0 as never, position: at.p }] });
    },
  };
}

const BLOCK = {
  seed: 5, area: AREA,
  props: { streetlight: 'lamp', hydrant: 'hydrant', parked: ['car'], radius: 80 },
  traffic: { cars: 12, prefabs: ['car'], radius: 150, spawn_min: 30 },
  pedestrians: { count: 10, prefabs: ['walker'], radius: 80, spawn_min: 15 },
};

function start(block: unknown = BLOCK) {
  const project = loadProject(files({
    'prefabs/car.prefab.json': { components: {} },
    'prefabs/walker.prefab.json': { components: {} },
    'prefabs/lamp.prefab.json': { components: {} },
    'prefabs/hydrant.prefab.json': { components: {} },
    'scenes/town/scene.json': { city: block, entities: [] },
  }));
  const game: GameDefinition = { components: [], resources: [], events: [], behaviors: [], systems: [] };
  const at = { p: new Vec3(0, 0, 0) };
  const plugin = city();
  const kernel = new Kernel({ project, game, plugins: [source(at), plugin] });
  kernel.start('town');
  return { kernel, plugin, at };
}

const DT = 1 / 60;
const positions = (k: Kernel, component: string): string =>
  k.world.query([component]).map(([id]) => {
    const p = k.world.get(id)!.transform.position;
    return `${id}:${p.x.toFixed(3)},${p.z.toFixed(3)}`;
  }).join('|');

describe('city plugin', () => {
  it('serves chunk meshes with collision, finer near the source', () => {
    const { kernel } = start();
    const meshes = kernel.service(CITY_SERVICE).meshes();
    expect(meshes.length).toBeGreaterThan(10);
    expect(meshes.filter((m) => m.collision !== null).length).toBeGreaterThan(10);
    const near = meshes.find((m) => m.key === 'city:0,0')!;
    const far = meshes.find((m) => m.key === 'city:2,1') ?? meshes.find((m) => m.key.startsWith('city:-3'))!;
    const verts = (m: typeof near): number => m.parts.reduce((n, p) => n + p.geometry.positions.length / 3, 0);
    expect(verts(near)).toBeGreaterThan(verts(far));
    // Same frame, same list; collision versions stay put as levels change.
    expect(kernel.service(CITY_SERVICE).meshes()).toBe(meshes);
  });

  it('serves the city as a plan view for the minimap, the same object until rebuilt', () => {
    const { kernel } = start();
    const map = kernel.service(CITY_SERVICE).map()!;
    expect(map.streets.length).toBeGreaterThan(10);
    expect(map.streets.some((s) => s.major)).toBe(true);
    expect(map.streets.some((s) => !s.major)).toBe(true);
    expect(map.streets.every((s) => s.width > 0)).toBe(true);
    expect(map.blocks.length).toBeGreaterThan(4);
    expect(map.buildings.length).toBeGreaterThan(4);
    expect(map.bounds[2]).toBeGreaterThan(map.bounds[0]);
    expect(kernel.service(CITY_SERVICE).map()).toBe(map);
  });

  it('fills the streets with cars and walkers and streams props around the source', () => {
    const { kernel, at } = start();
    for (let i = 0; i < 240; i++) kernel.step(DT);
    const within = (component: string, r: number): number => kernel.world.query([component]).filter(([id]) => kernel.world.get(id)!.transform.position.flat().length() <= r).length;
    expect(within(CITY_CAR, 150)).toBe(12);
    expect(within(CITY_WALKER, 80)).toBe(10);
    const props = kernel.world.query([CITY_PIECE]);
    expect(props.length).toBeGreaterThan(10);
    for (const [id] of props) expect(kernel.world.get(id)!.transform.position.flat().length()).toBeLessThan(80 * 1.2);
    // Cars move along their lanes.
    const before = positions(kernel, CITY_CAR);
    for (let i = 0; i < 60; i++) kernel.step(DT);
    expect(positions(kernel, CITY_CAR)).not.toBe(before);
    // Move the source: props follow, far traffic is replaced.
    at.p = new Vec3(200, 0, 150);
    for (let i = 0; i < 300; i++) kernel.step(DT);
    for (const [id] of kernel.world.query([CITY_PIECE])) {
      const p = kernel.world.get(id)!.transform.position;
      expect(Math.hypot(p.x - 200, p.z - 150)).toBeLessThan(80 * 1.2);
    }
    for (const [id] of kernel.world.query([CITY_CAR])) {
      const p = kernel.world.get(id)!.transform.position;
      expect(Math.hypot(p.x - 200, p.z - 150)).toBeLessThan(150 * 1.3);
    }
  });

  it('keeps cars apart and stops them on red', () => {
    const { kernel, plugin } = start({ ...BLOCK, traffic: { ...BLOCK.traffic, cars: 30 } });
    const model = plugin.engine.model()!;
    let violations = 0;
    let entered = 0;
    let signalled = 0;
    const onConnector = new Map<number, number>();
    for (let i = 0; i < 1800; i++) {
      kernel.step(DT);
      const cars = kernel.world.query([CITY_CAR]);
      for (const [id, f] of cars) {
        const connector = f!['connector'] as number;
        const was = onConnector.get(id) ?? -1;
        if (connector >= 0 && was !== connector) {
          entered++;
          const lane = model.graph.lanes[model.graph.connectors[connector]!.from]!;
          // Red for over a second (cars that committed on yellow may still clear the line as it turns).
          const red = (t: number): boolean => signalState(model.graph, model.graph.approaches[lane.approach]!, t, model.spec.traffic.signals) === 'red';
          if (model.graph.control.get(lane.to) === 'signal' && lane.approach >= 0) {
            signalled++;
            if (red(plugin.engine.time() - DT) && red(plugin.engine.time() - 1.2)) violations++;
          }
        }
        onConnector.set(id, connector);
      }
      // Same-lane neighbours never overlap.
      if (i % 30 === 0) {
        const byLane = new Map<number, number[]>();
        for (const [, f] of cars) if ((f!['connector'] as number) < 0) (byLane.get(f!['lane'] as number) ?? byLane.set(f!['lane'] as number, []).get(f!['lane'] as number)!).push(f!['s'] as number);
        for (const list of byLane.values()) {
          list.sort((a, b) => a - b);
          for (let j = 1; j < list.length; j++) expect(list[j]! - list[j - 1]!).toBeGreaterThan(3.5);
        }
      }
    }
    expect(entered).toBeGreaterThan(10);
    expect(signalled).toBeGreaterThan(3);
    expect(violations).toBe(0);
  });

  it('runs the same twice from the same seed, and restores a snapshot exactly', () => {
    const a = start();
    const b = start();
    for (let i = 0; i < 400; i++) {
      a.kernel.step(DT);
      b.kernel.step(DT);
    }
    expect(positions(a.kernel, CITY_CAR)).toBe(positions(b.kernel, CITY_CAR));
    expect(positions(a.kernel, CITY_WALKER)).toBe(positions(b.kernel, CITY_WALKER));
    const snap = a.kernel.snapshot();
    for (let i = 0; i < 200; i++) a.kernel.step(DT);
    const later = positions(a.kernel, CITY_CAR) + positions(a.kernel, CITY_WALKER);
    a.kernel.restore(snap);
    for (let i = 0; i < 200; i++) a.kernel.step(DT);
    expect(positions(a.kernel, CITY_CAR) + positions(a.kernel, CITY_WALKER)).toBe(later);
  });

  it('sends walkers running from an alarm', () => {
    const { kernel, plugin } = start();
    for (let i = 0; i < 120; i++) kernel.step(DT);
    const n = plugin.engine.alarm(new Vec3(0, 0, 0), 200, 5);
    expect(n).toBeGreaterThan(0);
    const fleeing = kernel.world.query([CITY_WALKER]).filter(([, f]) => (f!['flee'] as number) > 0);
    expect(fleeing.length).toBe(n);
  });

  it('names a missing prefab with a suggestion', () => {
    expect(() => start({ ...BLOCK, props: { streetlight: 'lammp' } })).not.toThrow();
    const { kernel } = start({ ...BLOCK, props: { streetlight: 'lammp' } });
    expect(() => kernel.step(DT)).toThrow(/no prefab "lammp"[\s\S]*/);
    try {
      kernel.step(DT);
    } catch (e) {
      expect((e as ParallaxError).diagnostic.fix).toMatch(/lamp/);
    }
  });

  it('kinematic cars sit on their lane', () => {
    const { kernel, plugin } = start();
    for (let i = 0; i < 200; i++) kernel.step(DT);
    const model = plugin.engine.model()!;
    for (const [id, f] of kernel.world.query([CITY_CAR])) {
      const connector = f!['connector'] as number;
      const path = connector >= 0 ? model.graph.connectors[connector]!.path : model.graph.lanes[f!['lane'] as number]!.path;
      const p = pathAt(path, f!['s'] as number);
      const at = kernel.world.get(id)!.transform.position;
      expect(Math.hypot(at.x - p.x, at.z - p.z)).toBeLessThan(0.01);
    }
  });
});
