/**
 * Morph targets (blend shapes) drawn: a mesh's weights this frame (the models plugin's
 * `model_poses` service: node defaults, clip channels, `set_morph`) deform its primitives
 * on the CPU into a per-entity copy of the geometry:
 *
 *     position = base + Σ weight[t] · delta[t]      (normals likewise, renormalized)
 *
 * The copy is a dynamic `Geometry3d` (`version` grows on every change), so a surface keeps
 * one GPU buffer per entity and rewrites only positions and normals, and only on frames
 * where the weights moved. Skinned meshes are morphed first and skinned on the GPU after,
 * as glTF specifies. Its bounds grow by the most any active target can move a vertex.
 */

import type { Geometry3d, Xyz } from '../../../core/index.js';
import type { MorphTargets } from '../../../resource/index.js';

/** Weights this small are no deformation. */
const EPSILON = 1e-5;

/** Per target, the longest position delta (for bounds). */
const reach = new WeakMap<MorphTargets, Float32Array>();

function reachOf(targets: MorphTargets): Float32Array {
  let r = reach.get(targets);
  if (r === undefined) {
    r = new Float32Array(targets.positions.length);
    targets.positions.forEach((d, t) => {
      let most = 0;
      for (let i = 0; i < d.length; i += 3) most = Math.max(most, Math.hypot(d[i]!, d[i + 1]!, d[i + 2]!));
      r![t] = most;
    });
    reach.set(targets, r);
  }
  return r;
}

/** Whether any weight deforms the mesh. */
export function morphActive(weights: ArrayLike<number>): boolean {
  for (let i = 0; i < weights.length; i++) if (Math.abs(weights[i]!) > EPSILON) return true;
  return false;
}

/** A morphed copy of a primitive's geometry, rewritten in place (`Geometry3d.version`). */
export class MorphedGeometry implements Geometry3d {
  readonly id: string;
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
  readonly indices: Uint16Array | Uint32Array;
  readonly joints: Uint16Array | null;
  readonly weights: Float32Array | null;
  readonly colors: Float32Array | null;
  min: Xyz;
  max: Xyz;
  version = 0;
  readonly #base: Geometry3d;
  readonly #last: Float32Array;

  constructor(base: Geometry3d, id: string, targets: number) {
    this.#base = base;
    this.id = id;
    this.positions = base.positions.slice();
    this.normals = base.normals.slice();
    this.uvs = base.uvs;
    this.indices = base.indices;
    this.joints = base.joints;
    this.weights = base.weights;
    this.colors = base.colors;
    this.min = base.min;
    this.max = base.max;
    this.#last = new Float32Array(targets).fill(Number.NaN);
  }

  /** Deform by `weights` (one per target); a no-op when they equal the last ones. */
  apply(targets: MorphTargets, weights: ArrayLike<number>): void {
    let same = true;
    for (let t = 0; t < this.#last.length; t++) if (this.#last[t] !== weights[t]) same = false;
    if (same) return;
    for (let t = 0; t < this.#last.length; t++) this.#last[t] = weights[t] ?? 0;
    const base = this.#base;
    const p = this.positions;
    const n = this.normals;
    p.set(base.positions);
    n.set(base.normals);
    let grow = 0;
    const r = reachOf(targets);
    let normalsMoved = false;
    targets.positions.forEach((delta, t) => {
      const w = weights[t] ?? 0;
      if (Math.abs(w) <= EPSILON) return;
      grow += Math.abs(w) * r[t]!;
      for (let i = 0; i < p.length; i++) p[i] = p[i]! + w * delta[i]!;
      const nd = targets.normals[t];
      if (nd !== null && nd !== undefined) {
        normalsMoved = true;
        for (let i = 0; i < n.length; i++) n[i] = n[i]! + w * nd[i]!;
      }
    });
    if (normalsMoved) {
      for (let i = 0; i < n.length; i += 3) {
        const l = Math.hypot(n[i]!, n[i + 1]!, n[i + 2]!) || 1;
        n[i] = n[i]! / l; n[i + 1] = n[i + 1]! / l; n[i + 2] = n[i + 2]! / l;
      }
    }
    this.min = [base.min[0] - grow, base.min[1] - grow, base.min[2] - grow];
    this.max = [base.max[0] + grow, base.max[1] + grow, base.max[2] + grow];
    this.version++;
  }
}
