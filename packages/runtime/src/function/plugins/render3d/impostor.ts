/**
 * Impostors: what a far model (`lod.impostor`) is drawn as. One `ImpostorSource3d` per
 * model — its meshes in the rest pose (skinned meshes in their bind pose), its bounding
 * sphere, and the atlas size (`IMPOSTOR_FRAMES` × `IMPOSTOR_FRAMES` views of
 * `IMPOSTOR_FRAME_SIZE` texels) — which the surface bakes once into an octahedral atlas;
 * then every far instance is one camera-facing quad (`ImpostorBatch3d`). An instance keeps
 * its entity's position, uniform scale and heading (yaw); other rotations and the
 * entity's looks (options, recolors, tint) are not baked in.
 */


import type { Geometry3d, ImpostorBatch3d, ImpostorSource3d, Material3d, Xyz } from '../../../core/index.js';
import { identity, nodeMatrices, restPose } from '../../../resource/index.js';
import type { M4, ModelAsset } from '../../../resource/index.js';

/** Views per side of an impostor's atlas, and texels per view. */
export const IMPOSTOR_FRAMES = 8;
export const IMPOSTOR_FRAME_SIZE = 128;

/** A model's impostor source: its rest-pose meshes, bounding sphere and atlas size. */
export function impostorSource(asset: ModelAsset): ImpostorSource3d {
  const worlds = nodeMatrices(asset, restPose(asset));
  const parts: { geometry: Geometry3d; material: Material3d; matrix: M4 }[] = [];
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const n of asset.order) {
    const node = asset.nodes[n]!;
    if (node.mesh === null) continue;
    for (const primitive of asset.meshes[node.mesh] ?? []) {
      if (primitive.material.alphaMode === 'blend') continue;
      // Skinned vertices are already in model space at the bind pose.
      const matrix = node.skin !== null && primitive.geometry.joints !== null ? identity() : worlds.slice(n * 16, n * 16 + 16);
      parts.push({ geometry: primitive.geometry, material: primitive.material, matrix });
      const g = primitive.geometry;
      for (let i = 0; i < 8; i++) {
        const x = i & 1 ? g.max[0] : g.min[0];
        const y = i & 2 ? g.max[1] : g.min[1];
        const z = i & 4 ? g.max[2] : g.min[2];
        for (let k = 0; k < 3; k++) {
          const v = matrix[k]! * x + matrix[4 + k]! * y + matrix[8 + k]! * z + matrix[12 + k]!;
          lo[k] = Math.min(lo[k]!, v);
          hi[k] = Math.max(hi[k]!, v);
        }
      }
    }
  }
  const empty = parts.length === 0;
  const center: Xyz = empty ? [0, 0, 0] : [(lo[0]! + hi[0]!) / 2, (lo[1]! + hi[1]!) / 2, (lo[2]! + hi[2]!) / 2];
  const radius = empty ? 0 : Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!) / 2;
  return { id: `impostor:${asset.path}`, parts, center, radius, frames: IMPOSTOR_FRAMES, frameSize: IMPOSTOR_FRAME_SIZE };
}

/** Impostor instances gathered over a frame, one batch per source. */
export class Impostors {
  readonly #sources = new WeakMap<ModelAsset, ImpostorSource3d>();
  #open = new Map<ImpostorSource3d, { numbers: number[]; entities: (number | null)[] }>();
  #ready: ImpostorBatch3d[] = [];

  sourceOf(asset: ModelAsset): ImpostorSource3d {
    let source = this.#sources.get(asset);
    if (source === undefined) {
      source = impostorSource(asset);
      this.#sources.set(asset, source);
    }
    return source;
  }

  /** One far instance: the model placed by `m` (model → world), drawn with an LOD fade. */
  add(asset: ModelAsset, m: ArrayLike<number>, fade: number, entity: number | null): void {
    const source = this.sourceOf(asset);
    if (source.parts.length === 0) return;
    let batch = this.#open.get(source);
    if (batch === undefined) this.#open.set(source, (batch = { numbers: [], entities: [] }));
    const scale = Math.max(Math.hypot(m[0]!, m[1]!, m[2]!), Math.hypot(m[4]!, m[5]!, m[6]!), Math.hypot(m[8]!, m[9]!, m[10]!));
    const yaw = Math.atan2(m[8]!, m[10]!);
    batch.numbers.push(m[12]!, m[13]!, m[14]!, scale, yaw, fade, 0, 0);
    batch.entities.push(entity);
  }

  /** Batches built elsewhere this frame (far foliage, foliage.ts), drawn with the rest. */
  include(batches: readonly ImpostorBatch3d[]): void {
    for (const b of batches) if (b.count > 0) this.#ready.push(b);
  }

  close(): ImpostorBatch3d[] {
    const out: ImpostorBatch3d[] = [...this.#open].map(([source, b]) => ({
      source, count: b.entities.length, instances: new Float32Array(b.numbers), entities: b.entities,
    }));
    this.#open = new Map();
    out.push(...this.#ready);
    this.#ready = [];
    return out;
  }
}

