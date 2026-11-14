/**
 * Model entities drawn: each frame the models plugin poses them (the `model_poses`
 * service: animator, joints, IK, ragdoll); this draws every shown mesh node with the
 * entity's look (options, recolors, shown parts — resource/models `lookOf`), its tint and
 * Model.offset, skinned meshes with their bone palettes, and morph targets deformed
 * (`morph.ts`). A draw can be placed on a layer, in some views only, faded, or with some
 * Model options replaced (a first-person body's own view): `DrawStyle`.
 *
 * A skinned model's meshes that share a skin and a material are drawn as one: a character
 * of ninety parts in twenty materials is twenty draws per pass, not ninety (in every
 * shadow cascade too). The merged geometry is built once per set of shown parts and kept.
 * Morphed and blended meshes are drawn on their own.
 */

import type { EntityId, Geometry3d, Material3d, SkinnedDraw } from '../../../core/index.js';
import { LookMaterials, lookOf, modelOffsetMatrix, multiply, skinPalette } from '../../../resource/index.js';
import type { ModelAsset, ModelPrimitive } from '../../../resource/index.js';
import type { EntityRecord, Fields } from '../../kernel/index.js';
import type { ModelPoseSource } from '../../services/index.js';
import type { BatchSink, DrawStyle, Materials, Placed3d } from './draw.js';
import { nameOf, rgba, WORLD_DRAW } from './draw.js';
import { MorphedGeometry, morphActive } from './morph.js';

/** The fields with some Model options replaced (a first-person body's own view). */
function withOptions(fields: Fields, options: Readonly<Record<string, string>>): Fields {
  let base = fields['options'];
  if (base !== null && typeof base === 'object' && typeof (base as { toJSON?: unknown }).toJSON === 'function') base = (base as { toJSON(): unknown }).toJSON();
  const merged = { ...(base as Record<string, unknown> | null | undefined ?? {}), ...options };
  return Object.create(fields, { options: { value: merged, enumerable: true } }) as Fields;
}

/** Scratch for a node's draw matrix: sinks copy the matrix they are given (Batches, StaticMerge). */
const NODE_MATRIX = new Float32Array(16);

/** One skinned mesh waiting to be drawn, maybe merged with others of its skin and material. */
interface SkinnedPart {
  readonly geometry: Geometry3d;
  readonly material: Material3d;
  readonly casts: boolean;
  readonly skin: number;
}

/** Skinned geometries of one skin concatenated into one (joint indices stay valid: same skin). */
export function mergeSkinned(id: string, parts: readonly Geometry3d[]): Geometry3d {
  let vertices = 0;
  let indexCount = 0;
  let colored = false;
  for (const g of parts) {
    vertices += g.positions.length / 3;
    indexCount += g.indices.length;
    colored ||= g.colors !== null;
  }
  const positions = new Float32Array(vertices * 3);
  const normals = new Float32Array(vertices * 3);
  const uvs = new Float32Array(vertices * 2);
  const joints = new Uint16Array(vertices * 4);
  const weights = new Float32Array(vertices * 4);
  const colors = colored ? new Float32Array(vertices * 4).fill(1) : null;
  const indices = vertices > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let v = 0;
  let i = 0;
  for (const g of parts) {
    const n = g.positions.length / 3;
    positions.set(g.positions, v * 3);
    normals.set(g.normals, v * 3);
    uvs.set(g.uvs, v * 2);
    joints.set(g.joints!, v * 4);
    weights.set(g.weights!, v * 4);
    if (colors !== null && g.colors !== null) colors.set(g.colors, v * 4);
    for (let k = 0; k < g.indices.length; k++) indices[i + k] = g.indices[k]! + v;
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a]!, g.min[a]!);
      max[a] = Math.max(max[a]!, g.max[a]!);
    }
    v += n;
    i += g.indices.length;
  }
  return {
    id, positions, normals, uvs, indices, joints, weights, colors,
    min: [min[0]!, min[1]!, min[2]!], max: [max[0]!, max[1]!, max[2]!],
  };
}

export class ModelDraws {
  readonly #materials = new LookMaterials();
  /** This frame's morph weights, by entity (null: none). */
  readonly #weights = new Map<EntityId, ReadonlyMap<number, Float32Array> | null>();
  /** Each entity's morphed geometry copies, by primitive (kept while it lives). */
  readonly #morphed = new Map<EntityId, Map<ModelPrimitive, MorphedGeometry>>();
  /** Merged skinned geometry, by the ids of the meshes it joins (`mergeSkinned`). */
  readonly #merged = new Map<string, Geometry3d>();

  /** The one geometry drawing these skinned meshes together. */
  #mergedOf(parts: readonly SkinnedPart[]): Geometry3d {
    let key = 'skinned+';
    for (const p of parts) key += `${p.geometry.id}|`;
    let merged = this.#merged.get(key);
    if (merged === undefined) {
      merged = mergeSkinned(`${parts[0]!.geometry.id}+${parts.length}#${this.#merged.size}`, parts.map((p) => p.geometry));
      this.#merged.set(key, merged);
    }
    return merged;
  }

  /** Forget last frame's morph weights (call before each frame). */
  frame(): void {
    this.#weights.clear();
  }

  /** Drop what is kept for an entity (it left the world). */
  forget(entity: EntityId): void {
    this.#morphed.delete(entity);
  }

  /** The primitive deformed by the entity's morph weights this frame, or null when undeformed. */
  #morph(models: ModelPoseSource, record: EntityRecord, primitive: ModelPrimitive, node: number, model: ModelAsset): MorphedGeometry | null {
    const targets = primitive.morphs;
    if (targets === undefined || targets === null) return null;
    let weights = this.#weights.get(record.id);
    if (weights === undefined) {
      weights = models.morphs(model, record.id);
      this.#weights.set(record.id, weights);
    }
    const w = weights?.get(node);
    const kept = this.#morphed.get(record.id)?.get(primitive);
    if (w === undefined || (!morphActive(w) && kept === undefined)) return null;
    let mine = this.#morphed.get(record.id);
    if (mine === undefined) this.#morphed.set(record.id, (mine = new Map()));
    let geometry = mine.get(primitive);
    if (geometry === undefined) {
      geometry = new MorphedGeometry(primitive.geometry, `${primitive.geometry.id}@${record.id}`, targets.positions.length);
      mine.set(primitive, geometry);
    }
    geometry.apply(targets, w);
    return geometry;
  }

  /**
   * Draw a model entity. `style` places the draw (layer, views, fade); `options` overrides
   * Model options for this draw only; `asset` draws another model posed as the entity's
   * own would be (a level-of-detail model).
   */
  draw(
    models: ModelPoseSource, batches: BatchSink, skinned: SkinnedDraw[], materials: Materials, record: EntityRecord, fields: Fields, at: Placed3d,
    style: DrawStyle = WORLD_DRAW, options: Readonly<Record<string, string>> | null = null, asset?: ModelAsset,
    swap: ((material: Material3d, name: string | null) => Material3d) | null = null,
  ): void {
    const posed = models.posed(record.id);
    if (posed === undefined) return;
    const model = asset ?? posed.asset;
    const own = model === posed.asset;
    const worlds = own ? posed.worlds : models.poseAs(model, record.id);
    const where = `${nameOf(record)} model`;
    const look = lookOf(model, options === null ? fields : withOptions(fields, options), where);
    const tint = rgba(fields['tint'], `${where}.tint`);
    const base = multiply(at.m, modelOffsetMatrix(fields, where));
    const cast = fields['cast_shadows'] === true;
    const palettes = new Map<number, Float32Array>();
    const parts = model.code?.document.parts;
    // Skinned meshes to draw, grouped by skin, material and shadow casting (first seen first).
    const groups = new Map<string, SkinnedPart[]>();
    for (const n of model.order) {
      const node = model.nodes[n]!;
      if (node.mesh === null || look.hidden?.[n] === 1) continue;
      // A document's part says whether its mesh casts shadows.
      const partShadows = parts === undefined || parts[model.code!.meshPart[node.mesh]!]!.castShadows;
      for (const primitive of model.meshes[node.mesh] ?? []) {
        const own = this.#materials.of(model, primitive, look);
        const looked = swap === null ? own : materials.keep(swap(own, primitive.materialName));
        const material = tint[3] < 1 ? materials.blended(looked) : looked;
        const casts = cast && partShadows && material.alphaMode !== 'blend';
        const geometry = (own ? this.#morph(models, record, primitive, n, model) : null) ?? primitive.geometry;
        if (node.skin !== null && primitive.geometry.joints !== null) {
          const part = { geometry, material, casts, skin: node.skin };
          // Morphed (per-entity, rewritten) and blended (sorted per draw) meshes stay their own draws.
          const key = geometry !== primitive.geometry || material.alphaMode === 'blend'
            ? `own|${groups.size}` : `${node.skin}|${material.id}|${casts}`;
          const group = groups.get(key);
          if (group === undefined) groups.set(key, [part]);
          else group.push(part);
        } else {
          batches.add(geometry, material, casts, multiply(base, worlds.subarray(n * 16, n * 16 + 16), NODE_MATRIX), tint, record.id, style);
        }
      }
    }
    for (const group of groups.values()) {
      const first = group[0]!;
      const skin = model.skins[first.skin]!;
      let palette = palettes.get(first.skin);
      if (palette === undefined) {
        palette = skinPalette(skin, worlds);
        palettes.set(first.skin, palette);
      }
      skinned.push({
        geometry: group.length === 1 ? first.geometry : this.#mergedOf(group), material: first.material, model: base, tint, palette,
        jointCount: skin.joints.length, entity: record.id,
        castShadows: first.casts && style.shadows && style.layer === 'world',
        ...(style.layer !== 'world' && { layer: style.layer }),
        ...(style.views !== undefined && { views: style.views }),
        ...(style.fade !== 1 && { fade: style.fade }),
      });
    }
  }
}
