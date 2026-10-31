/**
 * The frame's mesh draws, culled per view and per shadow tile (part of `plan.ts`).
 *
 * Every instance of every batch and skinned draw is packed once into the frame's instance
 * records with its world bounding sphere. Then each view takes, from every batch it may
 * draw (`MeshBatch.views`), only the instances inside its frustum (and not hidden by the
 * Hi-Z test, `occluded`): a batch wholly inside keeps its packed range; a batch partly
 * inside gets its visible instances copied into a fresh contiguous range, so it is still one
 * instanced draw. Shadow tiles do the same against the tile's light view-projection.
 *
 * Detail culling (`Quality3d.detailPixels`): an instance in the frustum whose sphere projects
 * to a radius under that many pixels of the view is left out before the Hi-Z test (a far
 * pebble, a distant bolt), and a caster under that many texels of its shadow tile casts
 * nothing. The viewmodel layer is never detail-culled.
 *
 * The viewmodel layer (first-person arms and items) is culled against its view's overlay
 * projection and drawn with it; it never casts shadows. Level-of-detail fades travel in the
 * instance record (`packInstance`'s fade); a fading-out instance casts no shadow, so two
 * levels don't double one.
 */

import { MESH_INSTANCE_STRIDE, viewDraws } from '../../../core/index.js';
import type { DrawLayer3d, Frame3d, Geometry3d, Material3d, Texture3d, View3d, ViewMask3d } from '../../../core/index.js';
import { boundingSphere, frustumPlanes, pixelScale, sphereSmall, sphereVisible } from './cull.js';
import type { CullStats, Planes } from './cull.js';
import { FADE_FLOAT, MESH_INSTANCE_FLOATS, packInstance, transmissive } from './layout.js';

/** A float array that grows as records are reserved. */
export class Growing {
  data: Float32Array;
  length = 0;

  constructor(initial: number) {
    this.data = new Float32Array(initial);
  }

  reserve(n: number): number {
    const at = this.length;
    if (at + n > this.data.length) {
      const grown = new Float32Array(Math.max(this.data.length * 2, at + n));
      grown.set(this.data);
      this.data = grown;
    }
    this.length += n;
    return at;
  }

  done(): Float32Array {
    return this.data.subarray(0, this.length);
  }
}

export interface MeshItem {
  readonly geometry: Geometry3d;
  readonly material: Material3d;
  /** Slot in `FramePlan.materials`. */
  readonly materialSlot: number;
  readonly skinned: boolean;
  readonly firstInstance: number;
  readonly instanceCount: number;
}

/** A view's mesh draws. */
export interface ViewMeshes {
  readonly opaque: readonly MeshItem[];
  /** Far to near: alpha-blended and transmissive surfaces. */
  readonly transparent: readonly MeshItem[];
  /** The viewmodel layer, opaque then blended (far to near), drawn with the view's overlay frame slot. */
  readonly viewmodel: readonly MeshItem[];
  readonly viewmodelTransparent: readonly MeshItem[];
}

/** One packed range before culling. */
interface Source {
  readonly item: MeshItem;
  readonly layer: DrawLayer3d;
  readonly views: ViewMask3d | undefined;
  readonly blended: boolean;
  readonly casts: boolean;
}

/** Every texture a material samples. */
export function materialTextures(m: Material3d): Texture3d[] {
  const out: Texture3d[] = [];
  for (const t of [m.baseColorTexture, m.metallicRoughnessTexture, m.emissiveTexture, m.normalTexture ?? null, m.occlusionTexture ?? null]) {
    if (t !== null) out.push(t);
  }
  return out;
}

/**
 * A masked material whose every fragment is cut (no base color texture to lift its alpha, and the
 * base color's alpha under the cutoff): drawn, it is invisible, so it must not cast a shadow either.
 * (The caster pass is depth only and does not alpha-test.)
 */
/** A light's fixture: an instance holding the light whose bounding radius is at most this share of its range. */
export const FIXTURE_REACH = 0.5;

export function fullyCut(m: Material3d): boolean {
  return m.alphaMode === 'mask' && m.baseColorTexture === null && m.baseColor[3] < m.alphaCutoff;
}

function texturesReady(m: Material3d, ready: (t: Texture3d) => boolean): boolean {
  return materialTextures(m).every(ready);
}

export interface MeshPlanOptions {
  readonly ready: (texture: Texture3d) => boolean;
  readonly slotOf: (material: Material3d) => number;
  /**
   * Hi-Z: whether a sphere inside a view's frustum is hidden behind what an earlier frame
   * drew (`occlusion.ts`). `view` is the camera entity. Absent: nothing is occluded.
   */
  readonly occluded?: (camera: number, x: number, y: number, z: number, r: number) => boolean;
}

export class MeshPlan {
  readonly instances = new Growing(64 * MESH_INSTANCE_FLOATS);
  readonly palette = new Growing(64 * 16);
  /** x, y, z, radius per instance record (aligned with `instances`). */
  readonly #spheres = new Growing(64 * 4);
  readonly #sources: Source[] = [];
  /** Every drawn instance of an outlined entity. */
  readonly byEntity = new Map<number, MeshItem[]>();
  readonly stats: CullStats = { tested: 0, inFrustum: 0, occluded: 0 };
  /** Instances in a view's frustum left out as too small to draw (`Quality3d.detailPixels`), summed over views. */
  detailCulled = 0;
  /** Shadow casters left out as smaller than their tile's texels, summed over tiles. */
  detailCulledCasters = 0;
  readonly #options: MeshPlanOptions;
  readonly #detail: number;

  constructor(frame: Frame3d, options: MeshPlanOptions) {
    this.#options = options;
    this.#detail = frame.quality.detailPixels ?? 0;
    const outlined = new Set(frame.outlines.map((o) => o.entity));
    const remember = (entity: number | null, item: MeshItem): void => {
      if (entity === null || !outlined.has(entity)) return;
      let list = this.byEntity.get(entity);
      if (list === undefined) this.byEntity.set(entity, (list = []));
      list.push(item);
    };
    for (const batch of frame.meshes) {
      if (batch.count === 0 || !texturesReady(batch.material, options.ready)) continue;
      const first = this.#reserve(batch.count);
      const data = this.instances.data;
      const spheres = this.#spheres.data;
      const g = batch.geometry;
      for (let i = 0; i < batch.count; i++) {
        const s = i * MESH_INSTANCE_STRIDE;
        packInstance(batch.instances, s, batch.instances, s + 16, 0, data, (first + i) * MESH_INSTANCE_FLOATS, batch.fades?.[i] ?? 1);
        boundingSphere(batch.instances, s, g.min, g.max, spheres, (first + i) * 4);
      }
      const materialSlot = options.slotOf(batch.material);
      const blended = batch.material.alphaMode === 'blend' || transmissive(batch.material);
      const layer = batch.layer ?? 'world';
      const single = (i: number): MeshItem => ({ geometry: g, material: batch.material, materialSlot, skinned: false, firstInstance: first + i, instanceCount: 1 });
      for (let i = 0; i < batch.count; i++) remember(batch.entities[i] ?? null, single(i));
      if (blended) {
        // Blended surfaces sort per instance: one source each.
        for (let i = 0; i < batch.count; i++) this.#sources.push({ item: single(i), layer, views: batch.views, blended, casts: false });
        continue;
      }
      const casts = batch.castShadows && layer === 'world' && !fullyCut(batch.material);
      this.#sources.push({
        item: { geometry: g, material: batch.material, materialSlot, skinned: false, firstInstance: first, instanceCount: batch.count },
        layer, views: batch.views, blended, casts,
      });
    }
    for (const draw of frame.skinned) {
      if (!texturesReady(draw.material, options.ready)) continue;
      const offset = this.palette.reserve(draw.jointCount * 16);
      this.palette.data.set(draw.palette.subarray(0, draw.jointCount * 16), offset);
      const index = this.#reserve(1);
      packInstance(draw.model, 0, draw.tint, 0, offset / 16, this.instances.data, index * MESH_INSTANCE_FLOATS, draw.fade ?? 1);
      // Skinned bounds: the bind-pose box, grown generously (poses reach past it).
      boundingSphere(draw.model, 0, draw.geometry.min, draw.geometry.max, this.#spheres.data, index * 4, 0.5);
      const item: MeshItem = {
        geometry: draw.geometry, material: draw.material, materialSlot: options.slotOf(draw.material), skinned: true, firstInstance: index, instanceCount: 1,
      };
      remember(draw.entity, item);
      const layer = draw.layer ?? 'world';
      const blended = draw.material.alphaMode === 'blend' || transmissive(draw.material);
      this.#sources.push({ item, layer, views: draw.views, blended, casts: !blended && draw.castShadows && layer === 'world' && (draw.fade ?? 1) > 0 && !fullyCut(draw.material) });
    }
  }

  /** Instance records with their spheres. */
  #reserve(count: number): number {
    this.#spheres.reserve(count * 4);
    return this.instances.reserve(count * MESH_INSTANCE_FLOATS) / MESH_INSTANCE_FLOATS;
  }

  /**
   * The part of a source's range that passes `keep`: the range itself when all of it does,
   * else its passing instances copied to a fresh range; null when none do.
   */
  #cull(item: MeshItem, keep: (record: number) => boolean): MeshItem | null {
    let kept = 0;
    const passing: number[] = [];
    for (let i = 0; i < item.instanceCount; i++) {
      const r = item.firstInstance + i;
      if (keep(r)) {
        kept++;
        passing.push(r);
      }
    }
    if (kept === 0) return null;
    if (kept === item.instanceCount) return item;
    const first = this.#reserve(kept);
    const data = this.instances.data;
    const spheres = this.#spheres.data;
    passing.forEach((r, k) => {
      data.copyWithin((first + k) * MESH_INSTANCE_FLOATS, r * MESH_INSTANCE_FLOATS, (r + 1) * MESH_INSTANCE_FLOATS);
      spheres.copyWithin((first + k) * 4, r * 4, r * 4 + 4);
    });
    return { ...item, firstInstance: first, instanceCount: kept };
  }

  #inside(planes: Planes, record: number): boolean {
    const s = this.#spheres.data;
    const o = record * 4;
    return sphereVisible(planes, s[o]!, s[o + 1]!, s[o + 2]!, s[o + 3]!);
  }

  /** Whether instance `record` holds the light and is small beside its reach (`forTile`). */
  #fixture(record: number, light: { readonly position: readonly number[]; readonly range: number }): boolean {
    const s = this.#spheres.data;
    const o = record * 4;
    const r = s[o + 3]!;
    if (!(r <= light.range * FIXTURE_REACH)) return false;
    const dx = light.position[0]! - s[o]!;
    const dy = light.position[1]! - s[o + 1]!;
    const dz = light.position[2]! - s[o + 2]!;
    return dx * dx + dy * dy + dz * dz <= r * r;
  }

  #center(record: number): [number, number, number] {
    const s = this.#spheres.data;
    return [s[record * 4]!, s[record * 4 + 1]!, s[record * 4 + 2]!];
  }

  /** Whether a record's sphere is under `detail` pixels of a target `scale` (`pixelScale`) projects. */
  #small(vp: ArrayLike<number>, scale: number, record: number): boolean {
    const s = this.#spheres.data;
    const o = record * 4;
    return sphereSmall(vp, scale, this.#detail, s[o]!, s[o + 1]!, s[o + 2]!, s[o + 3]!);
  }

  /** A view's draws: what it may draw, inside its frustum, large enough to see, not occluded. */
  forView(view: View3d): ViewMeshes {
    const planes = frustumPlanes(view.viewProjection);
    const vp = view.viewProjection;
    const scale = pixelScale(vp, view.viewport.width, view.viewport.height);
    const detail = this.#detail > 0;
    const overlay = view.overlay ?? null;
    const overlayPlanes = overlay === null ? planes : frustumPlanes(overlay.viewProjection);
    const occluded = this.#options.occluded;
    const stats = this.stats;
    const opaque: MeshItem[] = [];
    const viewmodel: MeshItem[] = [];
    const blended: { item: MeshItem; d: number }[] = [];
    const vmBlended: { item: MeshItem; d: number }[] = [];
    const distance = (record: number): number => {
      const [x, y, z] = this.#center(record);
      return (x - view.position[0]) ** 2 + (y - view.position[1]) ** 2 + (z - view.position[2]) ** 2;
    };
    for (const source of this.#sources) {
      if (!viewDraws(source.views, view.camera)) continue;
      const vm = source.layer === 'viewmodel';
      const p = vm ? overlayPlanes : planes;
      const item = this.#cull(source.item, (r) => {
        stats.tested++;
        if (!this.#inside(p, r)) return false;
        if (!vm && detail && this.#small(vp, scale, r)) {
          this.detailCulled++;
          return false;
        }
        stats.inFrustum++;
        if (vm || occluded === undefined) return true;
        const s = this.#spheres.data;
        if (occluded(view.camera, s[r * 4]!, s[r * 4 + 1]!, s[r * 4 + 2]!, s[r * 4 + 3]!)) {
          stats.occluded++;
          return false;
        }
        return true;
      });
      if (item === null) continue;
      if (source.blended) (vm ? vmBlended : blended).push({ item, d: distance(item.firstInstance) });
      else (vm ? viewmodel : opaque).push(item);
    }
    // Opaque draws grouped by pipeline, then material, so state changes are few.
    const byState = (a: MeshItem, b: MeshItem): number => Number(a.skinned) - Number(b.skinned) || a.materialSlot - b.materialSlot;
    opaque.sort(byState);
    viewmodel.sort(byState);
    const farToNear = (list: { item: MeshItem; d: number }[]): MeshItem[] => list.sort((a, b) => b.d - a.d).map((b) => b.item);
    return { opaque, transparent: farToNear(blended), viewmodel, viewmodelTransparent: farToNear(vmBlended) };
  }

  /**
   * A shadow tile's casters: world-layer opaque instances inside the tile's light frustum, not
   * fading out, and (given the tile's `texels` per side) not smaller than the detail texels.
   * A local light's tiles pass `light`: an instance whose bounds hold the light and that is small
   * beside its reach (the lamp's own housing, the post it hangs on, a torch's bearer) casts no
   * shadow from it, or the fitting would black out everything the light is there to light.
   */
  forTile(vp: ArrayLike<number>, texels = 0, light?: { readonly position: readonly number[]; readonly range: number }): MeshItem[] {
    const planes = frustumPlanes(vp);
    const scale = texels > 0 && this.#detail > 0 ? pixelScale(vp, texels, texels) : 0;
    const out: MeshItem[] = [];
    for (const source of this.#sources) {
      if (!source.casts) continue;
      const item = this.#cull(source.item, (r) => {
        if (!(this.instances.data[r * MESH_INSTANCE_FLOATS + FADE_FLOAT]! > 0) || !this.#inside(planes, r)) return false;
        if (light !== undefined && this.#fixture(r, light)) return false;
        if (scale > 0 && this.#small(vp, scale, r)) {
          this.detailCulledCasters++;
          return false;
        }
        return true;
      });
      if (item !== null) out.push(item);
    }
    return out;
  }
}
