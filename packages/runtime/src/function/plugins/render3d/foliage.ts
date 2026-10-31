/**
 * Drawing the foliage service's scatter layers: per cell, frustum-culled against every
 * view, then per instance by distance to the nearest camera —
 *
 *   detail 0    the look's full mesh (built-in looks: one of `LOOK_VARIANTS` seeded
 *               variants, picked by the instance's index), swaying with the wind: the
 *               instance matrix leans its +y axis downwind by the local wind speed × the
 *               layer's `sway`, and leaves add a small flutter
 *   detail 1    the same variant with fewer rings, twigs and leaf sprays (bigger, so the
 *               crown keeps its coverage), from `DETAIL_FRACTION` of the near distance
 *   far         the renderer's impostor of the variant (foliage_meshes.ts): lit,
 *               shadow-receiving, fogged; model layers use their model's impostor
 *
 * Neighbouring levels cross-fade over `FADE_FRACTION` of their switch distance with the
 * renderer's dithered LOD fade (complementary pixels, so nothing doubles or pops), and the
 * far tier dithers out at the end of its reach. Plants stop at the near distance and bushes
 * and rocks at `KIND_FAR` (small things far away cost draws and show nothing). A layer's
 * `size` height scales the drawn look by size ÷ the look's nominal height.
 *
 * Tier distances come from the quality level, scaled by a frame-time governor: when frames
 * run long (wall time, `time.realNow`), foliage and grass draw distances shrink, down to
 * `MIN_SCALE`, and grow back when frames are fast again. Rendering only: nothing here
 * touches game state.
 */

import { hash2 } from '../../../core/index.js';
import type { BillboardBatch, ImpostorBatch3d, ImpostorSource3d, Mat4, MeshBatch, Quality3d, Rgba, View3d } from '../../../core/index.js';
import type { FoliageLayer, FoliageService, WindService } from '../../services/index.js';
import { foliageImpostor, foliageLook, LOOK_VARIANTS, NOMINAL_HEIGHT } from './foliage_meshes.js';
import type { FoliagePart } from './foliage_meshes.js';
import { impostorSource } from './impostor.js';
import { compose, multiply } from '../../../resource/index.js';
import type { ModelAsset } from '../../../resource/index.js';
import type { ModelPoseSource } from '../../services/index.js';
import { boxInPlanes, frustumPlanes } from './terrain_cdlod.js';
import type { Plane } from './terrain_cdlod.js';

/** Meters to the end of the near (mesh) and far (billboard) tiers, by quality. */
export const FOLIAGE_DISTANCE: Readonly<Record<Quality3d['level'], { readonly near: number; readonly far: number }>> = {
  low: { near: 50, far: 300 },
  medium: { near: 90, far: 600 },
  high: { near: 140, far: 1000 },
};
export const MIN_SCALE = 0.35;
/** Where detail 1 takes over from detail 0, as a fraction of the near distance. */
export const DETAIL_FRACTION = 0.4;
/** Cross-fade band at each switch, as a fraction of its distance. */
export const FADE_FRACTION = 0.12;
/** Farthest a kind is drawn (metres, before the governor), when less than the quality's far distance. */
export const KIND_FAR: Readonly<Record<string, number>> = { bush: 320, rock: 450 };

/** Shrinks foliage distances while frames run long. */
export class FrameGovernor {
  #scale = 1;
  #ms = 1000 / 60;
  #last: number | null = null;

  get scale(): number {
    return this.#scale;
  }

  /** Average frame milliseconds the governor sees. */
  get frameMs(): number {
    return this.#ms;
  }

  /** Feed the wall clock (seconds) once per frame; returns the distance scale. */
  frame(realNow: number): number {
    if (this.#last !== null) {
      const ms = (realNow - this.#last) * 1000;
      if (ms > 0 && ms < 250) this.#ms = this.#ms * 0.9 + ms * 0.1;
      if (this.#ms > 22) this.#scale = Math.max(MIN_SCALE, this.#scale * 0.97);
      else if (this.#ms < 15) this.#scale = Math.min(1, this.#scale * 1.01);
    }
    this.#last = realNow;
    return this.#scale;
  }
}

/**
 * An instance matrix: translate · lean · yaw · scale. The lean shears +y by (kx, kz): a
 * point at height h moves (kx·h, kz·h), so the base stays put and the top bends.
 */
export function swayMatrix(x: number, y: number, z: number, yawDegrees: number, s: number, kx: number, kz: number, out: Float32Array, o: number): void {
  const a = (yawDegrees * Math.PI) / 180;
  const c = Math.cos(a) * s;
  const n = Math.sin(a) * s;
  out[o] = c; out[o + 1] = 0; out[o + 2] = -n; out[o + 3] = 0;
  out[o + 4] = kx * s; out[o + 5] = s; out[o + 6] = kz * s; out[o + 7] = 0;
  out[o + 8] = n; out[o + 9] = 0; out[o + 10] = c; out[o + 11] = 0;
  out[o + 12] = x; out[o + 13] = y; out[o + 14] = z; out[o + 15] = 1;
}

/** Lean per meter of height for a wind speed (m/s) and sway, capped. */
export function leanOf(speed: number, sway: number): number {
  const k = (sway * speed) / 40;
  return k > 0.3 ? 0.3 : k;
}

interface ModelPart extends FoliagePart {
  /** Mesh node's rest transform in the model. */
  readonly node: Mat4;
}

class PartBatch {
  readonly numbers: number[] = [];
  readonly fades: number[] = [];
  #faded = false;
  count = 0;

  readonly part: FoliagePart | ModelPart;
  readonly shadows: boolean;

  constructor(part: FoliagePart | ModelPart, shadows: boolean) {
    this.part = part;
    this.shadows = shadows;
  }

  push(m: Float32Array, tint: Rgba, fade: number): void {
    for (let i = 0; i < 16; i++) this.numbers.push(m[i]!);
    this.numbers.push(tint[0], tint[1], tint[2], tint[3]);
    this.fades.push(fade);
    if (fade !== 1) this.#faded = true;
    this.count++;
  }

  close(): MeshBatch {
    return {
      geometry: this.part.geometry, material: this.part.material, count: this.count, instances: new Float32Array(this.numbers),
      entities: new Array<null>(this.count).fill(null), castShadows: this.shadows, ...(this.#faded && { fades: new Float32Array(this.fades) }),
    };
  }
}

class ImpostorList {
  readonly numbers: number[] = [];
  readonly source: ImpostorSource3d;

  constructor(source: ImpostorSource3d) {
    this.source = source;
  }

  push(x: number, y: number, z: number, s: number, yawDegrees: number, fade: number): void {
    this.numbers.push(x, y, z, s, (yawDegrees * Math.PI) / 180, fade, 0, 0);
  }

  close(): ImpostorBatch3d {
    const count = this.numbers.length / 8;
    return { source: this.source, count, instances: new Float32Array(this.numbers), entities: new Array<null>(count).fill(null) };
  }
}

/** A stable small number from a layer id (picks its instances' variants). */
function idSeed(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  return h | 0;
}

/**
 * The levels drawn at distance `d` and their LOD fades: [level, fade] pairs, levels 0 and 1
 * meshes, 2 the far tier. Bands: 0 until `d0`, 1 until `d1`, 2 until `end`, each switch
 * cross-faded over the band before it, and the far tier faded out over its last band.
 */
export function levelsAt(d: number, d0: number, d1: number, end: number, out: [number, number][]): void {
  out.length = 0;
  const band = (at: number): number => Math.max(1, at * FADE_FRACTION);
  const step = (hi: number, a: number, b: number): boolean => {
    if (!Number.isFinite(hi) || d < hi - band(hi) || d > hi) return false;
    const t = Math.min(0.999, Math.max(0.001, (d - (hi - band(hi))) / band(hi)));
    out.push([a, 1 - t], [b, -t]);
    return true;
  };
  if (d > end) return;
  if (d < d0) {
    if (!step(d0, 0, 1)) out.push([0, 1]);
    return;
  }
  if (d < d1) {
    if (!step(d1, 1, 2)) out.push([1, Number.isFinite(d1) || d < end - band(end) ? 1 : Math.max(0.001, (end - d) / band(end))]);
    return;
  }
  const b = band(end);
  out.push([2, d < end - b ? 1 : Math.max(0.001, (end - d) / b)]);
}

export interface FoliageFrameStats {
  readonly near: number;
  readonly mid: number;
  readonly far: number;
  readonly cells: number;
  readonly culledCells: number;
  readonly scale: number;
}

export class FoliageDraws {
  readonly governor = new FrameGovernor();
  /** A model file's mesh parts at rest, and its impostor, once per loaded asset. */
  readonly #modelParts = new WeakMap<ModelAsset, readonly ModelPart[]>();
  readonly #modelImpostors = new WeakMap<ModelAsset, ImpostorSource3d>();
  #stats: FoliageFrameStats = { near: 0, mid: 0, far: 0, cells: 0, culledCells: 0, scale: 1 };

  get stats(): FoliageFrameStats {
    return this.#stats;
  }

  #asset(layer: FoliageLayer, models: ModelPoseSource): ModelAsset | undefined {
    return models.get(models.resolve(layer.model!, `foliage layer "${layer.id}" model`));
  }

  #modelPartsOf(asset: ModelAsset): readonly ModelPart[] {
    const cached = this.#modelParts.get(asset);
    if (cached !== undefined) return cached;
    const world = new Map<number, Float32Array>();
    const parts: ModelPart[] = [];
    for (const index of asset.order) {
      const node = asset.nodes[index]!;
      const local = compose(...node.translation, ...node.rotation, ...node.scale);
      const m = node.parent >= 0 ? multiply(world.get(node.parent)!, local) : local;
      world.set(index, m);
      if (node.mesh === null) continue;
      for (const primitive of asset.meshes[node.mesh]!) parts.push({ geometry: primitive.geometry, material: primitive.material, leaves: false, node: m });
    }
    this.#modelParts.set(asset, parts);
    return parts;
  }

  draw(
    service: FoliageService, views: readonly View3d[], quality: Quality3d, wind: WindService | undefined, now: number, realNow: number, models: ModelPoseSource,
  ): { meshes: MeshBatch[]; billboards: BillboardBatch[]; impostors: ImpostorBatch3d[] } {
    const scale = this.governor.frame(realNow);
    const reach = FOLIAGE_DISTANCE[quality.level];
    const near = reach.near * scale;
    const frusta: Plane[][] = views.map((v) => frustumPlanes(v.viewProjection));
    const cameras = views.map((v) => v.position);
    const shadows = quality.level !== 'low';
    const meshes: MeshBatch[] = [];
    const impostors: ImpostorBatch3d[] = [];
    const m = new Float32Array(16);
    const leafM = new Float32Array(16);
    const placed = new Float32Array(16);
    const sample = new Float64Array(2);
    const levels: [number, number][] = [];
    let nearCount = 0;
    let midCount = 0;
    let farCount = 0;
    let cells = 0;
    let culled = 0;

    for (const layer of service.layers()) {
      const look = layer.model === null ? `${layer.kind}:${layer.species}` : null;
      const asset = layer.model === null ? undefined : this.#asset(layer, models);
      if (layer.model !== null && asset === undefined) continue;
      const modelParts = asset === undefined ? null : this.#modelPartsOf(asset);
      if (modelParts !== null && modelParts.length === 0) continue;
      const kindFar = KIND_FAR[layer.kind];
      const far = layer.kind === 'plant' ? near : Math.max(near, Math.min(reach.far, kindFar ?? reach.far) * scale);
      // Levels: 0/1 split for built-in looks; a model draws its own mesh at levels 0 and 1.
      const d0 = near * DETAIL_FRACTION;
      const sizeScale = look === null ? 1 : layer.height / NOMINAL_HEIGHT[look]!;
      const seed = idSeed(layer.id);
      const castShadows = shadows && layer.kind !== 'plant';
      const batches = new Map<number, PartBatch[]>();
      const batchesFor = (variant: number, level: number): PartBatch[] => {
        const key = variant * 2 + level;
        let list = batches.get(key);
        if (list === undefined) {
          const parts = modelParts ?? foliageLook(look!, layer.color, variant, level as 0 | 1);
          batches.set(key, (list = parts.map((p) => new PartBatch(p, castShadows))));
        }
        return list;
      };
      const far2 = new Map<number, ImpostorList>();
      const impostorFor = (variant: number): ImpostorList => {
        let list = far2.get(variant);
        if (list === undefined) {
          let source: ImpostorSource3d;
          if (asset !== undefined) {
            source = this.#modelImpostors.get(asset) ?? impostorSource(asset);
            this.#modelImpostors.set(asset, source);
          } else {
            source = foliageImpostor(look!, layer.color, variant);
          }
          far2.set(variant, (list = new ImpostorList(source)));
        }
        return list;
      };
      const top = layer.height * 1.4;
      for (const cell of layer.cells) {
        cells++;
        let d = Infinity;
        for (const c of cameras) {
          const dx = Math.max(cell.minX - c[0], 0, c[0] - cell.maxX);
          const dz = Math.max(cell.minZ - c[2], 0, c[2] - cell.maxZ);
          d = Math.min(d, Math.sqrt(dx * dx + dz * dz));
        }
        if (d > far || !frusta.some((f) => boxInPlanes(f, cell.minX - 3, cell.minY - 1, cell.minZ - 3, cell.maxX + 3, cell.maxY + top * 1.5, cell.maxZ + 3))) {
          culled++;
          continue;
        }
        for (let k = cell.start; k < cell.start + cell.count; k++) {
          if (layer.alive[k] === 0) continue;
          const x = layer.x[k]!;
          const y = layer.y[k]!;
          const z = layer.z[k]!;
          let dist = Infinity;
          for (const c of cameras) dist = Math.min(dist, Math.hypot(x - c[0], y - c[1], z - c[2]));
          levelsAt(dist, d0, layer.kind === 'plant' ? Infinity : near, far, levels);
          if (levels.length === 0) continue;
          const s = layer.scale[k]! * sizeScale;
          const variant = look === null ? 0 : Math.floor(hash2(k, 11, seed) * LOOK_VARIANTS);
          const shade = 0.88 + 0.2 * hash2(k, 7, 0x0f01);
          let swayed = false;
          for (const [level, fade] of levels) {
            if (level === 2) {
              impostorFor(variant).push(x, y, z, s, layer.yaw[k]!, fade);
              farCount++;
              continue;
            }
            if (!swayed) {
              swayed = true;
              let kx = 0;
              let kz = 0;
              let flutterX = 0;
              let flutterZ = 0;
              if (wind !== undefined && layer.sway > 0) {
                wind.sample(x, z, sample);
                const speed = Math.hypot(sample[0]!, sample[1]!);
                if (speed > 0) {
                  const phase = hash2(k, 3, 0x0f02) * 6.283;
                  // Gusts roll through: the lean breathes with a slow wave along the wind.
                  const wave = 0.8 + 0.2 * Math.sin(now * 0.9 - (x * sample[0]! + z * sample[1]!) / (speed * 6) + phase * 0.2);
                  const lean = (leanOf(speed, layer.sway) * wave) / Math.max(1, layer.height * s * 0.25);
                  kx = (sample[0]! / speed) * lean;
                  kz = (sample[1]! / speed) * lean;
                  const f = 0.012 * layer.sway * Math.min(1, speed / 6) * Math.sin(now * (2.2 + speed * 0.15) + phase);
                  flutterX = f * (sample[1]! / speed);
                  flutterZ = -f * (sample[0]! / speed);
                }
              }
              swayMatrix(x, y, z, layer.yaw[k]!, s, kx, kz, m, 0);
              swayMatrix(x, y, z, layer.yaw[k]!, s, kx + flutterX, kz + flutterZ, leafM, 0);
            }
            const tint: Rgba = [shade, shade, shade, 1];
            for (const b of batchesFor(variant, modelParts === null ? level : 0)) {
              const base = b.part.leaves ? leafM : m;
              const node = 'node' in b.part ? b.part.node : null;
              b.push(node === null ? base : multiply(base, node, placed), tint, fade);
            }
            if (level === 0) nearCount++;
            else midCount++;
          }
        }
      }
      for (const list of batches.values()) for (const b of list) if (b.count > 0) meshes.push(b.close());
      for (const list of far2.values()) impostors.push(list.close());
    }
    this.#stats = { near: nearCount, mid: midCount, far: farCount, cells, culledCells: culled, scale };
    return { meshes, billboards: [], impostors };
  }
}
