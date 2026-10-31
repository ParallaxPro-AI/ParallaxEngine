/**
 * softbody — cloth and soft bodies (sdk/parallax/softbody.pyi): `Cloth` (flags, capes,
 * curtains, sails, banners) and `SoftBody` (jelly, slime, balloons), simulated with small-step
 * XPBD (xpbd.ts) in the kernel's 'physics' hook, once per fixed step, after physics3d when
 * it is listed first. They collide one way with the scene's simple colliders and terrain
 * (colliders.ts); cloth is pushed by the wind service.
 *
 * Gravity is physics3d's (`physics3d(gravity=)`, read from its service) times each body's
 * `gravity_scale`; -9.8 m/s² without physics3d.
 *
 * Surfaces reach renderers through the `softbody_meshes` service (services/deformables.ts):
 * one mesh per body, world space, its geometry rewritten in place each step. Particle state
 * is this plugin's snapshot (positions, velocities, the cloth's last placement and the body's
 * fitted rotation), so replays and restores continue exactly. Changing a field that decides
 * the particles (size, resolution, shape, mass) rebuilds the body in its rest pose.
 */

import { bindArgs, Color, fail, Quat, Vec2, Vec3 } from '../../../core/index.js';
import type { EntityId, Geometry3d, Rgba } from '../../../core/index.js';
import type { Json, JsonObject } from '../../../resource/index.js';
import { refString } from '../../../resource/index.js';
import { componentEntity, t } from '../../kernel/index.js';
import type { ComponentDef, EntityRecord, Fields, Kernel, KernelPlugin, Schema } from '../../kernel/index.js';
import { PHYSICS3D_SERVICE, SOFTBODY_MESHES, WIND_SERVICE } from '../../services/index.js';
import type { GeneratedMaterial, GeneratedMesh } from '../../services/index.js';
import { ClothSim, clothKey, PIN_MODES, placementOf } from './cloth.js';
import type { PinMode } from './cloth.js';
import { gatherObstacles } from './colliders.js';
import { SOFT_SHAPES, SoftSim, softKey } from './jelly.js';
import { vertexNormals } from './xpbd.js';

export { ClothSim, PIN_MODES } from './cloth.js';
export { enclosedVolume, extractRotation, SoftSim, softSurface } from './jelly.js';
export { compliance } from './xpbd.js';

export const CLOTH = 'cloth';
export const SOFT_BODY = 'soft_body';

const optionalImage = { type: { kind: 'optional', of: { kind: 'ref', to: 'asset/images' } }, default: null } as const;

export const CLOTH_SCHEMA: Schema = {
  size: t.vec2({ default: new Vec2(1, 1) }),
  cols: t.int({ default: 12, min: 2, max: 64 }),
  rows: t.int({ default: 12, min: 2, max: 64 }),
  pin: t.enum(PIN_MODES, { default: 'top' }),
  pinned: t.list({ kind: 'int' }, { default: [] }),
  density: t.number({ default: 0.3, min: 0.001 }),
  stiffness: t.number({ default: 1, min: 0, max: 1 }),
  bend: t.number({ default: 0.3, min: 0, max: 1 }),
  damping: t.number({ default: 0.3, min: 0 }),
  drag: t.number({ default: 1, min: 0 }),
  wind_scale: t.number({ default: 1, min: 0 }),
  gravity_scale: t.number({ default: 1 }),
  collide: t.bool({ default: true }),
  thickness: t.number({ default: 0.02, min: 0 }),
  friction: t.number({ default: 0.3, min: 0, max: 1 }),
  substeps: t.int({ default: 8, min: 1, max: 32 }),
  color: t.color({ default: Color.WHITE }),
  texture: optionalImage,
  cast_shadows: t.bool({ default: true }),
};

export const SOFT_BODY_SCHEMA: Schema = {
  shape: t.enum(SOFT_SHAPES, { default: 'sphere' }),
  size: t.vec3({ default: Vec3.ONE }),
  detail: t.int({ default: 2, min: 0, max: 3 }),
  mass: t.number({ default: 1, min: 0.001 }),
  stiffness: t.number({ default: 0.5, min: 0, max: 1 }),
  shape_stiffness: t.number({ default: 0.05, min: 0, max: 1 }),
  pressure: t.number({ default: 1, min: 0.1, max: 4 }),
  damping: t.number({ default: 0.5, min: 0 }),
  gravity_scale: t.number({ default: 1 }),
  collide: t.bool({ default: true }),
  thickness: t.number({ default: 0.01, min: 0 }),
  friction: t.number({ default: 0.5, min: 0, max: 1 }),
  substeps: t.int({ default: 8, min: 1, max: 32 }),
  color: t.color({ default: new Color(0.4, 0.85, 0.4, 1) }),
  texture: optionalImage,
  cast_shadows: t.bool({ default: true }),
};

type MutableGeometry = { -readonly [K in keyof Geometry3d]: Geometry3d[K] };

interface Body {
  readonly kind: 'cloth' | 'soft';
  readonly sim: ClothSim | SoftSim;
  readonly geometry: MutableGeometry;
  readonly built: number;
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function rgbaOf(value: unknown): Rgba {
  const c = value as { r: number; g: number; b: number; a: number };
  return [c.r, c.g, c.b, c.a];
}

function describe(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  return typeof value === 'object' ? (value.constructor?.name ?? 'object') : JSON.stringify(value);
}

function vec3Arg(value: unknown, where: string): Vec3 {
  if (value instanceof Vec3 && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z)) return value;
  return fail('PP3311', `${where} must be a finite Vec3, got ${describe(value)}`, { fix: 'Pass vec3(x, y, z).' });
}

function numberArg(value: unknown, where: string, min = -Infinity): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= min) return value;
  return fail('PP3311', `${where} must be a number${min > -Infinity ? ` of at least ${min}` : ''}, got ${describe(value)}`);
}

export interface SoftbodyPlugin extends KernelPlugin {
  /** The simulation behind an entity's Cloth or SoftBody (tests, tools); undefined before its first step. */
  simOf(entity: EntityId): ClothSim | SoftSim | undefined;
}

export function softbody(): SoftbodyPlugin {
  const bodies = new Map<EntityId, Body>();
  let installed: Kernel | undefined;
  let revision = 0;
  let builds = 0;
  const kernelOf = (): Kernel => {
    if (installed === undefined) fail('PP9310', 'softbody is used before its kernel was built');
    return installed;
  };

  const gravity = (kernel: Kernel): number => kernel.tryService(PHYSICS3D_SERVICE)?.gravity ?? -9.8;

  const geometryFor = (id: EntityId, sim: ClothSim | SoftSim, kind: 'cloth' | 'soft'): MutableGeometry => {
    const n = sim.p.count;
    const geometry: MutableGeometry = {
      id: `${kind}:${id}:${++builds}`,
      positions: new Float32Array(n * 3),
      normals: new Float32Array(n * 3),
      uvs: sim.uvs,
      indices: n <= 0xffff ? Uint16Array.from(sim.indices) : sim.indices,
      joints: null,
      weights: null,
      colors: null,
      min: [0, 0, 0],
      max: [0, 0, 0],
      version: 0,
    };
    write(geometry, sim);
    return geometry;
  };

  const write = (geometry: MutableGeometry, sim: ClothSim | SoftSim): void => {
    const x = sim.p.x;
    for (let k = 0; k < x.length; k++) geometry.positions[k] = x[k]!;
    vertexNormals(x, geometry.indices, geometry.normals);
    const [min, max] = sim.bounds();
    geometry.min = [min[0]!, min[1]!, min[2]!];
    geometry.max = [max[0]!, max[1]!, max[2]!];
    geometry.version = (geometry.version ?? 0) + 1;
  };

  const placement = (record: EntityRecord): Float64Array => {
    const t = record.transform;
    return placementOf(t.worldPosition(), t.worldRotation(), t.worldScale());
  };

  /** The entity's body, built (or rebuilt in its rest pose) when its structure changed. */
  const ensure = (record: EntityRecord): Body | undefined => {
    const cloth = record.components.get(CLOTH);
    const soft = record.components.get(SOFT_BODY);
    if (cloth !== undefined && soft !== undefined) {
      fail('PP3310', `entity ${record.placedId ?? record.prefab ?? record.id} has both Cloth and SoftBody`, { fix: 'Keep one: an entity is either a sheet or a closed body.' });
    }
    const fields = cloth ?? soft;
    if (fields === undefined) {
      if (bodies.delete(record.id)) revision++;
      return undefined;
    }
    const kind = cloth !== undefined ? 'cloth' : 'soft';
    const key = kind === 'cloth' ? clothKey(fields) : softKey(fields);
    const existing = bodies.get(record.id);
    if (existing !== undefined && existing.kind === kind && existing.sim.key === key) return existing;
    const t = record.transform;
    const sim = kind === 'cloth'
      ? new ClothSim(fields, placement(record))
      : new SoftSim(fields, t.worldPosition(), t.worldRotation(), t.worldScale());
    const body: Body = { kind, sim, geometry: geometryFor(record.id, sim, kind), built: ++builds };
    bodies.set(record.id, body);
    revision++;
    return body;
  };

  /** The entity and its descendants (a body doesn't collide with what carries it). */
  const family = (kernel: Kernel, id: EntityId): Set<EntityId> => {
    const out = new Set<EntityId>([id]);
    let parent = kernel.world.get(id)?.parent ?? null;
    while (parent !== null) {
      out.add(parent);
      parent = kernel.world.get(parent)?.parent ?? null;
    }
    const stack = [...(kernel.world.get(id)?.children ?? [])];
    while (stack.length > 0) {
      const child = stack.pop()!;
      out.add(child);
      stack.push(...(kernel.world.get(child)?.children ?? []));
    }
    return out;
  };

  const step = (kernel: Kernel, dt: number): void => {
    const g = gravity(kernel);
    const wind = kernel.tryService(WIND_SERVICE);
    for (const [id] of kernel.world.query([CLOTH])) {
      const record = kernel.world.get(id)!;
      const body = ensure(record)!;
      const fields = record.components.get(CLOTH)!;
      const sim = body.sim as ClothSim;
      const obstacles = fields['collide'] === true ? obstaclesFor(kernel, id, sim.bounds(), 1) : null;
      sim.step(fields, placement(record), dt, g * (fields['gravity_scale'] as number), wind, obstacles);
      write(body.geometry, sim);
    }
    for (const [id] of kernel.world.query([SOFT_BODY])) {
      const record = kernel.world.get(id)!;
      const body = ensure(record)!;
      const fields = record.components.get(SOFT_BODY)!;
      const sim = body.sim as SoftSim;
      const obstacles = fields['collide'] === true ? obstaclesFor(kernel, id, sim.bounds(), 0.5) : null;
      sim.step(fields, dt, g * (fields['gravity_scale'] as number), obstacles);
      write(body.geometry, sim);
      follow(record, sim);
    }
  };

  const obstaclesFor = (kernel: Kernel, id: EntityId, [min, max]: [number[], number[]], pad: number) =>
    gatherObstacles(kernel, min.map((v) => v - pad), max.map((v) => v + pad), family(kernel, id));

  /** The soft body's entity follows its centroid and fitted rotation. */
  const follow = (record: EntityRecord, sim: SoftSim): void => {
    const t = record.transform;
    t.setWorldPosition(new Vec3(sim.center[0]!, sim.center[1]!, sim.center[2]!));
    const world = new Quat(sim.q[0]!, sim.q[1]!, sim.q[2]!, sim.q[3]!);
    t.rotation = t.parent === null ? world : t.parent.worldRotation().inverse().__mul__(world);
  };

  const material = (kind: 'cloth' | 'soft', fields: Fields, where: string): GeneratedMaterial => {
    const color = rgbaOf(fields['color']);
    const texture = fields['texture'] === null || fields['texture'] === undefined ? null : refString(fields['texture'], `${where}.texture`);
    return {
      id: `${kind}|${color.join(',')}|${texture ?? ''}`,
      color,
      texture,
      roughness: kind === 'cloth' ? 0.9 : 0.35,
      metallic: 0,
      blend: color[3] < 1,
      doubleSided: kind === 'cloth',
      unlit: false,
    };
  };

  const source = {
    get revision() { return revision; },
    meshes(): GeneratedMesh[] {
      const kernel = kernelOf();
      const out: GeneratedMesh[] = [];
      for (const [id] of kernel.world.query([CLOTH])) out.push(meshOf(kernel, id, CLOTH, 'cloth'));
      for (const [id] of kernel.world.query([SOFT_BODY])) out.push(meshOf(kernel, id, SOFT_BODY, 'soft'));
      return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    },
  };

  const meshOf = (kernel: Kernel, id: EntityId, component: string, kind: 'cloth' | 'soft'): GeneratedMesh => {
    const record = kernel.world.get(id)!;
    const body = ensure(record)!;
    const fields = record.components.get(component)!;
    return {
      key: `${kind}:${String(id).padStart(10, '0')}`,
      entity: id,
      version: body.built,
      parts: [{ geometry: body.geometry, material: material(kind, fields, `entity ${id} ${component}`), castShadows: fields['cast_shadows'] === true }],
      world: IDENTITY,
      collision: null,
      collisionVersion: 0,
    };
  };

  const bodyOf = (fields: Fields, kind: 'cloth' | 'soft', what: string): Body => {
    const kernel = kernelOf();
    const id = componentEntity(fields);
    const record = kernel.world.get(id);
    if (record === undefined) fail('PP3002', `${what} on an entity that no longer exists`);
    const body = ensure(record)!;
    if (body.kind !== kind) fail('PP3310', `${what}: the entity's body is not a ${kind === 'cloth' ? 'Cloth' : 'SoftBody'}`);
    return body;
  };

  /**
   * push(velocity, *, at=None, radius=0.5) on Cloth and SoftBody: a velocity change (m/s),
   * to every free particle, or with `at` to those within `radius` of it, fading to the edge.
   * `velocity` is a change of velocity, not an impulse (N·s), so the method is `push`.
   */
  const pushArgs = (args: readonly unknown[], what: string): { at: Vec3 | null; velocity: Vec3; radius: number } => {
    const a = bindArgs(what, args, { positional: ['velocity'], keyword: ['at', 'radius'], required: ['velocity'] }).args;
    const at = a['at'] === undefined || a['at'] === null ? null : vec3Arg(a['at'], `${what}() at`);
    return { at, velocity: vec3Arg(a['velocity'], `${what}() velocity`), radius: numberArg(a['radius'] ?? 0.5, `${what}() radius`, 0) };
  };
  const renamed = (old: string, kind: 'Cloth' | 'SoftBody', example: string): never =>
    fail('PP3030', `${kind}.${old}() was renamed to ${kind}.push() (a velocity change in m/s)`, { fix: `Write ${example}.` });

  const clothMethods = {
    /** push(velocity, *, at=None, radius=0.5): change particle velocities (every free particle without `at`). */
    push(this: Fields, ...args: unknown[]): void {
      const { at, velocity, radius } = pushArgs(args, 'Cloth.push');
      const body = bodyOf(this, 'cloth', 'Cloth.push()');
      // ClothSim.impulse moves every free particle for radius ≤ 0.
      (body.sim as ClothSim).impulse(at ?? velocity, velocity, at === null ? 0 : radius);
    },
    impulse(this: Fields): never {
      return renamed('impulse', 'Cloth', 'cloth.push(velocity, at=point, radius=r)');
    },
    /** reset(): back to the rest shape under the entity, at rest. */
    reset(this: Fields): void {
      const id = componentEntity(this);
      bodyOf(this, 'cloth', 'Cloth.reset()');
      bodies.delete(id);
      ensure(kernelOf().world.get(id)!);
    },
    get particle_count(): number {
      return bodyOf(this as unknown as Fields, 'cloth', 'Cloth.particle_count').sim.p.count;
    },
  };

  const softMethods = {
    /** push(velocity, *, at=None, radius=0.5): every particle (a shove, a hop), or those near `at` (a dent, a squish). */
    push(this: Fields, ...args: unknown[]): void {
      const { at, velocity, radius } = pushArgs(args, 'SoftBody.push');
      (bodyOf(this, 'soft', 'SoftBody.push()').sim as SoftSim).impulse(at, velocity, radius);
    },
    impulse(this: Fields): never {
      return renamed('impulse', 'SoftBody', 'body.push(velocity)');
    },
    poke(this: Fields): never {
      return renamed('poke', 'SoftBody', 'body.push(velocity, at=point, radius=r)');
    },
    reset(this: Fields): void {
      const id = componentEntity(this);
      bodyOf(this, 'soft', 'SoftBody.reset()');
      bodies.delete(id);
      ensure(kernelOf().world.get(id)!);
    },
    /** Mean particle velocity, m/s. */
    get velocity(): Vec3 {
      return (bodyOf(this as unknown as Fields, 'soft', 'SoftBody.velocity').sim as SoftSim).velocity();
    },
    /** Enclosed volume over rest volume (1: undeformed; below 1 while squashed past what pressure holds). */
    get volume_ratio(): number {
      const sim = bodyOf(this as unknown as Fields, 'soft', 'SoftBody.volume_ratio').sim as SoftSim;
      return sim.volume() / sim.restVolume;
    },
  };

  const components: ComponentDef[] = [
    { id: CLOTH, schema: CLOTH_SCHEMA, methods: clothMethods },
    { id: SOFT_BODY, schema: SOFT_BODY_SCHEMA, methods: softMethods },
  ];

  return {
    id: 'softbody',
    components,
    simOf: (entity) => bodies.get(entity)?.sim,
    install(kernel) {
      if (installed !== undefined) fail('PP3310', 'This softbody plugin is already installed in another kernel', { fix: 'Call softbody() once per game.' });
      installed = kernel;
      kernel.provide(SOFTBODY_MESHES, source);
      kernel.addHook('physics', (dt) => step(kernel, dt));
      kernel.observeEntities({
        removed: (records) => {
          for (const record of records) if (bodies.delete(record.id)) revision++;
        },
      });
      kernel.observeScenes({
        loading: () => {
          if (bodies.size > 0) revision++;
          bodies.clear();
        },
      });
    },
    snapshot(): Json {
      const out: Json[] = [];
      for (const [id, body] of [...bodies].sort((a, b) => a[0] - b[0])) {
        const sim = body.sim;
        out.push({
          entity: id,
          kind: body.kind,
          key: sim.key,
          x: Array.from(sim.p.x),
          v: Array.from(sim.p.v),
          frame: sim instanceof ClothSim ? Array.from(sim.placement) : [...sim.q, ...sim.center],
        });
      }
      return out;
    },
    restore(kernel, state) {
      bodies.clear();
      revision++;
      for (const saved of state as JsonObject[]) {
        const id = saved['entity'] as EntityId;
        const record = kernel.world.get(id);
        if (record === undefined) continue;
        const body = ensure(record);
        if (body === undefined || body.kind !== saved['kind'] || body.sim.key !== saved['key']) continue;
        const sim = body.sim;
        sim.p.x.set(saved['x'] as number[]);
        sim.p.prev.set(saved['x'] as number[]);
        sim.p.v.set(saved['v'] as number[]);
        if (sim instanceof ClothSim) sim.placement = Float64Array.from(saved['frame'] as number[]);
        else {
          const frame = saved['frame'] as number[];
          sim.q.set(frame.slice(0, 4));
          sim.center.set(frame.slice(4, 7));
        }
        write(body.geometry, sim);
      }
    },
  };
}

export type { PinMode };
