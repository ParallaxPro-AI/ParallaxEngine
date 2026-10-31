/**
 * Acceptance against the example games: every 3D example that lists physics3d loads each
 * of its scenes through the kernel with the real physics3d, characters, vehicles and
 * visuals plugins (its own gravity and collision layers, read from game/), and runs three
 * seconds headless. Then the behaviors that matter, with the examples' own prefabs:
 * placed characters stand on the floor under them, every dynamic body falls at exactly
 * its gravity, every wheeled car drives forward under throttle, boats float on the
 * sea and sail, the cargo plane rolls down its runway, and the shapes and fields in the data
 * are all accepted.
 *
 * Components of other plugins and game components, and behavior params, get permissive
 * schemas derived from the data (as in kernel/examples.test.ts). The repository has no
 * model assets, so the model geometry service answers "still loading": mesh and convex
 * colliders (islands, arena walls, battlefields) stay pending, exactly as they would in a
 * browser before the glb arrives — scenes standing on those are run, not asserted on.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { ParallaxError, Vec3 } from '../../../core/index.js';
import type { EntityId, ProjectFiles } from '../../../core/index.js';
import { loadProject, resolvePrefab } from '../../../resource/index.js';
import type { JsonObject, Project } from '../../../resource/index.js';
import { Kernel } from '../../kernel/index.js';
import type { BehaviorDef, ComponentDef, Fields, GameDefinition, KernelPlugin, Schema } from '../../kernel/index.js';
import { PHYSICS3D_SERVICE } from '../../services/index.js';
import { CHARACTER, characters } from '../characters/index.js';
import { initPhysics3d, physics3d } from '../physics3d/index.js';
import { VISUAL_SCHEMAS, visuals } from '../visuals/index.js';
import { models } from '../models/index.js';
import { BUOYANCY, WATER_BODY, water } from '../water/index.js';
import { VEHICLE, vehicles } from './index.js';

declare global {
  interface ImportMeta {
    glob(pattern: string[] | string, options: { query: '?raw'; import: 'default'; eager: true }): Record<string, string>;
  }
}

const DT = 1 / 60;
const PREFIX = '../../../../../../examples/';
const raw = import.meta.glob(['../../../../../../examples/*/**/*.json', '../../../../../../examples/*/game/**/*.py'], {
  query: '?raw', import: 'default', eager: true,
});

interface Example {
  readonly files: Map<string, string>;
  readonly python: Map<string, string>;
}

const all = new Map<string, Example>();
for (const [path, text] of Object.entries(raw)) {
  const [name, ...rest] = path.slice(PREFIX.length).split('/');
  if (name === undefined || name.startsWith('_')) continue;
  const example = all.get(name) ?? { files: new Map<string, string>(), python: new Map<string, string>() };
  const rel = rest.join('/');
  if (rel.endsWith('.py')) example.python.set(rel, text);
  else example.files.set(rel, text);
  all.set(name, example);
}

interface Setup {
  readonly name: string;
  readonly project: Project;
  readonly gravity: number;
  readonly layers: string[];
  readonly characters: boolean;
  readonly vehicles: boolean;
  readonly water: boolean;
}

/** The game's physics3d(...) arguments and plugin list, read from game/main.py and its Layers class. */
function setup(name: string, example: Example): Setup | undefined {
  const main = example.python.get('game/main.py') ?? '';
  if (!/mode\s*=\s*"3d"/.test(main)) return undefined;
  const call = /physics3d\(([^)]*)\)/.exec(main);
  if (call === null) return undefined;
  const gravity = Number(/gravity\s*=\s*(-?[\d.]+)/.exec(call[1]!)?.[1] ?? -9.8);
  const layers: string[] = [];
  for (const text of example.python.values()) {
    const block = /^class Layers\([^)]*\):\n((?:[ \t]+.*\n|\s*\n)*)/m.exec(text);
    if (block === null) continue;
    for (const m of block[1]!.matchAll(/^\s+(\w+)\s*=\s*layer\(\)/gm)) layers.push(m[1]!);
  }
  const files = example.files;
  const project = loadProject({ list: () => [...files.keys()].sort(), read: (p) => files.get(p)! } satisfies ProjectFiles);
  return { name, project, gravity, layers, characters: /\bcharacters\(\)/.test(main), vehicles: /\bvehicles\(\)/.test(main), water: /\bwater\(\)/.test(main) };
}

const setups = [...all].sort(([a], [b]) => (a < b ? -1 : 1)).map(([n, e]) => setup(n, e)).filter((s): s is Setup => s !== undefined);
// Plus every component the plugins under test define (rigs, drivetrains, …), so the data's don't get a second, permissive definition.
const OWNED = new Set([
  'rigidbody', 'collider', CHARACTER, VEHICLE, WATER_BODY, BUOYANCY, ...Object.keys(VISUAL_SCHEMAS),
  ...[characters(), water(), vehicles()].flatMap((p: KernelPlugin) => (p.components ?? []).map((c) => c.id)),
]);

type Instance = { components: Readonly<Record<string, JsonObject>>; params: Readonly<Record<string, JsonObject>> };

function definition(project: Project): GameDefinition {
  const componentFields = new Map<string, Set<string>>();
  const behaviorParams = new Map<string, Set<string>>();
  const note = (map: Map<string, Set<string>>, id: string, fields: JsonObject): void => {
    const set = map.get(id) ?? new Set<string>();
    for (const key of Object.keys(fields)) set.add(key);
    map.set(id, set);
  };
  const noteInstance = (inst: Instance): void => {
    for (const [id, fields] of Object.entries(inst.components)) note(componentFields, id, fields);
    for (const [id, params] of Object.entries(inst.params)) note(behaviorParams, id, params);
  };
  for (const prefab of project.prefabs.values()) {
    for (const [id, fields] of Object.entries(prefab.components)) note(componentFields, id, fields);
    for (const use of prefab.behaviors) note(behaviorParams, use.use, use.params);
    prefab.children.forEach(noteInstance);
  }
  for (const scene of project.scenes.values()) scene.entities.forEach(noteInstance);
  const permissive = (fields: Set<string>): Schema =>
    Object.fromEntries([...fields].map((f) => [f, { type: { kind: 'json' as const }, default: null }]));
  const components: ComponentDef[] = [...componentFields].filter(([id]) => !OWNED.has(id)).map(([id, f]) => ({ id, schema: permissive(f) }));
  const behaviors: BehaviorDef[] = [...behaviorParams].map(([id, params]) => ({
    id, params: permissive(params), state: {}, requires: [], handlers: [], create: () => ({}),
  }));
  return { components, behaviors, resources: [], events: [], systems: [] };
}

/** No model assets in the repository: a data-only run, as render3d provides it (no file: null, no shape). */

function kernel(s: Setup, extraPrefabs: Record<string, unknown> = {}): Kernel {
  let project = s.project;
  if (Object.keys(extraPrefabs).length > 0) {
    const files = new Map(all.get(s.name)!.files);
    for (const [id, p] of Object.entries(extraPrefabs)) files.set(`prefabs/${id}.prefab.json`, JSON.stringify(p));
    files.set('scenes/__test__/scene.json', JSON.stringify({ entities: [] }));
    project = loadProject({ list: () => [...files.keys()].sort(), read: (p) => files.get(p)! });
  }
  // Data-only (no asset files): models have no collision shape, but their clips and rigs answer.
  const files = all.get(s.name)!.files;
  const plugins: KernelPlugin[] = [
    visuals({ dimension: '3d' }), physics3d({ gravity: s.gravity, layers: s.layers }),
    models({ files: { list: () => [...files.keys()].sort(), read: (p) => files.get(p)! }, assetFiles: false }),
  ];
  if (s.characters) plugins.push(characters());
  if (s.water) plugins.push(water());
  if (s.vehicles) plugins.push(vehicles());
  return new Kernel({ project, game: definition(project), plugins, context: {}, fixedStep: DT });
}

beforeAll(async () => {
  await initPhysics3d();
});

describe('3D physics examples', () => {
  const ROAD = { components: { collider: { shape: 'box', size: [2000, 1, 2000], offset: [0, -0.5, 0] } } };
  it('finds the 20 examples that use physics3d, with their gravity and layers', () => {
    expect(setups.map((s) => s.name)).toEqual([
      'basketball', 'brick_breaker', 'cargo_plane', 'coop_cooking', 'darts', 'fighting_game', 'fps_shooter',
      'horde_survival', 'lane_defense', 'moba', 'open_world_rpg', 'open_world_sandbox', 'paddle_duel',
      'pirate_sailing', 'platformer', 'racing', 'soccer', 'tank_battle', 'twin_stick_roguelite', 'voxel_survival',
    ]);
    const by = Object.fromEntries(setups.map((s) => [s.name, s]));
    expect(by['platformer']!.gravity).toBe(-40);
    expect(by['twin_stick_roguelite']!.layers).toEqual(['keeper', 'foe', 'wall', 'prop', 'shard', 'spit', 'pickup']);
  });

  const scenes = setups.flatMap((s) => [...s.project.scenes.keys()].sort().map((scene) => [`${s.name}/${scene}`, s, scene] as const));

  it.each(scenes)('%s loads and runs 3 s; placed characters stand on their floors', (label, s, scene) => {
    const k = kernel(s);
    k.start(scene);
    k.step(DT);
    const service = k.service(PHYSICS3D_SERVICE);
    // Characters placed in the scene with a solid floor right under their feet.
    const standing: Array<[EntityId, number]> = [];
    for (const record of k.world.live()) {
      if (!record.components.has(CHARACTER) || record.placedId === undefined) continue;
      const p = record.transform.worldPosition();
      const hit = service.raycast(p.__add__(new Vec3(0, 0.5, 0)), new Vec3(0, -1, 0), 1.5, { ignore: [record.id] });
      if (hit !== undefined) standing.push([record.id, hit.point.y]);
    }
    for (let i = 0; i < 180; i++) k.step(DT);
    for (const record of k.world.live()) {
      const p = record.transform.worldPosition();
      expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z), `${record.placedId ?? record.prefab}`).toBe(true);
    }
    for (const [id, floor] of standing) {
      const record = k.world.require(id);
      const c = record.components.get(CHARACTER) as Fields & { grounded: boolean };
      expect(c.grounded, `${label} ${record.placedId}`).toBe(true);
      expect(Math.abs(record.transform.worldPosition().y - floor), `${label} ${record.placedId}`).toBeLessThan(0.1);
    }
  });

  const walkers = setups.filter((x) => x.characters).flatMap((s) => [...s.project.prefabs.values()]
    .filter((prefab) => resolvePrefab(s.project, prefab.id).components[CHARACTER] !== undefined)
    .map((prefab) => [`${s.name}/${prefab.id}`, s, prefab.id] as const));

  it('has the character prefabs of all 12 character examples', () => {
    expect(new Set(walkers.map(([, s]) => s.name)).size).toBe(12);
  });

  it.each(walkers)('%s stands on a floor, stays on it, and walks', (_label, s, prefab) => {
    const k = kernel(s, { __road__: ROAD });
    k.start('__test__');
    // A floor in a layer the character collides with (one its Collider lists, else default).
    const own = resolvePrefab(s.project, prefab).components['collider'];
    const floorLayer = (own?.['collides_with'] as string[] | undefined)?.find((l) => l !== own?.['layer']) ?? 'default';
    k.spawn('__road__', { components: { collider: { layer: floorLayer } } });
    const record = k.spawn(prefab, { at: [0, 0.2, 0] });
    const c = record.components.get(CHARACTER) as Fields & { grounded: boolean; move(d: Vec3): void; velocity: Vec3 };
    for (let i = 0; i < 120; i++) k.step(DT);
    expect(c.grounded).toBe(true);
    expect(Math.abs(record.transform.position.y)).toBeLessThan(0.05);
    // Walk along an axis the character may move on (a side-scroller locks z: `lock_axes`).
    const locked = (c['lock_axes'] as readonly string[] | undefined) ?? [];
    const axis = locked.includes('z') ? 'x' : 'z';
    for (let i = 0; i < 60; i++) {
      c.move(axis === 'z' ? new Vec3(0, 0, 1) : new Vec3(1, 0, 0));
      k.step(DT);
    }
    expect(c.velocity[axis]).toBeGreaterThan(0.5);
    expect(record.transform.position[axis]).toBeGreaterThan(0.3);
    expect(Math.abs(record.transform.position.y)).toBeLessThan(0.05);
  });

  const dynamics = setups.flatMap((s) => [...s.project.prefabs.values()].flatMap((prefab) => {
    const c = resolvePrefab(s.project, prefab.id).components;
    const rb = c['rigidbody'];
    if (rb === undefined || (rb['kind'] ?? 'dynamic') !== 'dynamic' || c[VEHICLE] !== undefined) return [];
    return [[`${s.name}/${prefab.id}`, s, prefab.id] as const];
  }));

  it('has dynamic bodies to drop', () => {
    expect(dynamics.map(([l]) => l).length).toBeGreaterThanOrEqual(3);
  });

  it.each(dynamics)('%s falls at exactly its gravity', (_label, s, prefab) => {
    const k = kernel(s, { __road__: ROAD });
    k.start('__test__');
    const record = k.spawn(prefab, { at: [5000, 2000, 5000] });
    const rb = record.components.get('rigidbody')!;
    for (let i = 0; i < 30; i++) k.step(DT);
    const v = (rb as Fields & { velocity: Vec3 }).velocity.y;
    const expected = s.gravity * (rb['gravity_scale'] as number) * 0.5;
    if ((rb['linear_damping'] as number) === 0) expect(v).toBeCloseTo(expected, 3);
    else expect(Math.abs(v)).toBeLessThanOrEqual(Math.abs(expected) + 1e-6);
  });

  const cars = setups.filter((s) => s.vehicles).flatMap((s) => [...s.project.prefabs.values()].flatMap((prefab) => {
    const v = resolvePrefab(s.project, prefab.id).components[VEHICLE];
    if (v === undefined || !['car', undefined].includes(v['kind'] as string | undefined)) return [];
    return [[`${s.name}/${prefab.id}`, s, prefab.id] as const];
  }));

  it('has the wheeled cars of racing and open_world_sandbox', () => {
    expect(cars.map(([l]) => l)).toEqual(expect.arrayContaining(['racing/car_surge', 'open_world_sandbox/car', 'open_world_sandbox/taxi']));
    expect(cars.length).toBeGreaterThanOrEqual(8);
  });

  it.each(cars)('%s drives forward under throttle on a road', (_label, s, prefab) => {
    const k = kernel(s, { __road__: ROAD });
    k.start('__test__');
    k.spawn('__road__');
    const car = k.spawn(prefab, { at: [0, 0.3, 0] });
    const v = car.components.get(VEHICLE) as Fields & { drive(k: object): void; speed: number; grounded: boolean };
    for (let i = 0; i < 60; i++) k.step(DT);
    expect(v.grounded).toBe(true);
    for (let i = 0; i < 180; i++) {
      v.drive({ throttle: 1 });
      k.step(DT);
    }
    expect(v.speed).toBeGreaterThan(10);
    expect(car.transform.position.z).toBeGreaterThan(10);
    expect(Math.abs(car.transform.position.x)).toBeLessThan(1);
    expect(car.transform.position.y).toBeGreaterThan(-0.1);
  });

  it('pirate_sailing: the ships float on the ocean where the scene placed them, and sail', () => {
    const s = setups.find((x) => x.name === 'pirate_sailing')!;
    const k = kernel(s);
    k.start('bay');
    const ship = k.spawn('player_ship', { at: [0, -0.35, 0] });
    const ghosts = [...k.world.live()].filter((r) => r.prefab === 'ghost_ship');
    expect(ghosts.length).toBeGreaterThan(0);
    const v = ship.components.get(VEHICLE) as Fields & { drive(k: object): void; speed: number };
    for (let i = 0; i < 240; i++) k.step(DT);
    // Afloat about where the scene puts them (crew ships at -0.35, ghosts at 0, the ocean at -1.05).
    expect(Math.abs(ship.transform.position.y + 0.35)).toBeLessThan(0.15);
    for (const g of ghosts) expect(Math.abs(g.transform.position.y)).toBeLessThan(0.15);
    for (let i = 0; i < 600; i++) {
      v.drive({ throttle: 1 });
      k.step(DT);
    }
    expect(v.speed).toBeGreaterThan(5);
    expect(Math.abs(ship.transform.position.y + 0.35)).toBeLessThan(0.3);
  });

  it('cargo_plane: the pilot boards the cargo plane, which rolls down the runway under throttle', () => {
    const s = setups.find((x) => x.name === 'cargo_plane')!;
    const k = kernel(s);
    k.start('archipelago');
    const find = (id: string) => [...k.world.live()].find((r) => r.placedId === id)!;
    const plane = find('plane');
    const vehicle = plane.components.get(VEHICLE) as Fields & { enter(d: unknown): boolean; fly(k: object): void; speed: number; grounded: boolean };
    const pilot = find('pilot').components.get(CHARACTER) as Fields & { vehicle: unknown };
    for (let i = 0; i < 120; i++) k.step(DT);
    expect(vehicle.grounded).toBe(true);
    // It rests on the runway — and, in this scene's data, also on the pilot, who is placed
    // under the 20 m-wide wing box (reported to the example's owner).
    const touching = k.service(PHYSICS3D_SERVICE).contacts(plane.id).map((c) => k.world.get(c.entity!)?.prefab);
    expect(touching).toContain('runway');
    expect(vehicle.enter(find('pilot').id)).toBe(true);
    expect(pilot.vehicle).toBe(plane.id);
    for (let i = 0; i < 90; i++) {
      vehicle.fly({ throttle: 1 });
      k.step(DT);
    }
    expect(vehicle.speed).toBeGreaterThan(8);
    expect(vehicle['fuel'] as number).toBeLessThan(160);
  });
});
