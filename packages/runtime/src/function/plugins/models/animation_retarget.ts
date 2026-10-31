/**
 * Bone names across rigs, and retargeting a clip from one skeleton onto another.
 *
 * Names. `canonicalBone` reduces a bone name to a rig-neutral key: namespace prefixes
 * ("mixamorig:", "Armature|") and separators go, sides are read from Left/L_/_l/.L, and
 * common synonyms meet (thigh → upleg, calf/shin → leg, upperarm → arm, lowerarm →
 * forearm, pelvis → hips, chest → spine2). "mixamorig:LeftUpLeg", "thigh_l" and
 * "LeftUpperLeg" are all `leftupleg`. Masks, limbs and retargeting match bones this way,
 * after an exact name.
 *
 * Retargeting is bind-pose aware: a source bone's rotation is taken as a change from its
 * own bind pose, in model space, and applied to the target bone's bind pose:
 *
 *   target world = source world · source bind world⁻¹ · target bind world
 *   target local = target parent world⁻¹ · target world
 *
 * computed parent-first over the target's own hierarchy (bones only one rig has keep
 * their bind pose there), so rigs with different rest orientations (a T-pose and an
 * A-pose, a rig with rolled bones, an Armature node rotated by the exporter) play each
 * other's clips without folding limbs. Translations keep the target's proportions; only
 * the root (hips) travels, scaled by the ratio of the two rigs' hip heights. Both rigs are
 * assumed to face +z at bind.
 */

import { nodeMatrices, restPose, sampleClip } from '../../../resource/index.js';
import {
  getRotation, getTranslation, qinv, qmul, qnormalize, setRotation, setTranslation, worldRotations,
} from '../../../resource/index.js';
import type { Q, V3 } from '../../../resource/index.js';
import type { Clip, ModelAsset } from '../../../resource/index.js';
import { invert, transformDirection } from '../../../resource/index.js';

const SYNONYMS: Readonly<Record<string, string>> = {
  pelvis: 'hips', hip: 'hips', abdomen: 'spine', chest: 'spine2', upperchest: 'spine2',
  upperarm: 'arm', lowerarm: 'forearm', elbow: 'forearm', wrist: 'hand',
  thigh: 'upleg', upperleg: 'upleg', calf: 'leg', shin: 'leg', lowerleg: 'leg', knee: 'leg', ankle: 'foot',
  clavicle: 'shoulder', toe: 'toebase', toes: 'toebase',
};

/** A rig-neutral key for a bone name (see the module docs). */
export function canonicalBone(name: string): string {
  let n = name.replace(/^.*[:|]/, '');
  let side = '';
  const sided = [
    [/^left[\s_.-]*/i, 'left'], [/^right[\s_.-]*/i, 'right'],
    [/^l[\s_.-]+/i, 'left'], [/^r[\s_.-]+/i, 'right'],
    [/[\s_.-]+l$/i, 'left'], [/[\s_.-]+r$/i, 'right'],
    [/[\s_.-]*left$/i, 'left'], [/[\s_.-]*right$/i, 'right'],
  ] as const;
  for (const [pattern, which] of sided) {
    if (pattern.test(n)) {
      side = which;
      n = n.replace(pattern, '');
      break;
    }
  }
  const part = n.toLowerCase().replace(/[^a-z0-9]/g, '');
  return side + (SYNONYMS[part] ?? part);
}

/** Node index for a bone name: an exact name first, then by canonical key; -1 when none. */
export function findBone(model: ModelAsset, name: string): number {
  const exact = model.nodeByName.get(name);
  if (exact !== undefined) return exact;
  const key = canonicalBone(name);
  return model.nodes.findIndex((node) => node.name !== '' && canonicalBone(node.name) === key);
}

interface Retarget {
  /** Target node → source node (-1: no counterpart). */
  readonly map: Int32Array;
  readonly sourceBind: readonly Q[];
  readonly targetBind: readonly Q[];
  readonly targetRest: Float32Array;
  readonly sourceRest: Float32Array;
  /** The target's hips and how a source hips offset becomes one of the target's. */
  readonly root: { readonly target: number; readonly source: number; readonly toModel: Float32Array; readonly fromModel: Float32Array; readonly ratio: number } | null;
}

const cache = new WeakMap<ModelAsset, WeakMap<ModelAsset, Retarget>>();
const affectedCache = new WeakMap<Clip, Uint8Array>();

function build(target: ModelAsset, source: ModelAsset): Retarget {
  const keys = new Map<string, number>();
  source.nodes.forEach((node, i) => {
    if (node.name === '') return;
    const key = canonicalBone(node.name);
    if (!keys.has(key)) keys.set(key, i);
  });
  const map = new Int32Array(target.nodes.length).fill(-1);
  target.nodes.forEach((node, j) => {
    if (node.name === '') return;
    map[j] = source.nodeByName.get(node.name) ?? keys.get(canonicalBone(node.name)) ?? -1;
  });
  const targetRest = restPose(target);
  const sourceRest = restPose(source);
  let root: Retarget['root'] = null;
  const tHips = target.nodes.findIndex((n) => n.name !== '' && canonicalBone(n.name) === 'hips');
  if (tHips >= 0 && map[tHips]! >= 0) {
    const sHips = map[tHips]!;
    const tWorld = nodeMatrices(target, targetRest);
    const sWorld = nodeMatrices(source, sourceRest);
    const parentOf = (model: ModelAsset, worlds: Float32Array, node: number): Float32Array => {
      const p = model.nodes[node]!.parent;
      return p === -1 ? new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) : worlds.slice(p * 16, p * 16 + 16);
    };
    const sHeight = sWorld[sHips * 16 + 13]!;
    const tHeight = tWorld[tHips * 16 + 13]!;
    const fromModel = invert(parentOf(target, tWorld, tHips));
    if (fromModel !== null) {
      root = {
        target: tHips, source: sHips, toModel: parentOf(source, sWorld, sHips), fromModel,
        ratio: Math.abs(sHeight) > 1e-6 ? tHeight / sHeight : 1,
      };
    }
  }
  return { map, sourceBind: worldRotations(source, sourceRest), targetBind: worldRotations(target, targetRest), targetRest, sourceRest, root };
}

function retargetOf(target: ModelAsset, source: ModelAsset): Retarget {
  let bySource = cache.get(target);
  if (bySource === undefined) cache.set(target, (bySource = new WeakMap()));
  let r = bySource.get(source);
  if (r === undefined) bySource.set(source, (r = build(target, source)));
  return r;
}

/** Nodes a clip moves: the ones it animates and everything under them. */
function affected(source: ModelAsset, clip: Clip): Uint8Array {
  let marks = affectedCache.get(clip);
  if (marks !== undefined && marks.length === source.nodes.length) return marks;
  marks = new Uint8Array(source.nodes.length);
  for (const channel of clip.channels) marks[channel.node] = 1;
  for (const i of source.order) {
    const parent = source.nodes[i]!.parent;
    if (parent !== -1 && marks[parent] === 1) marks[i] = 1;
  }
  affectedCache.set(clip, marks);
  return marks;
}

/**
 * Write `source`'s `clip` at `time` (clip seconds, already wrapped) onto `pose`, a pose of
 * `target`. Only bones the clip moves are written; the rest keep what `pose` holds, so a
 * clip of the arms layers over whatever the legs do.
 */
export function sampleRetargeted(target: ModelAsset, source: ModelAsset, clip: Clip, time: number, pose: Float32Array): void {
  const r = retargetOf(target, source);
  const sPose = r.sourceRest.slice();
  sampleClip(clip, time, sPose, null);
  const moved = affected(source, clip);
  const sWorld = worldRotations(source, sPose);
  // The target as the clip has it, parent first: matched bones from the source, the rest at bind.
  const tWorld: Q[] = new Array<Q>(target.nodes.length);
  for (const j of target.order) {
    const parent = target.nodes[j]!.parent;
    const above: Q = parent === -1 ? [0, 0, 0, 1] : tWorld[parent]!;
    const i = r.map[j]!;
    if (i >= 0 && moved[i] === 1) {
      const world = qnormalize(qmul(qmul(sWorld[i]!, qinv(r.sourceBind[i]!)), r.targetBind[j]!));
      setRotation(pose, j, qmul(qinv(above), world));
      tWorld[j] = world;
    } else {
      tWorld[j] = qnormalize(qmul(above, getRotation(r.targetRest, j)));
    }
  }
  const root = r.root;
  if (root !== null && clip.channels.some((c) => c.node === root.source && c.path === 'translation')) {
    const s = getTranslation(sPose, root.source);
    const s0 = getTranslation(r.sourceRest, root.source);
    const inModel = transformDirection(root.toModel, s[0] - s0[0], s[1] - s0[1], s[2] - s0[2]);
    const local = transformDirection(root.fromModel, inModel[0] * root.ratio, inModel[1] * root.ratio, inModel[2] * root.ratio);
    const t0 = getTranslation(r.targetRest, root.target);
    const out: V3 = [t0[0] + local[0], t0[1] + local[1], t0[2] + local[2]];
    setTranslation(pose, root.target, out);
  }
}
