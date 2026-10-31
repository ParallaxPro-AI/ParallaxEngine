/**
 * Acceptance for terrain, environment and nav on the example games: every scene of the
 * examples that use nav or declare terrain/environment loads through the kernel with the
 * real visuals, terrain, environment and nav plugins and runs a second; then behavior on
 * their real data — terrain fields are deterministic and continuous, the environment
 * resolves each scene's block, an EnvironmentZone (pirate_sailing's squall) blends in, and
 * agents from the games' own prefabs walk around the games' own obstacles and arrive.
 *
 * Components of other plugins and games get permissive schemas derived from the data (as
 * in kernel/examples.test.ts), except `collider` and `rigidbody`, which nav and visuals
 * read by id: they get their SDK field types (physics3d, which will own them, isn't
 * built yet). Game systems don't run (their Python isn't compiled here), so scenes that
 * generate their level in code (twin_stick_roguelite) get the generated pieces spawned from the
 * game's own prefabs.
 */

import { describe, expect, it } from 'vitest';
import { Vec3 } from '../../../core/index.js';
import type { EntityId, ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import type { JsonObject, Project } from '../../../resource/index.js';
import { Kernel, t } from '../../kernel/index.js';
import type { BehaviorDef, ComponentDef, GameDefinition, KernelPlugin, Schema, SystemDef } from '../../kernel/index.js';
import { ENVIRONMENT_SERVICE, MODEL_GEOMETRY_SERVICE, NAV_SERVICE, TERRAIN_SERVICE } from '../../services/index.js';
import { environment } from '../environment/index.js';
import { models } from '../models/index.js';
import { buildField, readTerrainSpec, terrain } from '../terrain/index.js';
import { VISUAL_SCHEMAS, visuals } from '../visuals/index.js';
import { weather } from '../weather/index.js';
import { ARRIVED, nav, NAV_AGENT } from './index.js';
import type { NavPlugin } from './index.js';

declare global {
  interface ImportMeta {
    glob(pattern: string[] | string, options: { query: '?raw'; import: 'default'; eager: true }): Record<string, string>;
  }
}

const NAV_GAMES = ['tank_battle', 'twin_stick_roguelite', 'open_world_rpg', 'moba', 'fps_shooter', 'open_world_sandbox'];
const LOOK_GAMES = [
  'pirate_sailing', 'darts', 'twin_stick_roguelite', 'horde_survival', 'fighting_game', 'cargo_plane', 'typing_game', 'open_world_rpg', 'moba',
  'open_world_sandbox', 'platformer', 'racing', 'voxel_survival', 'endless_runner',
];
const GAMES = [...new Set([...NAV_GAMES, ...LOOK_GAMES])].sort();

const PREFIX = '../../../../../../examples/';
const raw = import.meta.glob(['../../../../../../examples/*/**/*.json'], { query: '?raw', import: 'default', eager: true });

const files = new Map<string, Map<string, string>>();
for (const [path, text] of Object.entries(raw)) {
  const [name, ...rest] = path.slice(PREFIX.length).split('/');
  if (name === undefined || !GAMES.includes(name)) continue;
  const map = files.get(name) ?? new Map<string, string>();
  map.set(rest.join('/'), text);
  files.set(name, map);
}

function projectFiles(map: Map<string, string>): ProjectFiles {
  return { list: () => [...map.keys()].sort(), read: (path) => map.get(path)! };
}

const COLLIDER: Schema = {
  shape: t.string({ default: 'box' }),
  size: t.vec3({ default: Vec3.ONE }),
  radius: t.number({ default: 0.5 }),
  height: t.number({ default: 1 }),
  offset: t.vec3({ default: Vec3.ZERO }),
  trigger: t.bool({ default: false }),
  layer: t.string({ default: 'default' }),
};
const RIGIDBODY: Schema = { kind: t.string({ default: 'dynamic' }) };
const TYPED: Readonly<Record<string, Schema>> = { collider: COLLIDER, rigidbody: RIGIDBODY };
const OWN = new Set([...Object.keys(VISUAL_SCHEMAS), NAV_AGENT]);

const arrivals: unknown[] = [];
const listener: SystemDef = {
  id: 'arrivals', scenes: [], handlers: [{ event: ARRIVED, method: 'heard' }],
  create: () => ({ heard: (_ctx: unknown, e: { entity: unknown }) => arrivals.push(e.entity) }),
};

function game(project: Project): GameDefinition {
  const fieldsOf = new Map<string, Set<string>>();
  const paramsOf = new Map<string, Set<string>>();
  const note = (map: Map<string, Set<string>>, id: string, fields: JsonObject): void => {
    const set = map.get(id) ?? new Set<string>();
    for (const key of Object.keys(fields)) set.add(key);
    map.set(id, set);
  };
  type Instance = { components: Readonly<Record<string, JsonObject>>; params: Readonly<Record<string, JsonObject>> };
  const noteInstance = (inst: Instance): void => {
    for (const [id, f] of Object.entries(inst.components)) note(fieldsOf, id, f);
    for (const [id, p] of Object.entries(inst.params)) note(paramsOf, id, p);
  };
  for (const prefab of project.prefabs.values()) {
    for (const [id, f] of Object.entries(prefab.components)) note(fieldsOf, id, f);
    for (const use of prefab.behaviors) note(paramsOf, use.use, use.params);
    prefab.children.forEach(noteInstance);
  }
  for (const scene of project.scenes.values()) scene.entities.forEach(noteInstance);
  const permissive = (fields: Set<string>, typed: Schema = {}): Schema => ({
    ...Object.fromEntries([...fields].filter((f) => !(f in typed)).map((f) => [f, { type: { kind: 'json' as const }, default: null }])),
    ...typed,
  });
  const components: ComponentDef[] = [...fieldsOf].filter(([id]) => !OWN.has(id)).map(([id, f]) => ({ id, schema: permissive(f, TYPED[id]) }));
  const behaviors: BehaviorDef[] = [...paramsOf].map(([id, p]) => ({ id, params: permissive(p), state: {}, requires: [], handlers: [], create: () => ({}) }));
  return { components, behaviors, resources: [], events: [], systems: [listener] };
}

const projects = new Map(GAMES.map((name) => {
  const project = loadProject(projectFiles(files.get(name)!));
  return [name, { project, game: game(project) }] as const;
}));

interface Running { kernel: Kernel; nav: NavPlugin; at(prefab: string): EntityId[] }

function run(name: string, scene: string, extra: KernelPlugin[] = []): Running {
  const { project, game: definition } = projects.get(name)!;
  const plugin = nav();
  const kernel = new Kernel({
    project, game: definition, context: {},
    // Data-only (no asset files): models draw nothing and have no shape, but their clips and rigs answer.
    // A test that brings its own "models" plugin (stub geometry) replaces it.
    plugins: [
      // weather: a scene's environment may name one (PP3227 without the plugin).
      visuals({ dimension: '3d' }), terrain(), environment(), weather(),
      ...(extra.some((p) => p.id === 'models') ? [] : [models({ files: projectFiles(files.get(name)!), assetFiles: false })]), plugin, ...extra,
    ],
  });
  kernel.start(scene);
  const at = (prefab: string): EntityId[] => [...kernel.world.live()].filter((r) => r.prefab === prefab).map((r) => r.id);
  return { kernel, nav: plugin, at };
}

function agentOf(kernel: Kernel, id: EntityId): { move_to(t: unknown): boolean; moving: boolean; desired_velocity: Vec3 } {
  return kernel.world.require(id).components.get(NAV_AGENT) as never;
}

const position = (kernel: Kernel, id: EntityId): Vec3 => kernel.world.require(id).transform.worldPosition();

/** Walk until Arrived (or the time runs out); returns the positions visited. */
function walk(kernel: Kernel, id: EntityId, seconds: number): Vec3[] {
  arrivals.length = 0;
  const trail: Vec3[] = [];
  for (let i = 0; i < seconds * 60 && !arrivals.includes(id); i++) {
    kernel.step(1 / 60);
    trail.push(position(kernel, id));
  }
  return trail;
}

describe('the example games with terrain, environment and nav', () => {
  it('covers the 16 games', () => {
    expect(GAMES).toHaveLength(16);
    expect([...projects.values()].every(({ project }) => project.diagnostics.length === 0)).toBe(true);
  });

  const scenes = GAMES.flatMap((name) => [...projects.get(name)!.project.scenes.keys()].sort().map((s) => [`${name}/${s}`, name, s] as const));

  it.each(scenes)('%s loads and runs a second with every plugin live', (_label, name, sceneId) => {
    const { kernel } = run(name, sceneId);
    const scene = projects.get(name)!.project.scenes.get(sceneId)!;
    const look = kernel.service(ENVIRONMENT_SERVICE);
    for (let i = 0; i < 60; i++) {
      kernel.step(1 / 60);
      const resolved = look.resolve();
      expect(Number.isFinite(resolved.sunDirection.length())).toBe(true);
      expect(Number.isFinite(resolved.fog.density)).toBe(true);
    }
    const resolved = look.resolve();
    const block = scene.environment ?? {};
    expect(resolved.sky).toBe(block['sky'] ?? 'clear_day');
    const fog = block['fog'] as JsonObject | undefined;
    // A scene's weather moves the fog (weather plugin live), so the block's fog holds only without one.
    if (block['weather'] === undefined) {
      expect(resolved.fog.density).toBe(fog?.['density'] ?? 0);
      expect(resolved.fog.near).toBe(fog?.['near'] ?? null);
    }
    expect(kernel.service(TERRAIN_SERVICE).current() !== null).toBe(scene.plugins['terrain'] !== undefined);
  });

  const terrainScenes = scenes.filter(([, name, s]) => projects.get(name)!.project.scenes.get(s)!.plugins['terrain'] !== undefined);

  it('finds the terrain scenes', () => {
    // The parity pass gave the title / garage / hall scenes the templates' terrain too.
    expect(terrainScenes.map(([label]) => label)).toEqual([
      'cargo_plane/archipelago', 'cargo_plane/title', 'darts/oche_hall', 'darts/title', 'fps_shooter/arena', 'fps_shooter/title',
      'moba/arena', 'moba/title', 'open_world_rpg/sundermere', 'open_world_rpg/title', 'open_world_sandbox/sunset_bay',
      'open_world_sandbox/title', 'racing/canyon_carver', 'racing/garage', 'racing/terrain_sprint', 'racing/title',
      'tank_battle/dust_bowl', 'tank_battle/frostline', 'tank_battle/iron_valley', 'tank_battle/rubble_city', 'tank_battle/title',
    ]);
  });

  it.each(terrainScenes)('%s: terrain is deterministic and continuous', (_label, name, sceneId) => {
    const scene = projects.get(name)!.project.scenes.get(sceneId)!;
    const a = buildField(readTerrainSpec(scene)!, sceneId, 1);
    const b = buildField(readTerrainSpec(scene)!, sceneId, 2);
    expect(Buffer.from(a.heights.buffer).equals(Buffer.from(b.heights.buffer))).toBe(true);
    let steepest = 0;
    for (let i = 0; i < a.heights.length - 1; i++) {
      if ((i + 1) % a.columns !== 0) steepest = Math.max(steepest, Math.abs(a.heights[i + 1]! - a.heights[i]!) / a.cellX);
    }
    const step = a.width / 20000;
    let previous = a.heightAt(a.minX, 3.3);
    for (let s = 1; s <= 20000; s++) {
      const h = a.heightAt(Math.min(a.minX + a.width, a.minX + s * step), 3.3);
      expect(Math.abs(h - previous)).toBeLessThanOrEqual(steepest * step + 1e-4);
      previous = h;
    }
  });

  it('pirate_sailing: the squall\'s EnvironmentZone blends its fog in over its 8 s', () => {
    const { kernel } = run('pirate_sailing', 'bay');
    const look = kernel.service(ENVIRONMENT_SERVICE);
    kernel.step(1 / 60);
    // The bay's own fog is linear (near 120 m, far 1000 m, the template's): no density fog until the squall.
    expect(look.resolve().fog).toMatchObject({ density: 0, near: 120, far: 1000 });
    // Spawned away from the camera, then blown over it (a zone spawned around the camera starts at full weight).
    const squall = kernel.spawn('squall', { at: [10000, 0, 0] }).id;
    kernel.step(1 / 60);
    expect(look.resolve().fog.density).toBe(0);
    kernel.world.require(squall).transform.position = Vec3.ZERO;
    for (let i = 0; i < 240; i++) kernel.step(1 / 60);
    const half = look.resolve().fog.density;
    expect(half).toBeGreaterThan(0.018 * 0.45);
    expect(half).toBeLessThan(0.018 * 0.55);
    for (let i = 0; i < 300; i++) kernel.step(1 / 60);
    expect(look.resolve().fog.density).toBeCloseTo(0.018);
  });

  it('fps_shooter: a bot walks around a crate and arrives', () => {
    const { kernel, at } = run('fps_shooter', 'arena');
    // The layout is the template's mirrored across z.
    const crate = at('crate').map((id) => position(kernel, id)).find((p) => p.x === -4.5 && p.z === -32)!;
    expect(crate).toBeDefined();
    // Across the crate along z: 4 m to its -x is inside a wall block since the re-port.
    const bot = kernel.spawn('bot', { at: [crate.x, 0, crate.z - 4] }).id;
    expect(agentOf(kernel, bot).move_to(new Vec3(crate.x, 0, crate.z + 4))).toBe(true);
    const trail = walk(kernel, bot, 10);
    expect(arrivals).toEqual([bot]);
    for (const p of trail) {
      // The template's crate since the parity pass: a 0.74 m box placed at scale 2.3 (half extent 0.851 m).
      const inside = Math.abs(p.x - crate.x) < 0.851 + 0.49 && Math.abs(p.z - crate.z) < 0.851 + 0.49;
      expect(inside).toBe(false);
    }
  });

  it('twin_stick_roguelite: a foe chases the keeper around a generated wall', () => {
    const { kernel, at } = run('twin_stick_roguelite', 'cellar');
    const [keeper] = at('keeper');
    kernel.spawn('room_floor', { at: [0, 0, 0] });
    // A wall like floor_builder's: the wall prefab rotated to run along z and scaled to 8 m.
    kernel.spawn('wall', { at: [3, 0, 0], rotation: [0, 90, 0], scale: [8, 1, 1] });
    const foe = kernel.spawn('foe', { at: [6, 0, 0] }).id;
    expect(agentOf(kernel, foe).move_to(kernel.handles.wrap(keeper!))).toBe(true);
    const trail = walk(kernel, foe, 20);
    expect(arrivals).toEqual([foe]);
    expect(Math.max(...trail.map((p) => Math.abs(p.z)))).toBeGreaterThan(4);
    expect(position(kernel, foe).distance_to(position(kernel, keeper!))).toBeLessThanOrEqual(0.4 + 1e-6);
  });

  it('moba: a minion goes around a tower ("navmesh" obstacles: terrain layer), keeping its height above the terrain', () => {
    const { kernel, at, nav: plugin } = run('moba', 'arena');
    const tower = at('tower_blue').map((id) => position(kernel, id)).find((p) => p.x === -32 && p.z === 32)!;
    expect(tower).toBeDefined();
    const minion = kernel.spawn('minion_blue', { at: [tower.x - 4, tower.y, tower.z] }).id;
    expect(agentOf(kernel, minion).move_to(new Vec3(tower.x + 4, tower.y, tower.z))).toBe(true);
    const trail = walk(kernel, minion, 10);
    expect(arrivals).toEqual([minion]);
    // An agent keeps the height it had above the surface when its path began (agents.ts): here
    // the terrain falls ~0.3 m along the way, so the minion follows it at that same offset.
    const field = kernel.service(TERRAIN_SERVICE).current()!;
    const lift = tower.y - field.heightAt(tower.x - 4, tower.z);
    const ground = trail.map((p) => field.heightAt(p.x, p.z));
    expect(Math.max(...ground) - Math.min(...ground)).toBeGreaterThan(0.2);
    trail.forEach((p, i) => {
      expect(Math.hypot(p.x - tower.x, p.z - tower.z)).toBeGreaterThan(1.6 + 0.34);
      // Within the column grid's sampling of the surface.
      expect(Math.abs(p.y - ground[i]! - lift)).toBeLessThan(0.02);
    });
    expect(plugin.queries().unsupported()).toEqual([]);
  });

  it('moba: the river gorge is water, and "wade_depth" keeps the ford and the titan pit walkable', () => {
    const { kernel, nav: plugin } = run('moba', 'arena');
    const field = kernel.service(TERRAIN_SERVICE).current()!;
    expect(field.waterLevel).toBe(-1.2);
    const nav = kernel.service(NAV_SERVICE);
    // The river beside the mid causeway (1.2 m deep) and both titan camps' pits (3.6 m).
    for (const [x, z] of [[-9, -9], [-20, -20], [20, 20]] as const) {
      expect(field.heightAt(x, z)).toBeLessThan(field.waterLevel! - 0.5);
      expect(nav.standable(new Vec3(x, field.heightAt(x, z), z), 0.5)).toBe(true);
    }
    // From the blue fountain, a hero walks down the lane into the river and the titan pit.
    const P = (x: number, z: number) => new Vec3(x, field.heightAt(x, z), z);
    for (const [x, z] of [[-9, -9], [-20, -20], [0, 0], [62, -60]] as const) expect(plugin.queries().reachable(P(-62, 60), P(x, z))).toBe(true);
  });

  /** The path's segments never come within `clear` of the upright box (half extents hx × hz, turned `yaw`°) at `c`. */
  function skirts(path: readonly Vec3[], c: Vec3, yaw: number, hx: number, hz: number, clear: number): void {
    const cos = Math.cos((yaw * Math.PI) / 180);
    const sin = Math.sin((yaw * Math.PI) / 180);
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]!;
      const b = path[i]!;
      for (let s = 0; s <= 40; s++) {
        const x = a.x + ((b.x - a.x) * s) / 40 - c.x;
        const z = a.z + ((b.z - a.z) * s) / 40 - c.z;
        // Into the box's frame (a yaw turns +x toward -z, as Quat.euler does).
        const lx = x * cos - z * sin;
        const lz = x * sin + z * cos;
        const dx = Math.max(0, Math.abs(lx) - hx);
        const dz = Math.max(0, Math.abs(lz) - hz);
        expect(Math.hypot(dx, dz)).toBeGreaterThan(clear - 0.05);
      }
    }
  }

  it('tank_battle: its props are box colliders, so nothing is unsupported even without model geometry; a tank AI only steers', () => {
    // No model geometry at all (a models plugin that provides none).
    const { kernel, at, nav: plugin } = run('tank_battle', 'iron_valley', [{ id: 'models' }]);
    expect(at('rock_large').length + at('rock_medium').length + at('gabion').length).toBeGreaterThan(0);
    expect(plugin.queries().unsupported()).toEqual([]);
    const tank = kernel.spawn('enemy_tank', { at: [0, 0, 0] }).id;
    expect(agentOf(kernel, tank).move_to(new Vec3(0, 0, 20))).toBe(true);
    kernel.step(1 / 60);
    expect(position(kernel, tank)).toEqual(Vec3.ZERO);
    expect(agentOf(kernel, tank).desired_velocity.length()).toBeCloseTo(3.5);
  });

  it('tank_battle: a path goes around a rock on the terrain, at the terrain\'s height', () => {
    const { kernel, at, nav: plugin } = run('tank_battle', 'iron_valley');
    // rock_medium: a 1.42 × 1.07 × 2.04 m box collider (the template's), turned 164.85°, inside the valley's central flat.
    const rock = at('rock_medium').map((id) => position(kernel, id)).find((p) => p.x === 26.01 && p.z === -1.32)!;
    expect(rock).toBeDefined();
    const path = plugin.queries().path(new Vec3(rock.x - 10, 0, rock.z), new Vec3(rock.x + 10, 0, rock.z));
    expect(path.length).toBeGreaterThan(2);
    const field = kernel.service(TERRAIN_SERVICE).current()!;
    for (const p of path) expect(Math.abs(p.y - field.heightAt(p.x, p.z))).toBeLessThan(0.02);
    skirts(path, rock, 164.85, 0.71, 1.02, 0.4);
  });

  it('pirate_sailing: its mesh colliders (docks, cliffs) are reported without model geometry', () => {
    const { at, nav: plugin } = run('pirate_sailing', 'bay', [{ id: 'models' }]);
    const meshes = [...at('dock_long'), ...at('cliff_face')];
    expect(at('dock_long').length).toBeGreaterThan(0);
    expect(at('cliff_face').length).toBeGreaterThan(0);
    const unsupported = plugin.queries().unsupported();
    expect(unsupported).toEqual(expect.arrayContaining(meshes));
    expect(unsupported).toHaveLength(meshes.length);
  });

  it('pirate_sailing with model geometry: a cliff\'s triangles are an obstacle', () => {
    // A stand-in for the cliff model: a 4 × 3 × 4 m block (docks get a flat 10 m deck at sea level).
    const deck = { vertices: new Float32Array([-5, 0, -5, -5, 0, 5, 5, 0, 5, 5, 0, -5]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) };
    const v: number[] = [];
    for (let i = 0; i < 8; i++) v.push(i & 1 ? 2 : -2, i & 2 ? 3 : 0, i & 4 ? 2 : -2);
    const faces = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
    const block = { vertices: new Float32Array(v), indices: new Uint32Array(faces.flatMap(([a, b, c, d]) => [a!, b!, c!, a!, c!, d!])) };
    const models: KernelPlugin = {
      id: 'models',
      install: (k) => k.provide(MODEL_GEOMETRY_SERVICE, { geometry: (ref) => (ref.includes('cliff') ? block : deck) }),
    };
    const { kernel, at, nav: plugin } = run('pirate_sailing', 'bay', [models]);
    expect(plugin.queries().unsupported()).toEqual([]);
    const cliff = at('cliff_face').map((id) => position(kernel, id)).find((p) => p.x === -118.6 && p.z === 98.2)!;
    expect(cliff).toBeDefined();
    const path = plugin.queries().path(new Vec3(cliff.x - 10, 0, cliff.z), new Vec3(cliff.x + 10, 0, cliff.z));
    expect(path.length).toBeGreaterThan(2);
    for (const p of path) expect(p.y).toBe(0);
    skirts(path, cliff, 5.9, 2, 2, 0.4);
  });

  it('pirate_sailing in a data-only run (no model files): its mesh colliders are no obstacles and nothing is unsupported', () => {
    const absent: KernelPlugin = { id: 'models', install: (k) => k.provide(MODEL_GEOMETRY_SERVICE, { geometry: () => null }) };
    const { kernel, at, nav: plugin } = run('pirate_sailing', 'bay', [absent]);
    expect(plugin.queries().unsupported()).toEqual([]);
    const cliff = at('cliff_face').map((id) => position(kernel, id)).find((p) => p.x === -118.6 && p.z === 98.2)!;
    expect(cliff).toBeDefined();
    // Straight through where the cliff stands.
    expect(plugin.queries().path(new Vec3(cliff.x - 10, 0, cliff.z), new Vec3(cliff.x + 10, 0, cliff.z))).toHaveLength(2);
  });

  it('open_world_rpg: a goblin crosses the west hill on the terrain, following its height', () => {
    const { kernel } = run('open_world_rpg', 'sundermere');
    const field = kernel.service(TERRAIN_SERVICE).current()!;
    // The template's west hill since the parity pass: centre (-125, 70) (mirrored in z), radius 91 m,
    // 28 m high with a 55 m feather — broad and walkable, no flank past 45°.
    // Up its south flank (z -20 → 20 climbs 8 → 34 m) from the valley floor to the top.
    const start = field.ground(new Vec3(-125, 0, -40));
    const goblin = kernel.spawn('goblin_scout', { at: [start.x, start.y, start.z] }).id;
    expect(agentOf(kernel, goblin).move_to(new Vec3(-125, 0, 50))).toBe(true);
    const trail = walk(kernel, goblin, 60);
    expect(arrivals).toEqual([goblin]);
    expect(Math.max(...trail.map((p) => p.y))).toBeGreaterThan(start.y + 25);
    // Feet on the triangles under each cell center the agent stands in: within a cell's slope.
    for (const p of trail) expect(Math.abs(p.y - field.heightAt(p.x, p.z))).toBeLessThan(0.5);
  });

  it('open_world_sandbox: pedestrians wander to random reachable points on the terrain', () => {
    const { kernel, nav: plugin } = run('open_world_sandbox', 'sunset_bay');
    let s = 11;
    const random = (): number => ((s = (s * 16807) % 2147483647) / 2147483647);
    const here = new Vec3(10, 0, 10);
    const point = plugin.queries().randomPoint(here, 12, random)!;
    expect(point).not.toBeNull();
    const walker = kernel.spawn('pedestrian', { at: [here.x, 0, here.z] }).id;
    expect(agentOf(kernel, walker).move_to(point)).toBe(true);
    walk(kernel, walker, 20);
    expect(arrivals).toEqual([walker]);
  });
});
