/**
 * A model entity's pose this frame, from its animator's playback (`animator.__playback__`,
 * the visuals plugin's `AnimatorPlayback`):
 *
 *   1. layers, bottom to top: each blends its clips (sampled from the model, or
 *      retargeted from another model or an authored rig) by their weights, then either
 *      overrides the pose under it or adds its motion to it (additive: the clip's change
 *      from its first frame), within its mask (named bones and everything under them),
 *      by the layer's weight;
 *   2. root motion: when the animator moves the entity by its root bone, the bone's own
 *      horizontal travel and heading are taken out of the pose (they are the entity's now);
 *   3. IK: foot planting (the hips drop and each leg reaches the ground under its foot,
 *      found by a physics3d raycast), reach goals (two-bone limbs) and look-at.
 *
 * Bone names match exactly, then by `canonicalBone`. A name the model doesn't have is
 * PP3780 with the bones it does have.
 */

import { closestMatch, fail, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import type { Fields, Kernel } from '../../kernel/index.js';
import { PHYSICS3D_SERVICE, RAGDOLL_POSE_SERVICE } from '../../services/index.js';
import type { Pose } from '../../services/index.js';
import { blendPoses, clipTime, nodeMatrices, POSE_STRIDE, restPose, sampleClip } from '../../../resource/index.js';
import type { ClipLibrary } from './animation_clips.js';
import { rootBoneOf } from './animation_clips.js';
import { solveAim, solveTwoBone } from './animation_ik.js';
import type { LimbNodes } from './animation_ik.js';
import {
  getRotation, getTranslation, nodePosition, qinv, qmul, qrotate, qslerp, qtwistY, setRotation, setTranslation, worldRotations,
} from '../../../resource/index.js';
import type { Q, V3 } from '../../../resource/index.js';
import { findBone, sampleRetargeted } from './animation_retarget.js';
import { sampleMorphChannel } from './animation_morph.js';
import type { ModelAsset } from '../../../resource/index.js';
import { vec3 } from './fields.js';
import { invert, modelOffsetMatrix, multiply, transformDirection, transformPoint } from '../../../resource/index.js';
import type { M4 } from '../../../resource/index.js';

interface SampleView { readonly clip: string; readonly time: number; readonly loop: boolean; readonly weight: number }
interface LayerView {
  readonly name: string;
  readonly weight: number;
  readonly additive: boolean;
  readonly mask: readonly string[] | null;
  readonly samples: readonly SampleView[];
}
interface GoalView {
  readonly point: readonly [number, number, number] | null;
  readonly entity: EntityId | null;
  readonly weight: number;
  /**
   * Reach goals: the end bone's world orientation (x, y, z, w), or `orient` true to take the
   * goal entity's. Absent or null (and not orienting): the limb keeps its animated hand.
   */
  readonly rotation?: readonly [number, number, number, number] | null;
  readonly orient?: boolean;
}
interface LimbView { readonly bones: readonly [string, string, string]; readonly pole: readonly [number, number, number] }

/** A `set_morph` override: the target named `name` driven toward `value` by `weight` (0..1, eased by its fade). */
interface MorphView { readonly name: string; readonly value: number; readonly weight: number }

/** What render3d reads of the visuals plugin's `AnimatorPlayback` (structurally; plugins never import each other). */
export interface PlaybackView {
  readonly layers: readonly LayerView[];
  /** Morph target overrides (`Animator.set_morph`), over what the layers' clips give. Absent: none. */
  readonly morphs?: readonly MorphView[];
  readonly rootMotion: 'off' | 'transform' | 'character';
  readonly rootBone: string | null;
  readonly ik: {
    readonly reach: readonly (LimbView & GoalView)[];
    readonly look: (GoalView & { readonly bones: readonly string[]; readonly maxAngle: number }) | null;
    readonly feet: {
      readonly limbs: readonly LimbView[];
      readonly maxDrop: number;
      readonly maxStep: number;
      readonly ground: readonly string[];
      readonly weight: number;
    } | null;
  };
}

export class Poses {
  readonly #clips: ClipLibrary;
  readonly #kernel: Kernel;
  readonly #rest = new Map<ModelAsset, Float32Array>();
  readonly #bind = new WeakMap<ModelAsset, Q[]>();
  readonly #masks = new WeakMap<ModelAsset, Map<string, Uint8Array>>();

  constructor(clips: ClipLibrary, kernel: Kernel) {
    this.#clips = clips;
    this.#kernel = kernel;
  }

  /** Whether physics drives some of the entity's bones now (a ragdoll blended in). */
  ragdolled(entity: EntityId): boolean {
    const ragdoll = this.#kernel.tryService(RAGDOLL_POSE_SERVICE)?.pose(entity);
    return ragdoll !== undefined && ragdoll.weight > 0;
  }

  /** The rest pose's node matrices (shared; don't modify). */
  rest(model: ModelAsset): Float32Array {
    let worlds = this.#rest.get(model);
    if (worlds === undefined) {
      worlds = nodeMatrices(model, restPose(model));
      this.#rest.set(model, worlds);
    }
    return worlds;
  }

  /**
   * The model's node matrices (model space) for its animator, or the rest pose without
   * one. `toWorld` is the model's model → world matrix (entity × Model.offset), for IK
   * goals and ground probes; `entity` is the model's entity (its own colliders are no ground).
   */
  of(model: ModelAsset, animator: Fields | undefined, where: string, toWorld: M4, entity: EntityId): Float32Array {
    if (animator === undefined) {
      const ragdoll = this.#kernel.tryService(RAGDOLL_POSE_SERVICE)?.pose(entity);
      if (ragdoll === undefined || ragdoll.weight <= 0) return this.rest(model);
      const pose = restPose(model);
      applyRagdoll(model, pose, ragdoll.bones, ragdoll.weight);
      return nodeMatrices(model, pose);
    }
    const playback = (animator as { __playback__?: PlaybackView }).__playback__;
    if (playback === undefined) {
      return fail('PP9801', `${where} has an animator without __playback__`, {
        fix: 'render3d reads clip playback from the visuals plugin; build the game with it (createRuntime does).',
      });
    }
    const pose = this.pose(model, playback, `${where} animator`);
    if (playback.rootMotion !== 'off') this.#lockRoot(model, pose, playback.rootBone, `${where} animator`);
    const ragdoll = this.#kernel.tryService(RAGDOLL_POSE_SERVICE)?.pose(entity);
    // A limp ragdoll's bones are all physics: IK goals would only fight them.
    if (ragdoll === undefined || ragdoll.weight < 1) this.#ik(model, pose, playback, `${where} animator`, toWorld, entity);
    if (ragdoll !== undefined && ragdoll.weight > 0) applyRagdoll(model, pose, ragdoll.bones, ragdoll.weight);
    return nodeMatrices(model, pose);
  }

  /** The layered pose (local transforms) before root motion and IK. */
  pose(model: ModelAsset, playback: Pick<PlaybackView, 'layers'>, where: string): Float32Array {
    const pose = restPose(model);
    for (const layer of playback.layers) {
      const cover = layer.samples.reduce((sum, s) => sum + Math.max(0, s.weight), 0);
      const strength = layer.weight * Math.min(1, cover);
      if (strength <= 0) continue;
      const mask = layer.mask === null ? null : this.#mask(model, layer.mask, where);
      let blended: Float32Array | null = null;
      let reference: Float32Array | null = null;
      let total = 0;
      for (const s of layer.samples) {
        if (s.weight <= 0) continue;
        const sampled = pose.slice();
        if (!this.#sample(model, s.clip, s.time, s.loop, sampled, where)) continue;
        let ref: Float32Array | null = null;
        if (layer.additive) {
          ref = pose.slice();
          this.#sample(model, s.clip, 0, false, ref, where);
        }
        if (blended === null) {
          blended = sampled;
          reference = ref;
        } else {
          const u = s.weight / (total + s.weight);
          blendPoses(blended, sampled, u, blended);
          if (reference !== null && ref !== null) blendPoses(reference, ref, u, reference);
        }
        total += s.weight;
      }
      if (blended === null) continue;
      if (layer.additive) addPose(pose, blended, reference!, strength, mask);
      else mixPose(pose, blended, strength, mask);
    }
    return pose;
  }

  /**
   * Morph target weights of every node whose mesh has targets (null: the model has none):
   * the node's defaults, then each layer's clips' weight channels (the model's own clips;
   * other rigs' clips have no targets here) blended like the pose, then `set_morph`
   * overrides. A layer's mask applies to the mesh's node.
   */
  morphs(model: ModelAsset, animator: Fields | undefined, where: string): ReadonlyMap<number, Float32Array> | null {
    const out = new Map<number, Float32Array>();
    model.nodes.forEach((node, i) => {
      if (node.mesh !== null && (node.weights?.length ?? 0) > 0) out.set(i, Float32Array.from(node.weights!));
    });
    if (out.size === 0) return null;
    const playback = animator === undefined ? undefined : (animator as { __playback__?: PlaybackView }).__playback__;
    if (playback === undefined) return out;
    for (const layer of playback.layers) {
      const cover = layer.samples.reduce((sum, s) => sum + Math.max(0, s.weight), 0);
      const strength = layer.weight * Math.min(1, cover);
      if (strength <= 0) continue;
      const mask = layer.mask === null ? null : this.#mask(model, layer.mask, `${where} animator`);
      const blended = new Map<number, Float32Array>();
      const reference = new Map<number, Float32Array>();
      let total = 0;
      for (const s of layer.samples) {
        if (s.weight <= 0) continue;
        const playable = this.#clips.playable(s.clip, model, `${where} animator`);
        if (playable === undefined || playable.source !== model) continue;
        const u = s.weight / (total + s.weight);
        total += s.weight;
        const t = clipTime(playable.clip, s.time, s.loop);
        for (const [node, weights] of out) {
          const channel = playable.clip.morphChannels?.find((c) => c.node === node);
          const sampled = weights.slice();
          if (channel !== undefined) sampleMorphChannel(channel, t, sampled);
          const ref = weights.slice();
          if (layer.additive && channel !== undefined) sampleMorphChannel(channel, 0, ref);
          const into = blended.get(node);
          if (into === undefined) {
            blended.set(node, sampled);
            reference.set(node, ref);
          } else {
            const r = reference.get(node)!;
            for (let k = 0; k < into.length; k++) {
              into[k] = into[k]! + (sampled[k]! - into[k]!) * u;
              r[k] = r[k]! + (ref[k]! - r[k]!) * u;
            }
          }
        }
      }
      for (const [node, weights] of out) {
        const b = blended.get(node);
        if (b === undefined || (mask !== null && mask[node] !== 1)) continue;
        const r = reference.get(node)!;
        for (let k = 0; k < weights.length; k++) {
          weights[k] = layer.additive ? weights[k]! + (b[k]! - r[k]!) * strength : weights[k]! + (b[k]! - weights[k]!) * strength;
        }
      }
    }
    for (const m of playback.morphs ?? []) {
      let found = false;
      for (const [node, weights] of out) {
        const names = model.meshes[model.nodes[node]!.mesh!]?.[0]?.morphs?.names ?? [];
        const k = names.indexOf(m.name);
        if (k < 0) continue;
        found = true;
        weights[k] = weights[k]! + (m.value - weights[k]!) * m.weight;
      }
      if (!found) {
        const known = [...new Set([...out.keys()].flatMap((n) => model.meshes[model.nodes[n]!.mesh!]?.[0]?.morphs?.names ?? []))];
        const guess = closestMatch(m.name, known);
        fail('PP3784', `${where} animator: set_morph names "${m.name}", which ${model.path} has no morph target for`, {
          path: model.path, fix: guess !== undefined ? `Did you mean "${guess}"?` : `Its morph targets: ${known.join(', ')}.`,
        });
      }
    }
    return out;
  }

  #sample(model: ModelAsset, ref: string, time: number, loop: boolean, into: Float32Array, where: string): boolean {
    const playable = this.#clips.playable(ref, model, where);
    if (playable === undefined) return false;
    const t = clipTime(playable.clip, time, loop);
    if (playable.source === model) sampleClip(playable.clip, t, into, null);
    else sampleRetargeted(model, playable.source, playable.clip, t, into);
    return true;
  }

  #bone(model: ModelAsset, name: string, where: string): number {
    const node = findBone(model, name);
    if (node >= 0) return node;
    const bones = model.nodes.map((n) => n.name).filter((n) => n !== '');
    return fail('PP3780', `${where} names the bone "${name}", which ${model.path} doesn't have`, {
      path: model.path,
      fix: bones.length === 0 ? `${model.path} has no named nodes.` : `Its bones: ${bones.slice(0, 40).join(', ')}${bones.length > 40 ? ', …' : ''}.`,
    });
  }

  /** The nodes a mask drives: each named bone and everything under it. */
  #mask(model: ModelAsset, names: readonly string[], where: string): Uint8Array {
    let byKey = this.#masks.get(model);
    if (byKey === undefined) this.#masks.set(model, (byKey = new Map()));
    const key = names.join('\u0000');
    let mask = byKey.get(key);
    if (mask === undefined) {
      mask = new Uint8Array(model.nodes.length);
      for (const name of names) mask[this.#bone(model, name, `${where} layer mask`)] = 1;
      for (const i of model.order) {
        const parent = model.nodes[i]!.parent;
        if (parent !== -1 && mask[parent] === 1) mask[i] = 1;
      }
      byKey.set(key, mask);
    }
    return mask;
  }

  #limb(model: ModelAsset, limb: LimbView, where: string): LimbNodes {
    const [upper, middle, end] = limb.bones.map((b) => this.#bone(model, b, `${where} ik limb`)) as [number, number, number];
    return { upper, middle, end };
  }

  /** The root bone's horizontal travel and heading belong to the entity (root motion), not the pose. */
  #lockRoot(model: ModelAsset, pose: Float32Array, rootBone: string | null, where: string): void {
    const node = rootBoneOf(model, rootBone, where);
    if (node < 0) return;
    const rest = restPose(model);
    const parent = model.nodes[node]!.parent;
    const restWorlds = this.rest(model);
    const toModel = parent === -1 ? null : restWorlds.subarray(parent * 16, parent * 16 + 16);
    const t = getTranslation(pose, node);
    const t0 = getTranslation(rest, node);
    const delta: V3 = [t[0] - t0[0], t[1] - t0[1], t[2] - t0[2]];
    const inModel = toModel === null ? delta : transformDirection(toModel, delta[0], delta[1], delta[2]);
    const fromModel = toModel === null ? null : invert(toModel);
    const kept = fromModel === null ? [0, inModel[1], 0] : transformDirection(fromModel, 0, inModel[1], 0);
    setTranslation(pose, node, [t0[0] + kept[0]!, t0[1] + kept[1]!, t0[2] + kept[2]!]);
    const above: Q = parent === -1 ? [0, 0, 0, 1] : this.#bindOf(model)[parent]!;
    const world = qmul(above, getRotation(pose, node));
    const restWorld = qmul(above, getRotation(rest, node));
    const heading = qtwistY(qmul(world, qinv(restWorld)));
    setRotation(pose, node, qmul(qinv(above), qmul(qinv(heading), world)));
  }

  #bindOf(model: ModelAsset): Q[] {
    let bind = this.#bind.get(model);
    if (bind === undefined) this.#bind.set(model, (bind = worldRotations(model, restPose(model))));
    return bind;
  }

  /** A reach goal's world rotation: given, or the goal entity's (`orient`); null: none. */
  #goalRotation(goal: GoalView): Q | null {
    if (goal.rotation !== undefined && goal.rotation !== null) return [goal.rotation[0], goal.rotation[1], goal.rotation[2], goal.rotation[3]];
    if (goal.orient !== true || goal.entity === null) return null;
    const q = this.#kernel.world.get(goal.entity)?.transform.worldRotation();
    return q === undefined ? null : [q.x, q.y, q.z, q.w];
  }

  #goal(goal: GoalView): V3 | null {
    if (goal.point !== null) return [goal.point[0], goal.point[1], goal.point[2]];
    if (goal.entity === null) return null;
    const p = this.#kernel.world.get(goal.entity)?.transform.worldPosition();
    return p === undefined ? null : [p.x, p.y, p.z];
  }

  #ik(model: ModelAsset, pose: Float32Array, playback: PlaybackView, where: string, toWorld: M4, entity: EntityId): void {
    const { feet, reach, look } = playback.ik;
    if ((feet === null || feet.weight <= 0) && reach.length === 0 && look === null) return;
    const fromWorld = invert(toWorld);
    if (fromWorld === null) return;
    if (feet !== null && feet.weight > 0) this.#plantFeet(model, pose, feet, where, toWorld, fromWorld, entity);
    for (const goal of reach) {
      const world = this.#goal(goal);
      if (world === null || goal.weight <= 0) continue;
      const target = transformPoint(fromWorld, world[0], world[1], world[2]);
      const limb = this.#limb(model, goal, where);
      solveTwoBone(model, pose, limb, target, [goal.pole[0], goal.pole[1], goal.pole[2]], goal.weight);
      const turn = this.#goalRotation(goal);
      if (turn !== null) orientEnd(model, pose, limb.end, this.#bindOf(model), rotationOf(toWorld), turn, goal.weight);
    }
    if (look !== null && look.weight > 0) {
      const world = this.#goal(look);
      if (world !== null) {
        const bones = look.bones.map((b) => this.#bone(model, b, `${where} ik look`));
        solveAim(model, pose, bones, this.#bindOf(model), transformPoint(fromWorld, world[0], world[1], world[2]), look.maxAngle, look.weight);
      }
    }
  }

  #plantFeet(
    model: ModelAsset, pose: Float32Array, feet: NonNullable<PlaybackView['ik']['feet']>, where: string, toWorld: M4, fromWorld: M4, entity: EntityId,
  ): void {
    const physics = this.#kernel.service(PHYSICS3D_SERVICE);
    const limbs = feet.limbs.map((l) => ({ nodes: this.#limb(model, l, where), pole: l.pole }));
    if (limbs.length === 0) return;
    const origin = transformPoint(toWorld, 0, 0, 0);
    let worlds = nodeMatrices(model, pose);
    const down = new Vec3(0, -1, 0);
    const filter = { ignore: [entity], ...(feet.ground.length > 0 && { layers: feet.ground }) };
    const probes = limbs.map(({ nodes }) => {
      const p = nodePosition(worlds, nodes.end);
      const foot = transformPoint(toWorld, p[0], p[1], p[2]);
      const hit = physics.raycast(new Vec3(foot[0], origin[1] + feet.maxStep, foot[2]), down, feet.maxStep + feet.maxDrop, filter);
      const height = hit === undefined ? 0 : Math.min(feet.maxStep, Math.max(-feet.maxDrop, hit.point.y - origin[1]));
      return { foot, height };
    });
    const drop = Math.min(0, ...probes.map((p) => p.height)) * feet.weight;
    if (drop < 0) {
      const pelvis = model.nodes[limbs[0]!.nodes.upper]!.parent;
      if (pelvis !== -1) {
        const inModel = transformDirection(fromWorld, 0, drop, 0);
        const parent = model.nodes[pelvis]!.parent;
        const toLocal = parent === -1 ? null : invert(worlds.subarray(parent * 16, parent * 16 + 16));
        const local = toLocal === null ? inModel : transformDirection(toLocal, inModel[0], inModel[1], inModel[2]);
        const t = getTranslation(pose, pelvis);
        setTranslation(pose, pelvis, [t[0] + local[0], t[1] + local[1], t[2] + local[2]]);
        worlds = nodeMatrices(model, pose);
      }
    }
    limbs.forEach(({ nodes, pole }, i) => {
      const { foot, height } = probes[i]!;
      const target = transformPoint(fromWorld, foot[0], foot[1] + height * feet.weight, foot[2]);
      solveTwoBone(model, pose, nodes, target, [pole[0], pole[1], pole[2]], 1);
    });
  }
}

/** pose ← pose blended toward `layer` by `w`, within `mask`. */
function mixPose(pose: Float32Array, layer: Float32Array, w: number, mask: Uint8Array | null): void {
  const nodes = pose.length / POSE_STRIDE;
  for (let n = 0; n < nodes; n++) {
    if (mask !== null && mask[n] !== 1) continue;
    const o = n * POSE_STRIDE;
    for (const c of [0, 1, 2, 7, 8, 9]) pose[o + c] = pose[o + c]! + (layer[o + c]! - pose[o + c]!) * w;
    setRotation(pose, n, qslerp(getRotation(pose, n), getRotation(layer, n), w));
  }
}

/** pose ← pose plus `w` of the change from `reference` to `clip` (local space), within `mask`. */
function addPose(pose: Float32Array, clip: Float32Array, reference: Float32Array, w: number, mask: Uint8Array | null): void {
  const nodes = pose.length / POSE_STRIDE;
  for (let n = 0; n < nodes; n++) {
    if (mask !== null && mask[n] !== 1) continue;
    const o = n * POSE_STRIDE;
    for (const c of [0, 1, 2]) pose[o + c] = pose[o + c]! + (clip[o + c]! - reference[o + c]!) * w;
    for (const c of [7, 8, 9]) {
      const r = reference[o + c]! !== 0 ? reference[o + c]! : 1;
      pose[o + c] = pose[o + c]! * (1 + (clip[o + c]! / r - 1) * w);
    }
    const delta = qmul(qinv(getRotation(reference, n)), getRotation(clip, n));
    setRotation(pose, n, qmul(getRotation(pose, n), qslerp([0, 0, 0, 1], delta, w)));
  }
}

/**
 * Blend a ragdoll's bones (model space, by node name: the `ragdoll_pose` service) over a
 * pose by `weight`: each driven bone's model-space position and rotation move toward the
 * physics pose, undriven bones keep their local transforms (so they ride their parents).
 * Bones are walked parents first, so a child is solved against its moved parent.
 */
export function applyRagdoll(model: ModelAsset, pose: Float32Array, bones: ReadonlyMap<string, Pose>, weight: number): void {
  const w = Math.min(1, Math.max(0, weight));
  const rot: Q[] = new Array<Q>(model.nodes.length);
  const pos: V3[] = new Array<V3>(model.nodes.length);
  const scale: V3[] = new Array<V3>(model.nodes.length);
  for (const n of model.order) {
    const parent = model.nodes[n]!.parent;
    const pr: Q = parent === -1 ? [0, 0, 0, 1] : rot[parent]!;
    const pp: V3 = parent === -1 ? [0, 0, 0] : pos[parent]!;
    const ps: V3 = parent === -1 ? [1, 1, 1] : scale[parent]!;
    const lt = getTranslation(pose, n);
    const ls: V3 = [pose[n * POSE_STRIDE + 7]!, pose[n * POSE_STRIDE + 8]!, pose[n * POSE_STRIDE + 9]!];
    let r = qmul(pr, getRotation(pose, n));
    const scaled = qrotate(pr, [lt[0] * ps[0], lt[1] * ps[1], lt[2] * ps[2]]);
    let p: V3 = [pp[0] + scaled[0], pp[1] + scaled[1], pp[2] + scaled[2]];
    const driven = bones.get(model.nodes[n]!.name);
    if (driven !== undefined) {
      const tq: Q = [driven.rotation.x, driven.rotation.y, driven.rotation.z, driven.rotation.w];
      r = qslerp(r, tq, w);
      p = [p[0] + (driven.position.x - p[0]) * w, p[1] + (driven.position.y - p[1]) * w, p[2] + (driven.position.z - p[2]) * w];
      setRotation(pose, n, qmul(qinv(pr), r));
      const back = qrotate(qinv(pr), [p[0] - pp[0], p[1] - pp[1], p[2] - pp[2]]);
      setTranslation(pose, n, [back[0] / (ps[0] || 1), back[1] / (ps[1] || 1), back[2] / (ps[2] || 1)]);
    }
    rot[n] = r;
    pos[n] = p;
    scale[n] = [ps[0] * ls[0], ps[1] * ls[1], ps[2] * ls[2]];
  }
}

/** The rotation of a model → world matrix (its columns normalized: scale removed). */
export function rotationOf(m: ArrayLike<number>): Q {
  const c = (k: number): V3 => {
    const v: V3 = [m[k * 4]!, m[k * 4 + 1]!, m[k * 4 + 2]!];
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const [x, y, z] = [c(0), c(1), c(2)];
  const trace = x[0] + y[1] + z[2];
  let q: Q;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q = [(y[2] - z[1]) / s, (z[0] - x[2]) / s, (x[1] - y[0]) / s, s / 4];
  } else if (x[0] > y[1] && x[0] > z[2]) {
    const s = Math.sqrt(1 + x[0] - y[1] - z[2]) * 2;
    q = [s / 4, (y[0] + x[1]) / s, (z[0] + x[2]) / s, (y[2] - z[1]) / s];
  } else if (y[1] > z[2]) {
    const s = Math.sqrt(1 + y[1] - x[0] - z[2]) * 2;
    q = [(y[0] + x[1]) / s, s / 4, (z[1] + y[2]) / s, (z[0] - x[2]) / s];
  } else {
    const s = Math.sqrt(1 + z[2] - x[0] - y[1]) * 2;
    q = [(z[0] + x[2]) / s, (z[1] + y[2]) / s, s / 4, (x[1] - y[0]) / s];
  }
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/**
 * Turn a limb's end bone (a hand) to a world rotation goal, by `weight`. The goal is the
 * bone's orientation relative to its bind pose as the model faces: `modelToWorld` (the
 * entity's own rotation) leaves the hand as it is bound, so a grip socket authored facing
 * the item's front holds the hand the way the rig was modelled holding it.
 */
export function orientEnd(model: ModelAsset, pose: Float32Array, end: number, bind: readonly Q[], modelToWorld: Q, goal: Q, weight: number): void {
  const desired = qmul(qinv(modelToWorld), qmul(goal, bind[end]!));
  const parent = model.nodes[end]!.parent;
  const above: Q = parent === -1 ? [0, 0, 0, 1] : worldRotations(model, pose)[parent]!;
  const local = qmul(qinv(above), desired);
  setRotation(pose, end, qslerp(getRotation(pose, end), local, Math.min(1, Math.max(0, weight))));
}

/** A model's model → world matrix: its entity's placement, then `Model.offset` and `rotation_offset` (as modelDraws draws it). */
export function modelToWorld(entity: M4, model: Fields, where: string): M4 {
  vec3(model['offset'], `${where} model.offset`);
  return multiply(entity, modelOffsetMatrix(model, `${where} model`));
}
