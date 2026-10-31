/**
 * Model entities posed each frame — the animator's pose (`animation_pose.ts`), then the
 * document's joints — and their sockets resolved: for renderers (the `model_poses`
 * service), for entities attached to sockets (the `socket` component), and for game code
 * (the model rig service, `function/services/models.ts`).
 *
 * Socketed entities. An entity with a `socket` component (`parent.attach(child,
 * socket=...)`) is kept on that socket of its parent's Model: every frame, before anything
 * is drawn, its local position and rotation become the socket's frame (its scale is its
 * own), so what it draws, and what game code reads next frame, rides the posed model — a
 * rifle in a running soldier's hand, a driver in a steering kart.
 */

import { fail, Quat, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import { applyJoints, compose, decompose, invert, jointValues, modelOffsetMatrix, multiply, refString, socketMatrix, socketNames } from '../../../resource/index.js';
import type { M4, ModelAsset } from '../../../resource/index.js';
import type { EntityRecord, World } from '../../kernel/index.js';
import type { ModelRig, ModelRigSource, SocketFrame } from '../../services/index.js';
import { PoseHold } from './animation_lod.js';
import { modelToWorld } from './animation_pose.js';
import type { Poses } from './animation_pose.js';
import { ANIMATOR, GARMENT, MODEL, modelPath, nameOf, SOCKET } from './fields.js';
import { garmentMap, wornPose } from './garments.js';
import type { WorldMatrices } from './fields.js';
import type { ModelLibrary } from './library.js';

interface Posed {
  readonly asset: ModelAsset;
  readonly worlds: Float32Array;
}

export class ModelPoser {
  readonly #world: World;
  readonly #models: ModelLibrary;
  readonly #poses: Poses;
  readonly #placed: WorldMatrices;
  readonly #now: () => number;
  /** This frame's posed models, by entity. */
  readonly #posed = new Map<EntityId, Posed | null>();
  /** Animation level of detail: far animators' poses held for a few frames (`animation_lod.ts`). */
  readonly hold = new PoseHold();
  /** Garment node → body node, per garment model and body model. */
  readonly #garmentMaps = new WeakMap<ModelAsset, WeakMap<ModelAsset, Int32Array>>();

  constructor(world: World, models: ModelLibrary, poses: Poses, placed: WorldMatrices, now: () => number) {
    this.#world = world;
    this.#models = models;
    this.#poses = poses;
    this.#placed = placed;
    this.#now = now;
  }

  /** Forget last frame's poses and placements (call before each frame). */
  frame(): void {
    this.#posed.clear();
    this.#placed.clear();
    this.hold.frame();
  }

  /** Frames between the animated entity's poses (1: every frame; `animation_lod.ts`), from its model → world matrix. */
  #stride(record: EntityRecord, toWorld: M4): number {
    if (!record.components.has(ANIMATOR)) return 1;
    if (this.#poses.ragdolled(record.id)) {
      this.hold.drop(record.id);
      return 1;
    }
    return this.hold.stride(toWorld[12]!, toWorld[13]!, toWorld[14]!);
  }

  /** The animator's model-space pose of `asset`, held for far entities (never when `fresh`). */
  #pose(asset: ModelAsset, record: EntityRecord, fresh: boolean): Float32Array {
    const toWorld = this.toWorld(record);
    const stride = fresh ? 1 : this.#stride(record, toWorld);
    if (stride > 1) {
      const held = this.hold.reuse(record.id, asset, stride);
      if (held !== undefined) return held;
    }
    const worlds = this.#poses.of(asset, record.components.get(ANIMATOR), nameOf(record), toWorld, record.id);
    if (stride > 1) this.hold.keep(record.id, asset, worlds);
    return worlds;
  }

  /** The entity's model → world matrix (its drawn placement, then Model.offset), for IK goals and probes. */
  toWorld(record: EntityRecord): M4 {
    return modelToWorld(this.#placed.of(record), record.components.get(MODEL)!, nameOf(record));
  }

  /** Another model's node matrices for the entity, posed as its own animator would pose it (a level-of-detail model). */
  poseAs(asset: ModelAsset, record: EntityRecord): Float32Array {
    return this.#pose(asset, record, false);
  }

  /**
   * The entity's model posed now: undefined while its file loads (and in data-only runs,
   * where it has none). Within a frame it is posed once (cached until `frame()`); `fresh`
   * poses it again without the cache (game code asking between frames).
   */
  posed(record: EntityRecord, fresh = false): Posed | undefined {
    const known = fresh ? undefined : this.#posed.get(record.id);
    if (known !== undefined) return known ?? undefined;
    const fields = record.components.get(MODEL);
    if (fields === undefined) {
      return fail('PP3821', `${nameOf(record)} has no Model`, { fix: 'Sockets, joints and looks belong to entities with a Model.' });
    }
    const where = `${nameOf(record)} model`;
    const asset = this.#models.get(modelPath(this.#models, record, fields));
    if (asset === undefined) {
      if (!fresh) this.#posed.set(record.id, null);
      return undefined;
    }
    const worn = record.components.has(GARMENT) ? this.#worn(asset, record, fresh) : undefined;
    let worlds = worn ?? this.#pose(asset, record, fresh);
    const doc = asset.code?.document;
    if (worn !== undefined) {
      // A worn garment takes the body's pose; its own joints and animator don't apply.
    } else if (doc !== undefined) {
      worlds = applyJoints(asset, worlds, jointValues(doc, fields, this.#now(), where));
    } else {
      for (const key of ['joints', 'joint_motion'] as const) {
        const set = fields[key] as Record<string, unknown> | undefined;
        if (set !== undefined && Object.keys(set).length > 0) {
          fail('PP2121', `${where}.${key} names "${Object.keys(set)[0]}", but ${asset.path} is a glTF model, which has no joints`, {
            fix: 'Joints come from model documents (assets/models/<name>.model.json); animate a glTF model with an Animator.',
          });
        }
      }
    }
    const posed = { asset, worlds };
    if (!fresh) this.#posed.set(record.id, posed);
    return posed;
  }

  /**
   * A garment's pose on its parent's skeleton (`garments.ts`): undefined when its parent
   * has no Model (it poses as any model), its rest pose while the body's model loads.
   */
  #worn(asset: ModelAsset, record: EntityRecord, fresh: boolean): Float32Array | undefined {
    const parent = record.parent === null ? undefined : this.#world.peek(record.parent);
    const bodyFields = parent?.components.get(MODEL);
    if (parent === undefined || bodyFields === undefined) return undefined;
    const body = this.posed(parent, fresh);
    if (body === undefined) return this.#poses.rest(asset);
    let maps = this.#garmentMaps.get(asset);
    if (maps === undefined) this.#garmentMaps.set(asset, (maps = new WeakMap()));
    let map = maps.get(body.asset);
    if (map === undefined) maps.set(body.asset, (map = garmentMap(asset, body.asset)));
    const fit = modelOffsetMatrix(record.components.get(MODEL)!, `${nameOf(record)} model`);
    const toGarment = multiply(invert(fit)!, modelOffsetMatrix(bodyFields, `${nameOf(parent)} model`));
    return wornPose(asset, map, this.#poses.rest(asset), { worlds: body.worlds, rest: this.#poses.rest(body.asset) }, toGarment, fit);
  }

  /** A socket's frame relative to the entity (Model.offset included), posed now. Undefined while the model loads. */
  socketLocal(record: EntityRecord, socket: string, fresh = false): M4 | undefined {
    const posed = this.posed(record, fresh);
    if (posed === undefined) return undefined;
    const fields = record.components.get(MODEL)!;
    const where = `${nameOf(record)} socket "${socket}"`;
    return multiply(modelOffsetMatrix(fields, `${nameOf(record)} model`), socketMatrix(posed.asset, posed.worlds, socket, where));
  }

  /** Keep every socketed entity on its socket (before anything is drawn). */
  followSockets(): void {
    for (const [id, socket] of this.#world.query([SOCKET])) {
      const record = this.#world.get(id)!;
      const name = socket!['name'];
      if (typeof name !== 'string') fail('PP3800', `${nameOf(record)} socket.name must be a string`);
      const parent = record.parent === null ? undefined : this.#world.get(record.parent);
      if (parent === undefined || !parent.components.has(MODEL)) {
        fail('PP3821', `${nameOf(record)} has a socket component ("${name}") but its parent has no Model`, {
          fix: 'Attach it with parent.attach(child, socket=...) to an entity with a Model, or remove the socket component.',
        });
      }
      const local = this.socketLocal(parent, name);
      if (local === undefined) continue;
      const { t, r } = decompose(Array.from(local));
      record.transform.position = new Vec3(t[0], t[1], t[2]);
      record.transform.rotation = new Quat(r[0], r[1], r[2], r[3]);
    }
    // Garments sit on their body's origin (their pose is the body's skeleton).
    for (const [id] of this.#world.query([GARMENT])) {
      const record = this.#world.get(id)!;
      const parent = record.parent === null ? undefined : this.#world.get(record.parent);
      if (parent === undefined || !parent.components.has(MODEL)) continue;
      const t = record.transform;
      if (!t.position.__eq__(Vec3.ZERO)) t.position = Vec3.ZERO;
      const q = t.rotation;
      if (q.x !== 0 || q.y !== 0 || q.z !== 0 || q.w !== 1) t.rotation = Quat.IDENTITY;
    }
    // Entities moved: placements taken so far are stale.
    this.#placed.clear();
  }

  /** The rig of a loaded model, for the model rig service. */
  static rigOf(model: ModelAsset): ModelRig {
    const doc = model.code?.document ?? null;
    const materials = new Set<string>();
    for (const mesh of model.meshes) for (const p of mesh) if (p.materialName !== null) materials.add(p.materialName);
    return {
      path: model.path,
      document: doc,
      sockets: socketNames(model, null),
      parts: doc === null ? [...model.nodeByName.keys()] : doc.parts.map((p) => p.name),
      materials: doc === null ? [...materials] : [...doc.materials.keys()],
      clips: [...model.clips.keys()],
    };
  }
}

/** A socket frame as engine values. */
export function frameOf(m: M4): SocketFrame {
  const { t, r } = decompose(Array.from(m));
  return { position: new Vec3(t[0], t[1], t[2]), rotation: new Quat(r[0], r[1], r[2], r[3]) };
}

/** An entity's local → world matrix, composed up its hierarchy exactly as the kernel composes transforms. */
function worldMatrix(world: World, record: EntityRecord): M4 {
  const { position: p, rotation: q, scale: s } = record.transform;
  const local = compose(p.x, p.y, p.z, q.x, q.y, q.z, q.w, s.x, s.y, s.z);
  const parent = record.parent === null ? undefined : world.peek(record.parent);
  return parent === undefined ? local : multiply(worldMatrix(world, parent), local);
}

/** The `model_rig` service over the loaded models and the poser. */
export function modelRigService(world: World, models: ModelLibrary, looks: () => ModelPoser, authored: () => readonly string[] = () => []): ModelRigSource {
  return {
    rig: (ref) => models.rig(ref),
    authoredClips: authored,
    socket(entity, socket, space) {
      const record = world.peek(entity);
      if (record === undefined) fail('PP3002', `A socket ("${socket}") was asked of an entity that no longer exists`);
      const fields = record.components.get(MODEL);
      if (fields === undefined) fail('PP3821', `${nameOf(record)} has no Model, so it has no socket "${socket}"`);
      const local = looks().socketLocal(record, socket, true);
      if (local === undefined) return models.rig(refString(fields['model'], `${nameOf(record)} model.model`)) === null ? null : undefined;
      return frameOf(space === 'local' ? local : multiply(worldMatrix(world, record), local));
    },
  };
}
