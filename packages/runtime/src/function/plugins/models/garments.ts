/**
 * Skinned garments: a model worn on another model's skeleton (sdk/parallax/characters.pyi
 * `Garment`). An entity with a `garment` component, parented to an entity with a Model, is
 * posed by its parent's posed skeleton instead of its own animator: each of the garment's
 * bones that the body has (by name, exactly or rig-neutrally: "mixamorig:Spine" = "Spine" =
 * "spine_01") moves as the body's bone moved from its rest pose, so a jacket, hair or armor
 * modelled on the same (or a similar) skeleton bends with the body's every animation, IK
 * and ragdoll, and with its animation level of detail. Garment bones the body lacks (a
 * coat's tail) follow their parent bone rigidly.
 *
 *   garment bone world = C · body posed · body rest⁻¹ · F · garment rest
 *
 * A garment is modelled in the body's model space (on the same skeleton), so its rest
 * pose is read there: F is the garment's own Model.offset, a fit nudge in the bind pose,
 * and C takes the body's model space (its Model.offset) to the garment's, where it is
 * drawn. The garment entity sits on the body's origin (the poser keeps it there).
 */

import type { ModelAsset } from '../../../resource/index.js';
import { invert, multiply } from '../../../resource/index.js';
import type { M4 } from '../../../resource/index.js';
import { canonicalBone } from './animation_retarget.js';

/** The body node each garment node follows (-1: none, it follows its parent rigidly). */
export function garmentMap(garment: ModelAsset, body: ModelAsset): Int32Array {
  const map = new Int32Array(garment.nodes.length).fill(-1);
  const bodyJoints = new Set(body.skins.flatMap((s) => s.joints));
  const byName = new Map<string, number>();
  const byKey = new Map<string, number>();
  const add = (n: number): void => {
    const name = body.nodes[n]!.name;
    if (name === '') return;
    if (!byName.has(name)) byName.set(name, n);
    const key = canonicalBone(name);
    if (!byKey.has(key)) byKey.set(key, n);
  };
  // Joints first, so a bone wins over a same-named plain node.
  for (const n of bodyJoints) add(n);
  body.nodes.forEach((_, n) => { if (!bodyJoints.has(n)) add(n); });
  const joints = new Set(garment.skins.flatMap((s) => s.joints));
  garment.nodes.forEach((node, n) => {
    if (!joints.has(n) || node.name === '') return;
    map[n] = byName.get(node.name) ?? byKey.get(canonicalBone(node.name)) ?? -1;
  });
  return map;
}

/**
 * The garment's node matrices (its model space) worn on a body posed `body.worlds`.
 * `toGarment` is C (body model space → garment model space), `fit` is F (the garment's
 * offset); `body.rest` and `garmentRest` are the models' rest-pose node matrices.
 */
export function wornPose(garment: ModelAsset, map: Int32Array, garmentRest: Float32Array, body: { readonly worlds: Float32Array; readonly rest: Float32Array },
  toGarment: M4, fit: M4): Float32Array {
  const out = new Float32Array(garment.nodes.length * 16);
  const restInverse = new Map<number, M4>();
  const at = (array: Float32Array, n: number): Float32Array => array.subarray(n * 16, n * 16 + 16);
  for (const n of garment.order) {
    const rest = at(garmentRest, n);
    const b = map[n]!;
    const parent = garment.nodes[n]!.parent;
    let world: M4;
    if (b >= 0) {
      let inverse = restInverse.get(b);
      if (inverse === undefined) {
        inverse = invert(at(body.rest, b)) ?? new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        restInverse.set(b, inverse);
      }
      // The body bone's motion from its rest, applied to the garment's fitted rest.
      world = multiply(toGarment, multiply(multiply(at(body.worlds, b), inverse), multiply(fit, rest)));
    } else if (parent === -1) {
      world = multiply(toGarment, multiply(fit, rest));
    } else {
      world = multiply(at(out, parent), multiply(invert(at(garmentRest, parent)) ?? rest, rest));
    }
    out.set(world, n * 16);
  }
  return out;
}
