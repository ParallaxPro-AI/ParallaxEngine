/**
 * The visuals components the models plugin reads, by id with the SDK's field names (it
 * never imports the visuals plugin), and how an entity's place in the world is composed —
 * the same rules render3d draws with, so poses, IK and sockets agree with what is drawn.
 */

import { fail, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import { compose, identity, multiply, refString } from '../../../resource/index.js';
import type { M4 } from '../../../resource/index.js';
import type { EntityRecord, Fields, World } from '../../kernel/index.js';
import type { RenderPoseSource } from '../../services/index.js';

export const MODEL = 'model';
export const ANIMATOR = 'animator';
/** Levels of detail: their models load with the entity's own. */
export const LOD = 'lod';
/** The visuals component that keeps an entity on its parent's model socket. */
export const SOCKET = 'socket';
/** The characters plugin's component that wears an entity's model on its parent's skeleton (`garments.ts`). */
export const GARMENT = 'garment';

export function describe(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'object') return value.constructor?.name ?? 'object';
  return JSON.stringify(value);
}

export function vec3(value: unknown, where: string): [number, number, number] {
  if (value instanceof Vec3) return [value.x, value.y, value.z];
  return fail('PP3800', `${where} must be a Vec3, got ${describe(value)}`, { fix: 'Pass vec3(x, y, z).' });
}

export function nameOf(record: EntityRecord): string {
  return record.prefab === undefined ? `entity ${record.id}` : `prefab "${record.prefab}"`;
}

/** The model file an entity's Model names (PP2063 when none), through `resolve`. */
export function modelPath(models: { resolve(ref: string, where: string): string }, record: EntityRecord, fields: Fields): string {
  return models.resolve(refString(fields['model'], `${nameOf(record)} model.model`), `${nameOf(record)} model.model`);
}

/**
 * Entities' local → world matrices composed up the hierarchy once per frame, physics-moved
 * ones at their interpolated render pose (the physics plugin's `render_pose` service), as
 * render3d places them for drawing.
 */
export class WorldMatrices {
  readonly #world: World;
  readonly #source: () => RenderPoseSource | undefined;
  readonly #cache = new Map<EntityId, M4>();
  #poses: RenderPoseSource | undefined;

  constructor(world: World, poses: () => RenderPoseSource | undefined) {
    this.#world = world;
    this.#source = poses;
  }

  /** Forget the matrices taken so far (each frame, and after sockets moved entities). */
  clear(): void {
    this.#cache.clear();
    this.#poses = this.#source();
  }

  of(record: EntityRecord): M4 {
    const cached = this.#cache.get(record.id);
    if (cached !== undefined) return cached;
    const parentRecord = record.parent === null ? undefined : this.#world.peek(record.parent);
    const parent = parentRecord === undefined ? identity() : this.of(parentRecord);
    const pose = this.#poses?.local(record.id);
    const p = pose?.position ?? record.transform.position;
    const q = pose?.rotation ?? record.transform.rotation;
    const s = record.transform.scale;
    const m = multiply(parent, compose(p.x, p.y, p.z, q.x, q.y, q.z, q.w, s.x, s.y, s.z));
    this.#cache.set(record.id, m);
    return m;
  }
}
