/**
 * Grass: blade patches in a window around the cameras, the way GPU grass is drawn —
 * hundreds of thousands of blades for the cost of a few instanced draws. The blade look is
 * ported from the platform engine's grass (grass_config / grass_shape):
 *
 *   clumps       blades grow in tufts on a jittered ~0.55 m lattice; a tuft shares a
 *                height, a tint and a lean, its blades fan out from its center and their
 *                normals bend away from it, so a field reads as tufts, not a carpet
 *   blades       curved and tapered: `SEGMENTS` rows narrowing to a single tip vertex,
 *                bent along their facing; both faces emitted with the same normal (a
 *                double-sided material would flip it on the back face and darken half the
 *                field), normals mostly up so grass is lit like the ground it grows from
 *   shading      vertex colors: dark, cool roots → light yellow-green tips (the platform
 *                engine's grass ramp, `bladeRamp`), per-tuft and per-blade tint, a few dry blades
 *
 * The ground is a fixed world grid of PATCH-meter cells; each cell within the window (the
 * layer's `radius`, scaled by quality and the frame-time governor) that the layer's density
 * reaches gets one patch instance: a patch geometry chosen by how many blades the density
 * asks for (one of `VARIANTS`, in `PATTERNS` layouts), turned by a hashed yaw, tilted to the
 * terrain's slope and leaned by the wind (a shear of +y; a gust wave rolls along the wind,
 * so neighbours sway out of step). Inside `NEAR_FRACTION` of the window blades are full
 * curved blades, boosted by NEAR_BOOST; beyond it, half as many wider single-triangle blades
 * (the far tier, which reads the same at that distance). Over the window's last `EDGE_FRACTION` patches dither
 * out (the renderer's LOD fade) and shrink, so the edge never shows as a line. A broad noise
 * tints patches lush or dry. Layer edges are ragged, not ruled: the foliage service's soft
 * grass density thins over a noisy band, patches there get fewer, shorter blades, centers
 * are jittered off the grid, and a few straggler tufts grow past the edge. Exclusion is the
 * density: off-layer, avoided layers, holes, water and the layer's own `exclude` footprints
 * give 0 (the foliage service's `densityAt`).
 *
 * Per-cell data (height, slope, density, variant) is cached and dropped when the terrain
 * or foliage revision changes; only the lean and fade are recomputed each frame.
 *
 * Brush volumes (terrain `brush`) are drawn the same way, densely and as tall as the
 * volume, wherever the cameras are within BRUSH_DISTANCE.
 */

import { hash2, valueNoise2 } from '../../../core/index.js';
import type { Geometry3d, Material3d, MeshBatch, Quality3d, Rgb, View3d } from '../../../core/index.js';
import type { BrushVolume, GrassLayer, TerrainField, WindService } from '../../services/index.js';
import { leanOf } from './foliage.js';
import { clamp, MeshBuilder, normalize } from './foliage_gen.js';
import type { Vec3 } from './foliage_gen.js';
import { frustumPlanes } from './terrain_cdlod.js';
import type { Plane } from './terrain_cdlod.js';

/** Meters per side of one patch. */
export const PATCH = 2;
/** How far (in patches) a patch center is jittered off its grid cell. */
export const PATCH_JITTER = 0.5;
/** Blade counts of the near patch geometries (the far tier draws half as many). */
export const VARIANTS = [16, 32, 64, 128, 192, 256] as const;
/**
 * Near-tier blade boost: inside NEAR_FRACTION a patch draws the variant for this many times
 * the layer's density (capped at the largest), the full grass bed the platform engine drew
 * up close (its near ring was ~80 blades/m² whatever the authored density).
 */
export const NEAR_BOOST = 1.6;
/** Distinct blade layouts per count, picked per cell, so the grid never repeats visibly. */
export const PATTERNS = 4;
/** Rows of a near blade (a far blade is one triangle). */
export const SEGMENTS = 4;
/** Fraction of the window drawn with full near blades. */
export const NEAR_FRACTION = 0.4;
/** Fraction of the window, at its edge, over which patches dither out. */
export const EDGE_FRACTION = 0.3;
/** Least window scale the frame-time governor may leave the grass (see draw). */
export const GRASS_MIN_SCALE = 0.8;
/**
 * Window scale by quality. `high` reaches past the authored radius, to the platform
 * engine's high-tier grass reach (~64 m for the usual 45 m radius; its medium tier reached
 * 24 m and low drew none).
 */
export const GRASS_REACH: Readonly<Record<Quality3d['level'], number>> = { low: 0.5, medium: 0.8, high: 1.4 };
/** Brush volumes are drawn while a camera is this close. */
export const BRUSH_DISTANCE = 120;
const BRUSH_COLOR: Rgb = [0.22, 0.36, 0.14];
/** Cached cells per layer before the cache starts over. */
const MAX_CACHED = 40_000;

/** Tuft pitch and reach (meters), from the platform engine's grass clumping. */
const CLUMP_PITCH = 0.55;
const CLUMP_RADIUS = 0.34;

const patches = new Map<string, Geometry3d>();

/**
 * A patch of `blades` blades over PATCH × PATCH meters, heights normalized to ≤ 1 (the
 * instance scales y to the blade height), in layout `pattern`; `far` builds the far tier.
 */
export function patchGeometry(blades: number, pattern = 0, far = false, color: Rgb = DEFAULT_GRASS): Geometry3d {
  const key = `${blades}:${pattern}:${far ? 1 : 0}:${color.join(',')}`;
  const ramp = bladeRamp(color);
  let g = patches.get(key);
  if (g !== undefined) return g;
  const seed = 0x6a55 + pattern * 101;
  const m = new MeshBuilder();
  // Tufts on a jittered lattice over the patch.
  const per = Math.round(PATCH / CLUMP_PITCH);
  const clumps: { x: number; z: number; h: number; tint: number; yaw: number }[] = [];
  for (let j = 0; j < per; j++) {
    for (let i = 0; i < per; i++) {
      const c = j * per + i;
      clumps.push({
        x: -PATCH / 2 + (i + 0.5 + (hash2(c, 0, seed) - 0.5) * 0.85) * (PATCH / per),
        z: -PATCH / 2 + (j + 0.5 + (hash2(c, 1, seed) - 0.5) * 0.85) * (PATCH / per),
        h: 0.55 + 0.45 * hash2(c, 2, seed), tint: 0.85 + 0.3 * hash2(c, 3, seed), yaw: hash2(c, 4, seed) * Math.PI * 2,
      });
    }
  }
  const segments = far ? 1 : SEGMENTS;
  for (let b = 0; b < blades; b++) {
    const r = (k: number): number => hash2(b, k, seed);
    const clump = clumps[Math.floor(r(0) * clumps.length)]!;
    const ra = Math.sqrt(r(1)) * CLUMP_RADIUS;
    const ta = r(2) * Math.PI * 2;
    const x = clamp(clump.x + Math.cos(ta) * ra, -PATCH / 2, PATCH / 2);
    const z = clamp(clump.z + Math.sin(ta) * ra, -PATCH / 2, PATCH / 2);
    const out = normalize([x - clump.x, 0, z - clump.z], [Math.cos(clump.yaw), 0, Math.sin(clump.yaw)]);
    // Facing: mostly toward the tuft's outside, with spread; the blade bends that way.
    const yaw = Math.atan2(out[2], out[0]) + (r(3) - 0.5) * 1.4;
    const face: Vec3 = [Math.cos(yaw), 0, Math.sin(yaw)];
    const across: Vec3 = [-face[2], 0, face[0]];
    const h = Math.min(1, clump.h * (0.75 + 0.5 * r(4)));
    const width = (0.016 + 0.016 * r(5)) * (far ? 2.4 : 1);
    const bend = (0.05 + 0.25 * r(6)) * h;
    const dry = r(7) < 0.07;
    const tint = clump.tint * (0.9 + 0.2 * r(8));
    // Normal: up, tipped away from the tuft's center and a little toward the blade's face.
    const n = normalize([out[0] * 0.35 + face[0] * 0.15, 0.85, out[2] * 0.35 + face[2] * 0.15]);
    // The blade's own linear color (the material is white): dark root → light yellow-green
    // tip (bladeRamp), dry blades straw-tipped, times the tuft's and blade's tint.
    const color = (t: number): number[] => {
      const u = Math.pow(t, 0.7);
      const tip = dry ? ramp.dry : ramp.tip;
      const k = tint * (0.8 + 0.2 * t);
      return [0, 1, 2].map((i) => Math.min(1, k * (ramp.root[i]! + (tip[i]! - ramp.root[i]!) * u)));
    };
    const at = (t: number, side: number): number[] => {
      const w = width * (1 - Math.pow(t, 0.9) * 0.85) * side;
      const reach = bend * t * t;
      return [x + face[0] * reach + across[0] * w, h * t * (1 - 0.15 * t * bend), z + face[2] * reach + across[2] * w];
    };
    // Both faces, same normal; rows 0..segments-1 are pairs, the tip one vertex.
    for (const facing of [1, -1]) {
      const first = m.vertexCount;
      for (let s = 0; s < segments; s++) {
        const t = s / segments;
        m.vertex(at(t, -1), n, 0, 1 - t, color(t));
        m.vertex(at(t, 1), n, 1, 1 - t, color(t));
      }
      const tip = m.vertex(at(1, 0), n, 0.5, 0, color(1));
      const emit = (a: number, c: number, d: number): void => (facing > 0 ? m.rawTriangle(a, c, d) : m.rawTriangle(a, d, c));
      for (let s = 0; s < segments - 1; s++) {
        const a = first + s * 2;
        emit(a, a + 1, a + 3);
        emit(a, a + 3, a + 2);
      }
      const last = first + (segments - 1) * 2;
      emit(last, last + 1, tip);
    }
  }
  const built = m.build(`grass:patch:${key}`);
  g = { ...built, min: [-PATCH / 2 - 0.3, 0, -PATCH / 2 - 0.3], max: [PATCH / 2 + 0.3, 1, PATCH / 2 + 0.3] };
  patches.set(key, g);
  return g;
}

/** sRGB → linear. */
const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** The default blade color (the foliage plugin's grass LOOKS color). */
const DEFAULT_GRASS: Rgb = [0.33, 0.52, 0.2];
/** Old-engine grass tip (grass_config GRASS_SHADING.tipColor, linear): light, warm yellow-green. */
const TIP_LINEAR = [0.42, 0.62, 0.24];
const DRY_LINEAR = [0.62, 0.55, 0.26];

/**
 * A layer's blade gradient, linear: the root is the layer color darkened and cooled (the
 * platform engine's root sat at ~0.7× the base, less saturated), the tip the layer color
 * lifted halfway to that engine's yellow-green tip, so the default grass matches it and a
 * custom color keeps its hue.
 */
export function bladeRamp(color: Rgb): { root: number[]; tip: number[]; dry: number[] } {
  const c = color.map(toLinear);
  return {
    root: [c[0]! * 0.85, c[1]! * 0.72, c[2]! * 1.0],
    tip: [0, 1, 2].map((i) => Math.min(1, c[i]! * 2.2 * 0.5 + TIP_LINEAR[i]! * 0.5)),
    dry: [0, 1, 2].map((i) => Math.min(1, c[i]! * 1.4 * 0.35 + DRY_LINEAR[i]! * 0.65)),
  };
}

function grassMaterial(color: Rgb): Material3d {
  // White: the blade's color is in its vertex colors (patchGeometry, bladeRamp).
  return {
    id: `grass:${color.join(',')}`, baseColor: [1, 1, 1, 1], baseColorTexture: null, metallic: 0, roughness: 0.82,
    metallicRoughnessTexture: null, emissive: [0, 0, 0], emissiveTexture: null, alphaMode: 'opaque', alphaCutoff: 0.5, doubleSided: false, unlit: false,
    // Per-blade sway in the vertex shader (foliage_wind_shaders.ts); patch y is 0..1.
    wind: { amount: 0.35, height: 1 },
    // Light through thin blades from behind (the subsurface layer's wrap term).
    layers: {
      clearcoat: 0, clearcoatRoughness: 0, transmission: 0, subsurface: 0.18,
      subsurfaceColor: [Math.min(1, color[0] * 1.5 + 0.1), Math.min(1, color[1] * 1.4 + 0.12), Math.min(1, color[2] * 1.1)], anisotropy: 0, anisotropyRotation: 0,
    },
  };
}

/** The blade-count variant for `wanted` blades in a patch, or -1 for none. */
export function variantFor(wanted: number): number {
  if (wanted < VARIANTS[0] / 2) return -1;
  let best = 0;
  for (let i = 1; i < VARIANTS.length; i++) if (Math.abs(VARIANTS[i]! - wanted) < Math.abs(VARIANTS[best]! - wanted)) best = i;
  return best;
}

interface Cell {
  readonly x: number;
  readonly z: number;
  readonly y: number;
  /** Ground slope as dy/dx, dy/dz. */
  readonly sx: number;
  readonly sz: number;
  readonly variant: number;
  readonly pattern: number;
  readonly yaw: number;
  readonly height: number;
  /** Lush (0) … dry (1). */
  readonly dry: number;
}

/** A patch instance: translate · lean · slope · yaw · scale(1, h, 1). */
export function patchMatrix(c: Pick<Cell, 'x' | 'y' | 'z' | 'sx' | 'sz' | 'yaw'>, kx: number, kz: number, h: number, out: number[]): void {
  const a = c.yaw;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  // Columns of yaw·scale: x axis, y axis (height h), z axis.
  const cols = [[ca, 0, -sa], [0, h, 0], [sa, 0, ca]];
  for (const col of cols) {
    col[1] = col[1]! + c.sx * col[0]! + c.sz * col[2]!;
    col[0] = col[0]! + kx * col[1]!;
    col[2] = col[2]! + kz * col[1]!;
  }
  out.push(cols[0]![0]!, cols[0]![1]!, cols[0]![2]!, 0, cols[1]![0]!, cols[1]![1]!, cols[1]![2]!, 0, cols[2]![0]!, cols[2]![1]!, cols[2]![2]!, 0, c.x, c.y, c.z, 1);
}

function sphereVisible(planes: readonly Plane[], x: number, y: number, z: number, r: number): boolean {
  for (const p of planes) if (p.nx * x + p.ny * y + p.nz * z + p.d < -r) return false;
  return true;
}

export interface GrassFrameStats {
  readonly patches: number;
  readonly blades: number;
  readonly brushPatches: number;
}

class Bucket {
  readonly numbers: number[] = [];
  readonly fades: number[] = [];
  faded = false;
}

export class GrassDraws {
  readonly #cells = new Map<string, Map<number, Cell | null>>();
  #key = '';
  #brush: { readonly key: string; readonly cells: readonly (Cell & { readonly volume: BrushVolume })[] } | null = null;
  #stats: GrassFrameStats = { patches: 0, blades: 0, brushPatches: 0 };

  get stats(): GrassFrameStats {
    return this.#stats;
  }

  #cell(layer: GrassLayer, field: TerrainField | null, ix: number, iz: number): Cell | null {
    let cache = this.#cells.get(layer.id);
    if (cache === undefined) this.#cells.set(layer.id, (cache = new Map()));
    const key = ix * 100003 + iz;
    let cell = cache.get(key);
    if (cell !== undefined) return cell;
    // The window moves with the camera: forget far-behind cells rather than keep every one ever seen.
    if (cache.size > MAX_CACHED) cache.clear();
    // Patch centers are jittered off the grid, so where density changes the edge is ragged.
    const x = (ix + 0.5 + (hash2(ix, iz, 0x6a60) - 0.5) * PATCH_JITTER) * PATCH;
    const z = (iz + 0.5 + (hash2(ix, iz, 0x6a61) - 0.5) * PATCH_JITTER) * PATCH;
    const d = layer.densityAt(x, z);
    let variant = variantFor(layer.density * PATCH * PATCH * d);
    // Stragglers: past the edge, where the (soft) density is low but not zero, a few sparse tufts.
    const straggler = variant < 0 && d > 0.003 && hash2(ix, iz, 0x6a62) < Math.min(0.35, d * 10);
    if (straggler) variant = 0;
    if (variant < 0 || (field !== null && !field.contains(x, z))) {
      cell = null;
    } else {
      const y = field === null ? 0 : field.heightAt(x, z);
      const n = field === null ? null : field.normalAt(x, z);
      const [lo, hi] = layer.bladeHeight;
      // Broad lush/dry patches (two octaves of value noise, ~20 m and ~7 m).
      const dry = clamp((valueNoise2(x / 21, z / 21, 0x6a5b) * 0.7 + valueNoise2(x / 7, z / 7, 0x6a5c) * 0.3 - 0.45) * 2.2, 0, 1);
      cell = {
        x, z, y, sx: n === null ? 0 : -n.x / n.y, sz: n === null ? 0 : -n.z / n.y, variant, pattern: Math.floor(hash2(ix, iz, 0x6a5d) * PATTERNS),
        // Thinning grass is shorter too: edges slope down instead of stopping at full height.
        yaw: hash2(ix, iz, 0x6a56) * Math.PI * 2, height: (lo + (hi - lo) * hash2(ix, iz, 0x6a57)) * (1 - 0.25 * dry) * (0.45 + 0.55 * Math.sqrt(Math.min(1, d))) * (straggler ? 0.8 : 1), dry,
      };
    }
    cache.set(key, cell);
    return cell;
  }

  draw(
    layers: readonly GrassLayer[], foliageRevision: number, field: TerrainField | null, views: readonly View3d[], quality: Quality3d,
    wind: WindService | undefined, scale: number, now = 0,
  ): MeshBatch[] {
    const key = `${field?.scene ?? ''}:${field?.version ?? 0}:${field?.revision ?? 0}:${foliageRevision}`;
    if (key !== this.#key) {
      this.#cells.clear();
      this.#key = key;
    }
    const frusta = views.map((v) => frustumPlanes(v.viewProjection));
    const sample = new Float64Array(2);
    const out: MeshBatch[] = [];
    let patchCount = 0;
    let blades = 0;
    const lean = (c: Cell, sway: number): [number, number] => {
      if (wind === undefined || sway <= 0) return [0, 0];
      wind.sample(c.x, c.z, sample);
      const speed = Math.hypot(sample[0]!, sample[1]!);
      if (speed === 0) return [0, 0];
      // A gust wave rolling downwind (platform grass: gust base 0.78, amplitude 0.22, wave 0.15/m).
      const along = (c.x * sample[0]! + c.z * sample[1]!) / speed;
      const gust = 0.72 + 0.28 * Math.sin(now * 1.6 - along * 0.15 + hash2(Math.round(c.x), Math.round(c.z), 0x6a5e) * 0.8);
      const k = leanOf(speed, sway) * 1.6 * gust;
      return [(sample[0]! / speed) * k, (sample[1]! / speed) * k];
    };
    for (const layer of layers) {
      // The frame-time governor may shrink the window, but never below GRASS_MIN_SCALE of it:
      // a window a few meters wide puts the grass behind a chase camera and the ground looks bare.
      const radius = layer.radius * GRASS_REACH[quality.level] * Math.max(GRASS_MIN_SCALE, scale);
      const nearR = radius * NEAR_FRACTION;
      const edge = radius * (1 - EDGE_FRACTION);
      // Buckets by tier, variant and pattern.
      const buckets = new Map<number, Bucket>();
      const seen = new Set<number>();
      for (const view of views) {
        const [cx, , cz] = view.position;
        const i0 = Math.floor((cx - radius) / PATCH);
        const i1 = Math.floor((cx + radius) / PATCH);
        const k0 = Math.floor((cz - radius) / PATCH);
        const k1 = Math.floor((cz + radius) / PATCH);
        for (let iz = k0; iz <= k1; iz++) {
          for (let ix = i0; ix <= i1; ix++) {
            const id = ix * 100003 + iz;
            if (seen.has(id)) continue;
            const px = (ix + 0.5) * PATCH;
            const pz = (iz + 0.5) * PATCH;
            const d = Math.hypot(px - cx, pz - cz);
            if (d > radius) continue;
            const cell = this.#cell(layer, field, ix, iz);
            if (cell === null) continue;
            if (!frusta.some((f) => sphereVisible(f, cell.x, cell.y + cell.height / 2, cell.z, PATCH + cell.height))) continue;
            seen.add(id);
            const fade = d <= edge ? 1 : Math.max(0.001, 1 - (d - edge) / (radius - edge));
            const far = d > nearR;
            const variant = far ? cell.variant : Math.min(VARIANTS.length - 1, variantFor(VARIANTS[cell.variant]! * NEAR_BOOST));
            const bucketKey = (far ? 1000 : 0) + variant * PATTERNS + cell.pattern;
            let bucket = buckets.get(bucketKey);
            if (bucket === undefined) buckets.set(bucketKey, (bucket = new Bucket()));
            const [kx, kz] = lean(cell, layer.sway);
            patchMatrix(cell, kx, kz, cell.height * (0.6 + 0.4 * fade), bucket.numbers);
            const shade = 0.84 + 0.16 * hash2(ix, iz, 0x6a58);
            bucket.numbers.push(shade * (1 + 0.12 * cell.dry), shade * (1 + 0.02 * cell.dry), shade * (1 - 0.22 * cell.dry), 1);
            bucket.fades.push(fade);
            if (fade < 1) bucket.faded = true;
            patchCount++;
            blades += far ? VARIANTS[variant]! / 2 : VARIANTS[variant]!;
          }
        }
      }
      const material = grassMaterial(layer.color);
      for (const [bucketKey, bucket] of buckets) {
        const far = bucketKey >= 1000;
        const rest = bucketKey % 1000;
        const variant = Math.floor(rest / PATTERNS);
        const count = bucket.numbers.length / 20;
        out.push({
          geometry: patchGeometry(far ? Math.max(8, VARIANTS[variant]! / 2) : VARIANTS[variant]!, rest % PATTERNS, far, layer.color), material, count,
          instances: new Float32Array(bucket.numbers), entities: new Array<null>(count).fill(null), castShadows: false,
          ...(bucket.faded && { fades: new Float32Array(bucket.fades) }),
        });
      }
    }
    const brushPatches = field === null ? 0 : this.#drawBrush(field, views, frusta, lean, out);
    this.#stats = { patches: patchCount, blades, brushPatches };
    return out;
  }

  #drawBrush(field: TerrainField, views: readonly View3d[], frusta: readonly Plane[][], lean: (c: Cell, sway: number) => [number, number], out: MeshBatch[]): number {
    if (field.brush.length === 0) return 0;
    const key = `${field.scene}:${field.version}:${field.revision}`;
    if (this.#brush?.key !== key) {
      const cells: (Cell & { readonly volume: BrushVolume })[] = [];
      const step = PATCH / 2;
      for (const volume of field.brush) {
        for (let z = Math.floor(volume.minZ / step) * step + step / 2; z <= volume.maxZ; z += step) {
          for (let x = Math.floor(volume.minX / step) * step + step / 2; x <= volume.maxX; x += step) {
            if (!volume.contains(x, z) || !field.contains(x, z)) continue;
            const n = field.normalAt(x, z);
            const ix = Math.round(x / step);
            const iz = Math.round(z / step);
            cells.push({
              x, z, y: field.heightAt(x, z), sx: -n.x / n.y, sz: -n.z / n.y, variant: VARIANTS.length - 2, pattern: Math.floor(hash2(ix, iz, 0x6a5d) * PATTERNS),
              yaw: hash2(ix, iz, 0x6a59) * Math.PI * 2, height: volume.height * (0.85 + 0.25 * hash2(ix, iz, 0x6a5a)), dry: 0, volume,
            });
          }
        }
      }
      this.#brush = { key, cells };
    }
    const lists = new Map<number, number[]>();
    let total = 0;
    for (const cell of this.#brush.cells) {
      if (!views.some((v) => Math.hypot(v.position[0] - cell.x, v.position[2] - cell.z) < BRUSH_DISTANCE)) continue;
      if (!frusta.some((f) => sphereVisible(f, cell.x, cell.y + cell.height / 2, cell.z, PATCH + cell.height))) continue;
      let list = lists.get(cell.pattern);
      if (list === undefined) lists.set(cell.pattern, (list = []));
      const [kx, kz] = lean(cell, 0.6);
      patchMatrix(cell, kx, kz, cell.height, list);
      list.push(1, 1, 1, 1);
      total++;
    }
    for (const [pattern, list] of lists) {
      const count = list.length / 20;
      out.push({
        geometry: patchGeometry(VARIANTS[VARIANTS.length - 2]!, pattern, false, BRUSH_COLOR), material: grassMaterial(BRUSH_COLOR), count, instances: new Float32Array(list),
        entities: new Array<null>(count).fill(null), castShadows: false,
      });
    }
    return total;
  }
}
