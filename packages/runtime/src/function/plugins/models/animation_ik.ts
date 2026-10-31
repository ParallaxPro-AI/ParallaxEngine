/**
 * Inverse kinematics on a pose, in the model's space: an analytic two-bone limb solver
 * (arms, legs: one hinge and a pole that says which way it bends) and an aim solver
 * (heads and necks turn to look). Both change local rotations only, so bone lengths and
 * the skin stay intact, and blend with the animated pose by a weight.
 */

import { nodeMatrices } from '../../../resource/index.js';
import {
  add3, cross3, dot3, getRotation, len3, nodePosition, norm3, qangle, qfromTo, qinv, qmul, qnormalize, qrotate, qslerp,
  scale3, setRotation, sub3, worldRotations,
} from '../../../resource/index.js';
import type { Q, V3 } from '../../../resource/index.js';
import type { ModelAsset } from '../../../resource/index.js';

export interface LimbNodes {
  readonly upper: number;
  readonly middle: number;
  readonly end: number;
}

/**
 * Bend `limb` so its end reaches `target` (model space), the middle joint bending toward
 * `pole` (a model-space direction). Out of reach: the limb points straight at the target.
 * The end bone keeps its animated orientation in model space (a planted foot stays flat).
 * `weight` 0 leaves the pose, 1 solves fully.
 */
export function solveTwoBone(model: ModelAsset, pose: Float32Array, limb: LimbNodes, target: Readonly<V3>, pole: Readonly<V3>, weight: number): void {
  if (weight <= 0) return;
  const worlds = nodeMatrices(model, pose);
  const rotations = worldRotations(model, pose);
  const a = nodePosition(worlds, limb.upper);
  const b = nodePosition(worlds, limb.middle);
  const c = nodePosition(worlds, limb.end);
  const l1 = len3(sub3(b, a));
  const l2 = len3(sub3(c, b));
  if (l1 < 1e-6 || l2 < 1e-6) return;
  const toTarget = sub3(target, a);
  const dist = Math.min(Math.max(len3(toTarget), Math.abs(l1 - l2) + 1e-5), (l1 + l2) * 0.99999);
  const dir = len3(toTarget) < 1e-9 ? norm3(sub3(c, a)) : norm3(toTarget);
  // The bend plane: the pole's part across the reach direction (else the current bend).
  let bend = sub3(pole, scale3(dir, dot3(pole, dir)));
  if (len3(bend) < 1e-6) bend = sub3(sub3(b, a), scale3(dir, dot3(sub3(b, a), dir)));
  if (len3(bend) < 1e-6) bend = norm3(cross3(dir, Math.abs(dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
  bend = norm3(bend);
  const cosA = Math.min(1, Math.max(-1, (l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist)));
  const sinA = Math.sqrt(1 - cosA * cosA);
  const middle = add3(a, add3(scale3(dir, l1 * cosA), scale3(bend, l1 * sinA)));
  const end = add3(a, scale3(dir, dist));

  const parentOf = (node: number): Q => {
    const p = model.nodes[node]!.parent;
    return p === -1 ? [0, 0, 0, 1] : rotations[p]!;
  };
  const turnUpper = qfromTo(sub3(b, a), sub3(middle, a));
  const upperWorld = qnormalize(qmul(turnUpper, rotations[limb.upper]!));
  const cMoved = add3(a, qrotate(turnUpper, sub3(c, a)));
  const turnMiddle = qfromTo(sub3(cMoved, middle), sub3(end, middle));
  const middleWorld = qnormalize(qmul(qmul(turnMiddle, turnUpper), rotations[limb.middle]!));
  // Bones between the three (twist bones) turned with the bone above them.
  const middleParent = model.nodes[limb.middle]!.parent === limb.upper ? upperWorld : qnormalize(qmul(turnUpper, parentOf(limb.middle)));
  const endParent = model.nodes[limb.end]!.parent === limb.middle ? middleWorld
    : qnormalize(qmul(qmul(turnMiddle, turnUpper), parentOf(limb.end)));

  const apply = (node: number, local: Q): void => {
    setRotation(pose, node, weight >= 1 ? local : qslerp(getRotation(pose, node), local, weight));
  };
  const upperLocal = qmul(qinv(parentOf(limb.upper)), upperWorld);
  const middleLocal = qmul(qinv(middleParent), middleWorld);
  const endLocal = qmul(qinv(endParent), rotations[limb.end]!);
  apply(limb.upper, upperLocal);
  apply(limb.middle, middleLocal);
  apply(limb.end, endLocal);
}

/**
 * Turn `bones` (parent first) so the last one's forward — the model's +z at bind —
 * points at `target` (model space), sharing the turn between them, at most `maxAngle`
 * degrees in all. `bind` is the model's rest-pose world rotations.
 */
export function solveAim(
  model: ModelAsset, pose: Float32Array, bones: readonly number[], bind: readonly Q[], target: Readonly<V3>, maxAngle: number, weight: number,
): void {
  if (weight <= 0 || bones.length === 0) return;
  const head = bones[bones.length - 1]!;
  const worlds = nodeMatrices(model, pose);
  const rotations = worldRotations(model, pose);
  const forwardLocal = qrotate(qinv(bind[head]!), [0, 0, 1]);
  const forward = qrotate(rotations[head]!, forwardLocal);
  const toTarget = sub3(target, nodePosition(worlds, head));
  if (len3(toTarget) < 1e-6) return;
  let turn = qfromTo(forward, toTarget);
  const angle = qangle(turn);
  const limit = angle > maxAngle && angle > 0 ? maxAngle / angle : 1;
  turn = qslerp([0, 0, 0, 1], turn, limit * Math.min(1, weight));
  const share = qslerp([0, 0, 0, 1], turn, 1 / bones.length);
  for (const bone of bones) {
    const current = worldRotations(model, pose);
    const parent = model.nodes[bone]!.parent;
    const above: Q = parent === -1 ? [0, 0, 0, 1] : current[parent]!;
    setRotation(pose, bone, qmul(qinv(above), qmul(share, current[bone]!)));
  }
}
