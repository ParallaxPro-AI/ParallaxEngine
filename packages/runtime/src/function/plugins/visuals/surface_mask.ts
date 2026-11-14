/**
 * Surface masks (the `surface_mask` component, render_schemas.ts): paintable layers — dirt,
 * rust, moss, soot, foam, paint — lying on an entity's surface, that game code erases and
 * paints at world points (a brush, a scraper, a spray can) and reads back as coverage (a
 * "93% clean" meter).
 *
 * The layers live in a volume of cubic cells around the entity, in its own space, so a
 * mask needs no texture coordinates and works on any model or shape: a brush is a sphere,
 * and it cleans whatever surface passes through it. Each cell holds one amount 0..1 per
 * layer (at most four). The cells the surface passes through are found from the Model's
 * triangles (the model geometry service), or from the Shape or collider box when there is
 * no model geometry in this run; coverage averages over those cells only.
 *
 * The amounts are run-time state outside the component's fields — a scene load or a
 * respawn starts the mask afresh from its layers' starting coverage. Renderers read the
 * cells as an RGBA8 atlas of slices (`texels()`, render3d's surface_mask.ts).
 */

import { bindArgs, fail, Quat, Vec3 } from '../../../core/index.js';
import { componentEntity } from '../../kernel/index.js';
import type { EntityRecord, Fields, Kernel } from '../../kernel/index.js';
import { modelScaleOf } from '../../../resource/index.js';
import { MODEL_GEOMETRY_SERVICE } from '../../services/index.js';
import type { ModelGeometry } from '../../services/index.js';
import { COLLIDER, MODEL, SHAPE } from './schemas.js';

/** Most layers a mask holds (one per texel channel; core MAX_PAINT_LAYERS). */
export const MASK_LAYERS = 4;
/** Most cells along any side of a mask's volume. */
export const MAX_MASK_RESOLUTION = 256;

/** One layer as the component declares it. */
export interface MaskLayerSpec {
  readonly name: string;
  readonly coverage: number;
  readonly pattern: number;
  readonly below: number;
  readonly up: number;
}

/** A mask's cells. Amounts are kept as floats; `texels()` packs them for drawing. */
export class MaskState {
  /** Cells along x, y, z. */
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  /** Meters per cell (entity space), and the volume's low corner. */
  readonly cell: number;
  readonly min: readonly [number, number, number];
  /** Slices per atlas row, and the atlas size in texels. */
  readonly tiles: number;
  readonly width: number;
  readonly height: number;
  readonly layers: readonly MaskLayerSpec[];
  /** Amounts: `cells × MASK_LAYERS`, layer-minor. */
  readonly amounts: Float32Array;
  /** Indices of the cells the surface passes through. */
  readonly surface: Uint32Array;
  /** Grows with every change (renderers upload again when it moves). */
  version = 1;
  readonly #seed: number;
  readonly #normals: Float32Array;
  #packed: Uint8Array | null = null;
  #packedVersion = 0;
  #dirtyLow = 0;
  #dirtyHigh = -1;
  #coverage = new Map<string, { version: number; value: number }>();

  constructor(box: { min: Vec3; size: Vec3 }, resolution: number, layers: readonly MaskLayerSpec[], seed: number,
    occupied: (state: MaskState, mark: (x: number, y: number, z: number, nx: number, ny: number, nz: number) => void) => void,
    inside = true) {
    const longest = Math.max(box.size.x, box.size.y, box.size.z, 1e-3);
    const cell = longest / resolution;
    // One cell of margin all round, so a surface on the box's face still has cells on both sides.
    this.cell = cell;
    this.nx = Math.max(1, Math.ceil(box.size.x / cell)) + 2;
    this.ny = Math.max(1, Math.ceil(box.size.y / cell)) + 2;
    this.nz = Math.max(1, Math.ceil(box.size.z / cell)) + 2;
    this.min = [box.min.x - cell, box.min.y - cell, box.min.z - cell];
    this.tiles = Math.max(1, Math.min(this.nz, Math.floor(4096 / this.nx), Math.ceil(Math.sqrt((this.nz * this.ny) / this.nx))));
    this.width = this.tiles * this.nx;
    this.height = Math.ceil(this.nz / this.tiles) * this.ny;
    if (this.height > 4096) {
      fail('PP3800', `A surface_mask volume of ${this.nx}×${this.ny}×${this.nz} cells is too large to draw`, { fix: 'Lower its resolution.' });
    }
    this.layers = layers;
    this.#seed = seed;
    const cells = this.nx * this.ny * this.nz;
    this.amounts = new Float32Array(cells * MASK_LAYERS);
    const flags = new Uint8Array(cells);
    const normals = new Float32Array(cells * 3);
    occupied(this, (x, y, z, ax, ay, az) => {
      if (x < 0 || y < 0 || z < 0 || x >= this.nx || y >= this.ny || z >= this.nz) return;
      const i = this.index(x, y, z);
      flags[i] = 1;
      normals[i * 3] = normals[i * 3]! + ax; normals[i * 3 + 1] = normals[i * 3 + 1]! + ay; normals[i * 3 + 2] = normals[i * 3 + 2]! + az;
    });
    const open = inside ? null : this.#outside(flags);
    const list: number[] = [];
    for (let i = 0; i < cells; i++) if (flags[i] === 1 && (open === null || this.#touchesOutside(i, open))) list.push(i);
    this.surface = Uint32Array.from(list);
    this.#normals = normals;
    this.reset(null);
  }

  /** The empty cells connected to the volume's border (the air around the entity, not sealed inside it). */
  #outside(flags: Uint8Array): Uint8Array {
    const open = new Uint8Array(flags.length);
    const queue: number[] = [];
    const visit = (x: number, y: number, z: number): void => {
      if (x < 0 || y < 0 || z < 0 || x >= this.nx || y >= this.ny || z >= this.nz) return;
      const i = this.index(x, y, z);
      if (open[i] === 1 || flags[i] === 1) return;
      open[i] = 1;
      queue.push(i);
    };
    for (let z = 0; z < this.nz; z++) {
      for (let y = 0; y < this.ny; y++) {
        for (let x = 0; x < this.nx; x++) {
          if (x === 0 || y === 0 || z === 0 || x === this.nx - 1 || y === this.ny - 1 || z === this.nz - 1) visit(x, y, z);
        }
      }
    }
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head]!;
      const x = i % this.nx;
      const y = Math.floor(i / this.nx) % this.ny;
      const z = Math.floor(i / (this.nx * this.ny));
      visit(x - 1, y, z); visit(x + 1, y, z); visit(x, y - 1, z); visit(x, y + 1, z); visit(x, y, z - 1); visit(x, y, z + 1);
    }
    return open;
  }

  /** Whether a surface cell faces the outside air (one of its six neighbours is). */
  #touchesOutside(i: number, open: Uint8Array): boolean {
    const x = i % this.nx;
    const y = Math.floor(i / this.nx) % this.ny;
    const z = Math.floor(i / (this.nx * this.ny));
    const at = (dx: number, dy: number, dz: number): boolean => {
      const ax = x + dx; const ay = y + dy; const az = z + dz;
      if (ax < 0 || ay < 0 || az < 0 || ax >= this.nx || ay >= this.ny || az >= this.nz) return true;
      return open[this.index(ax, ay, az)] === 1;
    };
    return at(-1, 0, 0) || at(1, 0, 0) || at(0, -1, 0) || at(0, 1, 0) || at(0, 0, -1) || at(0, 0, 1);
  }

  index(x: number, y: number, z: number): number {
    return (z * this.ny + y) * this.nx + x;
  }

  /** The index of a layer by name or position; null: every layer. */
  layer(which: unknown, where: string): number | null {
    if (which === null || which === undefined) return null;
    if (typeof which === 'number' && Number.isInteger(which) && which >= 0 && which < this.layers.length) return which;
    if (typeof which === 'string') {
      const at = this.layers.findIndex((l) => l.name === which);
      if (at >= 0) return at;
    }
    return fail('PP3800', `${where}: the surface_mask has no layer ${JSON.stringify(which)}`, {
      fix: `Its layers are ${this.layers.map((l) => `"${l.name}"`).join(', ') || 'none'}.`,
    });
  }

  /** Each layer back to its starting coverage (`layer` null: every layer). */
  reset(layer: number | null): void {
    const normals: Float32Array | null = this.#normals;
    const sy = (this.ny - 2) * this.cell;
    for (let z = 0; z < this.nz; z++) {
      for (let y = 0; y < this.ny; y++) {
        for (let x = 0; x < this.nx; x++) {
          const i = this.index(x, y, z);
          const px = this.min[0] + (x + 0.5) * this.cell;
          const py = this.min[1] + (y + 0.5) * this.cell;
          const pz = this.min[2] + (z + 0.5) * this.cell;
          let up = 0;
          if (normals !== null) {
            const l = Math.hypot(normals[i * 3]!, normals[i * 3 + 1]!, normals[i * 3 + 2]!);
            up = l > 0 ? normals[i * 3 + 1]! / l : 0;
          }
          const height = sy > 0 ? Math.min(1, Math.max(0, (py - this.min[1] - this.cell) / sy)) : 0.5;
          this.layers.forEach((spec, k) => {
            if (layer !== null && k !== layer) return;
            this.amounts[i * MASK_LAYERS + k] = startAmount(spec, px, py, pz, height, up, this.#seed + k * 101);
          });
        }
      }
    }
    this.#touch(0, this.nz - 1);
  }

  /** Set a layer (null: every layer) to one amount everywhere. */
  fill(layer: number | null, amount: number): void {
    const cells = this.nx * this.ny * this.nz;
    for (let i = 0; i < cells; i++) {
      for (let k = 0; k < this.layers.length; k++) if (layer === null || k === layer) this.amounts[i * MASK_LAYERS + k] = amount;
    }
    this.#touch(0, this.nz - 1);
  }

  /**
   * Change the amounts inside a sphere (entity space): `delta` per unit of brush weight
   * (negative erases), full inside `radius × hardness`, fading to 0 at `radius`. With
   * `exposed`, an erase reaches a layer only where the layers above it are gone. Returns the
   * share of the whole surface that changed (summed over the layers touched).
   */
  brush(center: Vec3, radius: number, hardness: number, delta: number, layer: number | null, exposed: boolean): number {
    const c = this.cell;
    const lo = (v: number, m: number): number => Math.max(0, Math.floor((v - radius - m) / c));
    const hi = (v: number, m: number, n: number): number => Math.min(n - 1, Math.floor((v + radius - m) / c));
    const x0 = lo(center.x, this.min[0]); const x1 = hi(center.x, this.min[0], this.nx);
    const y0 = lo(center.y, this.min[1]); const y1 = hi(center.y, this.min[1], this.ny);
    const z0 = lo(center.z, this.min[2]); const z1 = hi(center.z, this.min[2], this.nz);
    if (x0 > x1 || y0 > y1 || z0 > z1) return 0;
    const inner = radius * Math.min(1, Math.max(0, hardness));
    const count = this.layers.length;
    let changed = 0;
    const surface = this.#surfaceSet();
    for (let z = z0; z <= z1; z++) {
      const pz = this.min[2] + (z + 0.5) * c - center.z;
      for (let y = y0; y <= y1; y++) {
        const py = this.min[1] + (y + 0.5) * c - center.y;
        for (let x = x0; x <= x1; x++) {
          const px = this.min[0] + (x + 0.5) * c - center.x;
          const d = Math.sqrt(px * px + py * py + pz * pz);
          if (d >= radius) continue;
          const w = d <= inner ? 1 : 1 - smooth((d - inner) / Math.max(1e-6, radius - inner));
          const i = this.index(x, y, z);
          const o = i * MASK_LAYERS;
          const counts = surface[i] === 1;
          // Top layer first: erasing every layer clears what lies on top before what it covered.
          for (let k = count - 1; k >= 0; k--) {
            if (layer !== null && k !== layer) continue;
            let step = delta * w;
            if (step < 0 && exposed) {
              let open = 1;
              for (let above = k + 1; above < count; above++) open *= 1 - this.amounts[o + above]!;
              step *= open;
            }
            const before = this.amounts[o + k]!;
            const after = Math.min(1, Math.max(0, before + step));
            if (after === before) continue;
            this.amounts[o + k] = after;
            if (counts) changed += Math.abs(after - before);
          }
        }
      }
    }
    this.#touch(z0, z1);
    return this.surface.length === 0 ? 0 : changed / this.surface.length;
  }

  /** The mean amount of `layers` (null: every layer) over the surface cells — the most of them in each cell. */
  coverage(layers: readonly number[] | null): number {
    const key = layers === null ? '*' : layers.join(',');
    const known = this.#coverage.get(key);
    if (known !== undefined && known.version === this.version) return known.value;
    const which = layers ?? this.layers.map((_, k) => k);
    let sum = 0;
    for (const i of this.surface) {
      let most = 0;
      for (const k of which) most = Math.max(most, this.amounts[i * MASK_LAYERS + k]!);
      sum += most;
    }
    const value = this.surface.length === 0 ? 0 : sum / this.surface.length;
    this.#coverage.set(key, { version: this.version, value });
    return value;
  }

  /** The amount at a point (entity space), blended between the cells around it; null layer: the most of any. */
  amountAt(p: Vec3, layer: number | null): number {
    const fx = (p.x - this.min[0]) / this.cell - 0.5;
    const fy = (p.y - this.min[1]) / this.cell - 0.5;
    const fz = (p.z - this.min[2]) / this.cell - 0.5;
    if (fx < -0.5 || fy < -0.5 || fz < -0.5 || fx > this.nx - 0.5 || fy > this.ny - 0.5 || fz > this.nz - 0.5) return 0;
    const clampTo = (v: number, n: number): number => Math.min(n - 1, Math.max(0, v));
    const x0 = Math.floor(clampTo(fx, this.nx)); const y0 = Math.floor(clampTo(fy, this.ny)); const z0 = Math.floor(clampTo(fz, this.nz));
    const x1 = Math.min(this.nx - 1, x0 + 1); const y1 = Math.min(this.ny - 1, y0 + 1); const z1 = Math.min(this.nz - 1, z0 + 1);
    const tx = clampTo(fx, this.nx) - x0; const ty = clampTo(fy, this.ny) - y0; const tz = clampTo(fz, this.nz) - z0;
    const value = (k: number): number => {
      const a = (x: number, y: number, z: number): number => this.amounts[this.index(x, y, z) * MASK_LAYERS + k]!;
      const lerp = (u: number, v: number, t: number): number => u + (v - u) * t;
      return lerp(
        lerp(lerp(a(x0, y0, z0), a(x1, y0, z0), tx), lerp(a(x0, y1, z0), a(x1, y1, z0), tx), ty),
        lerp(lerp(a(x0, y0, z1), a(x1, y0, z1), tx), lerp(a(x0, y1, z1), a(x1, y1, z1), tx), ty), tz);
    };
    if (layer !== null) return value(layer);
    let most = 0;
    for (let k = 0; k < this.layers.length; k++) most = Math.max(most, value(k));
    return most;
  }

  /** The amounts as RGBA8 texels: slice z at column `z % tiles`, row `floor(z / tiles)`, rows from the top. */
  texels(): Uint8Array {
    let out = this.#packed;
    if (out === null) {
      out = new Uint8Array(this.width * this.height * 4);
      this.#packed = out;
      this.#dirtyLow = 0;
      this.#dirtyHigh = this.nz - 1;
    }
    if (this.#packedVersion === this.version) return out;
    const nx = this.nx;
    const ny = this.ny;
    for (let z = this.#dirtyLow; z <= this.#dirtyHigh; z++) {
      const ox = (z % this.tiles) * nx;
      const oy = Math.floor(z / this.tiles) * ny;
      for (let y = 0; y < ny; y++) {
        let src = this.index(0, y, z) * MASK_LAYERS;
        let dst = ((oy + y) * this.width + ox) * 4;
        for (let x = 0; x < nx; x++, src += MASK_LAYERS, dst += 4) {
          out[dst] = Math.round(this.amounts[src]! * 255);
          out[dst + 1] = Math.round(this.amounts[src + 1]! * 255);
          out[dst + 2] = Math.round(this.amounts[src + 2]! * 255);
          out[dst + 3] = Math.round(this.amounts[src + 3]! * 255);
        }
      }
    }
    this.#packedVersion = this.version;
    this.#dirtyLow = this.nz;
    this.#dirtyHigh = -1;
    return out;
  }

  #touch(z0: number, z1: number): void {
    this.version++;
    this.#dirtyLow = Math.min(this.#dirtyLow, z0);
    this.#dirtyHigh = Math.max(this.#dirtyHigh, z1);
  }

  #set: Uint8Array | null = null;

  #surfaceSet(): Uint8Array {
    if (this.#set === null) {
      this.#set = new Uint8Array(this.nx * this.ny * this.nz);
      for (const i of this.surface) this.#set[i] = 1;
    }
    return this.#set;
  }
}

const smooth = (t: number): number => {
  const k = Math.min(1, Math.max(0, t));
  return k * k * (3 - 2 * k);
};

function hash3(x: number, y: number, z: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647) ^ Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise 0..1. */
export function valueNoise(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x); const iy = Math.floor(y); const iz = Math.floor(z);
  const fx = x - ix; const fy = y - iy; const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx); const uy = fy * fy * (3 - 2 * fy); const uz = fz * fz * (3 - 2 * fz);
  const at = (dx: number, dy: number, dz: number): number => hash3(ix + dx, iy + dy, iz + dz, seed);
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
  return lerp(
    lerp(lerp(at(0, 0, 0), at(1, 0, 0), ux), lerp(at(0, 1, 0), at(1, 1, 0), ux), uy),
    lerp(lerp(at(0, 0, 1), at(1, 0, 1), ux), lerp(at(0, 1, 1), at(1, 1, 1), ux), uy), uz);
}

/**
 * A layer's starting amount at a cell: everywhere at coverage 1; otherwise blotches of
 * `pattern` per meter covering about `coverage` of the surface, more of them low down
 * (`below` > 0) or on faces that look up (`up` > 0).
 */
export function startAmount(spec: MaskLayerSpec, x: number, y: number, z: number, height: number, up: number, seed: number): number {
  if (spec.coverage <= 0) return 0;
  const bias = spec.below * (0.5 - height) + spec.up * 0.5 * up;
  if (spec.coverage >= 1 && bias >= 0) return 1;
  const f = Math.max(1e-3, spec.pattern);
  const n = 0.65 * valueNoise(x * f, y * f, z * f, seed) + 0.35 * valueNoise(x * f * 2.3 + 7.1, y * f * 2.3, z * f * 2.3, seed + 1);
  const v = n + bias - (1 - spec.coverage);
  return smooth((v + 0.06) / 0.12);
}

// ── Building a mask for an entity ─────────────────────────────────────────────

/** The model reference, offset, turn and scale of an entity's Model (as physics3d reads them). */
function modelOf(record: EntityRecord): { path: string; offset: Vec3; rotation: Vec3; scale: number } | undefined {
  const model = record.components.get(MODEL);
  if (model === undefined) return undefined;
  const ref = model['model'];
  const stored = typeof ref === 'object' && ref !== null && typeof (ref as { toJSON?: unknown }).toJSON === 'function'
    ? (ref as { toJSON(): unknown }).toJSON() : ref;
  if (typeof stored !== 'string') return undefined;
  const offset = model['offset'];
  const rotation = model['rotation_offset'];
  return {
    path: stored, offset: offset instanceof Vec3 ? offset : Vec3.ZERO, rotation: rotation instanceof Vec3 ? rotation : Vec3.ZERO,
    scale: modelScaleOf(model, 'model'),
  };
}

/** The model's vertices in entity space (Model.scale, rotation_offset, then offset — as drawn). */
function entityVertices(geometry: ModelGeometry, model: { offset: Vec3; rotation: Vec3; scale: number }): Float32Array {
  const v = geometry.vertices;
  const out = new Float32Array(v.length);
  const turn = model.rotation.x === 0 && model.rotation.y === 0 && model.rotation.z === 0 ? null : Quat.from_euler(model.rotation);
  for (let i = 0; i < v.length; i += 3) {
    let x = v[i]! * model.scale; let y = v[i + 1]! * model.scale; let z = v[i + 2]! * model.scale;
    if (turn !== null) {
      const r = turn.rotate(new Vec3(x, y, z));
      x = r.x; y = r.y; z = r.z;
    }
    out[i] = x + model.offset.x; out[i + 1] = y + model.offset.y; out[i + 2] = z + model.offset.z;
  }
  return out;
}

/** Marks the cells each triangle passes through, sampled at half a cell. */
function markTriangles(vertices: Float32Array, indices: Uint32Array, state: MaskState,
  mark: (x: number, y: number, z: number, nx: number, ny: number, nz: number) => void): void {
  const c = state.cell;
  const step = c * 0.5;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t]! * 3; const b = indices[t + 1]! * 3; const d = indices[t + 2]! * 3;
    const ax = vertices[a]!; const ay = vertices[a + 1]!; const az = vertices[a + 2]!;
    const ex = vertices[b]! - ax; const ey = vertices[b + 1]! - ay; const ez = vertices[b + 2]! - az;
    const fx = vertices[d]! - ax; const fy = vertices[d + 1]! - ay; const fz = vertices[d + 2]! - az;
    let nx = ey * fz - ez * fy; let ny = ez * fx - ex * fz; let nz = ex * fy - ey * fx;
    const nl = Math.hypot(nx, ny, nz);
    if (nl === 0) continue;
    nx /= nl; ny /= nl; nz /= nl;
    const longest = Math.max(Math.hypot(ex, ey, ez), Math.hypot(fx, fy, fz), Math.hypot(fx - ex, fy - ey, fz - ez));
    const n = Math.min(512, Math.max(1, Math.ceil(longest / step)));
    for (let i = 0; i <= n; i++) {
      for (let j = 0; i + j <= n; j++) {
        const u = i / n; const w = j / n;
        const px = ax + ex * u + fx * w; const py = ay + ey * u + fy * w; const pz = az + ez * u + fz * w;
        mark(Math.floor((px - state.min[0]) / c), Math.floor((py - state.min[1]) / c), Math.floor((pz - state.min[2]) / c), nx, ny, nz);
      }
    }
  }
}

/** The cells within half a cell of a box's (or a sphere's) surface, with its outward normals. */
function markShell(box: { min: Vec3; size: Vec3 }, round: boolean, state: MaskState,
  mark: (x: number, y: number, z: number, nx: number, ny: number, nz: number) => void): void {
  const c = state.cell;
  const cx = box.min.x + box.size.x / 2; const cy = box.min.y + box.size.y / 2; const cz = box.min.z + box.size.z / 2;
  const hx = box.size.x / 2; const hy = box.size.y / 2; const hz = box.size.z / 2;
  for (let z = 0; z < state.nz; z++) {
    for (let y = 0; y < state.ny; y++) {
      for (let x = 0; x < state.nx; x++) {
        const px = state.min[0] + (x + 0.5) * c - cx; const py = state.min[1] + (y + 0.5) * c - cy; const pz = state.min[2] + (z + 0.5) * c - cz;
        let distance: number;
        let n: [number, number, number];
        if (round) {
          const r = Math.min(hx, hy, hz);
          const l = Math.hypot(px, py, pz);
          distance = l - r;
          n = l > 0 ? [px / l, py / l, pz / l] : [0, 1, 0];
        } else {
          const qx = Math.abs(px) - hx; const qy = Math.abs(py) - hy; const qz = Math.abs(pz) - hz;
          distance = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0);
          n = qx >= qy && qx >= qz ? [Math.sign(px), 0, 0] : qy >= qz ? [0, Math.sign(py), 0] : [0, 0, Math.sign(pz)];
        }
        if (Math.abs(distance) <= c * 0.75) mark(x, y, z, n[0], n[1], n[2]);
      }
    }
  }
}

function layerSpecs(fields: Fields, where: string): MaskLayerSpec[] {
  const layers = (fields['layers'] as readonly Record<string, unknown>[] | undefined) ?? [];
  if (layers.length > MASK_LAYERS) {
    fail('PP3800', `${where}.layers has ${layers.length} layers; a surface_mask holds at most ${MASK_LAYERS}`, { fix: 'Merge layers that look alike, or put a second mask on a child entity.' });
  }
  const names = new Set<string>();
  return layers.map((l, k) => {
    const name = typeof l['name'] === 'string' && l['name'] !== '' ? l['name'] : `layer${k}`;
    if (names.has(name)) fail('PP3800', `${where}.layers has two layers named "${name}"`, { fix: 'Give every layer its own name.' });
    names.add(name);
    const num = (key: string, fallback: number): number => (typeof l[key] === 'number' ? l[key] as number : fallback);
    return { name, coverage: num('coverage', 1), pattern: num('pattern', 4), below: num('below', 0), up: num('up', 0) };
  });
}

/** What a mask's volume covers in entity space, and how its surface cells are found. */
type Source =
  | { readonly kind: 'mesh'; readonly vertices: Float32Array; readonly indices: Uint32Array; readonly box: { min: Vec3; size: Vec3 } }
  | { readonly kind: 'shell'; readonly round: boolean; readonly box: { min: Vec3; size: Vec3 } };

/** The triangles drawn with one material. */
function materialIndices(geometry: ModelGeometry, material: string): Uint32Array {
  const out: number[] = [];
  for (const g of geometry.groups ?? []) {
    if (g.material !== material) continue;
    for (let i = g.first; i < g.first + g.count; i++) out.push(geometry.indices[i]!);
  }
  return Uint32Array.from(out);
}

function boundsOf(vertices: Float32Array, indices: Uint32Array): { min: Vec3; size: Vec3 } {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const v of indices) {
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a]!, vertices[v * 3 + a]!);
      hi[a] = Math.max(hi[a]!, vertices[v * 3 + a]!);
    }
  }
  return { min: new Vec3(lo[0]!, lo[1]!, lo[2]!), size: new Vec3(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!) };
}

/** Where the mask's surface comes from: undefined while the model is still loading. */
function sourceOf(kernel: Kernel, record: EntityRecord, fields: Fields, where: string): Source | undefined {
  const size = fields['size'] as Vec3;
  const offset = fields['offset'] as Vec3;
  const authored = size.x > 0 && size.y > 0 && size.z > 0
    ? { min: new Vec3(offset.x - size.x / 2, offset.y - size.y / 2, offset.z - size.z / 2), size }
    : null;
  const model = modelOf(record);
  if (model !== undefined) {
    const geometry = kernel.tryService(MODEL_GEOMETRY_SERVICE)?.geometry(model.path);
    if (geometry === undefined && kernel.tryService(MODEL_GEOMETRY_SERVICE) !== undefined) return undefined;
    if (geometry !== null && geometry !== undefined && geometry.indices.length >= 3) {
      const vertices = entityVertices(geometry, model);
      // Only the named material's triangles carry the layers: the volume and its surface cells hug them.
      const only = fields['material'] as string | null;
      const indices = only === null || geometry.groups === undefined ? geometry.indices : materialIndices(geometry, only);
      if (indices.length === 0) {
        fail('PP3800', `${where}.material is "${only}", but the model draws nothing with that material`, {
          fix: `Name one of its materials: ${[...new Set(geometry.groups!.map((g) => g.material).filter((m) => m !== null))].join(', ')}.`,
        });
      }
      return { kind: 'mesh', vertices, indices, box: authored ?? boundsOf(vertices, indices) };
    }
  }
  if (authored !== null) return { kind: 'shell', round: false, box: authored };
  const shape = record.components.get(SHAPE);
  if (shape !== undefined) {
    const s = shape['size'] as Vec3;
    const o = shape['offset'] as Vec3;
    return { kind: 'shell', round: shape['kind'] === 'sphere', box: { min: new Vec3(o.x - s.x / 2, o.y - s.y / 2, o.z - s.z / 2), size: s } };
  }
  const collider = record.components.get(COLLIDER);
  if (collider !== undefined) {
    const o = collider['offset'] as Vec3;
    const kind = collider['shape'];
    if (kind === 'sphere') {
      const r = collider['radius'] as number;
      return { kind: 'shell', round: true, box: { min: new Vec3(o.x - r, o.y - r, o.z - r), size: new Vec3(2 * r, 2 * r, 2 * r) } };
    }
    if (kind === 'box') {
      const s = collider['size'] as Vec3;
      return { kind: 'shell', round: false, box: { min: new Vec3(o.x - s.x / 2, o.y - s.y / 2, o.z - s.z / 2), size: s } };
    }
  }
  // A model with no file in this run (data-only playtests draw nothing): a 1 m box stands in.
  if (model !== undefined) return { kind: 'shell', round: false, box: { min: new Vec3(-0.5, 0, -0.5), size: Vec3.ONE } };
  return fail('PP3800', `${where}: the entity has no Model, Shape or box collider to lay the mask on`, {
    fix: 'Give the surface_mask a size (meters, in the entity\'s own space), or a Model or Shape.',
  });
}

const STATES = new WeakMap<Fields, MaskState>();

/** The mask of a surface_mask component, built on first use; undefined while its model is still loading. */
export function maskOf(kernel: Kernel, record: EntityRecord, fields: Fields): MaskState | undefined {
  const known = STATES.get(fields);
  if (known !== undefined) return known;
  const where = `${record.prefab === undefined ? `entity ${record.id}` : `prefab "${record.prefab}"`} surface_mask`;
  const source = sourceOf(kernel, record, fields, where);
  if (source === undefined) return undefined;
  const resolution = Math.round(fields['resolution'] as number);
  if (!(resolution >= 2 && resolution <= MAX_MASK_RESOLUTION)) {
    fail('PP3800', `${where}.resolution is ${resolution}; it must be 2 to ${MAX_MASK_RESOLUTION}`, { fix: 'Use 32 to 128: cells along the longest side.' });
  }
  const state = new MaskState(source.box, resolution, layerSpecs(fields, where), Math.round(fields['seed'] as number), (s, mark) => {
    if (source.kind === 'mesh') markTriangles(source.vertices, source.indices, s, mark);
    else markShell(source.box, source.round, s, mark);
  }, fields['inside'] === true);
  STATES.set(fields, state);
  return state;
}

/** The mask already built for a component (renderers: never builds one). */
export function builtMask(fields: Fields): MaskState | undefined {
  return STATES.get(fields);
}

// ── Game-facing methods ───────────────────────────────────────────────────────

function finite(value: unknown, where: string, min = -Infinity, max = Infinity): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('PP3800', `${where} must be a number, got ${String(value)}`);
  if (value < min || value > max) fail('PP3800', `${where} is ${value}; it must be ${min} to ${max}`);
  return value;
}

function vec3(value: unknown, where: string): Vec3 {
  if (!(value instanceof Vec3)) fail('PP3800', `${where} must be a Vec3, got ${String(value)}`, { fix: 'Pass a world point, such as hit.point.' });
  return value;
}

/** The entity's mean world scale (brush radii are in world meters). */
function meanScale(record: EntityRecord): number {
  const s = record.transform.worldScale();
  return Math.max(1e-6, (Math.abs(s.x) + Math.abs(s.y) + Math.abs(s.z)) / 3);
}

export function surfaceMaskMethods(kernel: () => Kernel): object {
  const context = (fields: Fields): { record: EntityRecord; state: MaskState | undefined } => {
    const k = kernel();
    const record = k.world.require(componentEntity(fields));
    return { record, state: maskOf(k, record, fields) };
  };
  const stroke = (fields: Fields, name: string, args: unknown[], sign: number): number => {
    const { args: a } = bindArgs(name, args, { positional: ['point', 'radius', 'layer'], keyword: ['strength', 'hardness', 'exposed'], required: ['point', 'radius'] });
    const point = vec3(a['point'], `${name} point`);
    const radius = finite(a['radius'], `${name} radius`, 0, 1e4);
    const strength = a['strength'] === undefined ? 1 : finite(a['strength'], `${name}(strength=)`, 0, 1e4);
    const hardness = a['hardness'] === undefined ? 0.5 : finite(a['hardness'], `${name}(hardness=)`, 0, 1);
    const exposed = a['exposed'] === undefined ? true : a['exposed'] === true;
    const { record, state } = context(fields);
    if (state === undefined || radius === 0 || strength === 0) return 0;
    const layer = state.layer(a['layer'], name);
    if (sign > 0 && layer === null) fail('PP3800', 'paint() needs the layer to paint', { fix: 'paint(hit.point, 0.2, "foam")' });
    const scale = meanScale(record);
    return state.brush(record.transform.toLocal(point), radius / scale, hardness, sign * strength, layer, exposed);
  };
  return {
    /** clean(point, radius, layer=None, *, strength=1, hardness=0.5, exposed=True) -> share of the surface cleaned. */
    clean(this: Fields, ...args: unknown[]): number {
      return stroke(this, 'clean', args, -1);
    },
    /** paint(point, radius, layer, *, strength=1, hardness=0.5) -> share of the surface painted. */
    paint(this: Fields, ...args: unknown[]): number {
      return stroke(this, 'paint', args, 1);
    },
    /** coverage(layer=None) -> 0..1 of the surface the layer (a name, a list of names, None: any) covers. */
    coverage(this: Fields, ...args: unknown[]): number {
      const { args: a } = bindArgs('coverage', args, { positional: ['layer'] });
      const { state } = context(this);
      if (state === undefined) return 1;
      const which = a['layer'];
      if (which === undefined || which === null) return state.coverage(null);
      const list = Array.isArray(which) ? which : (which as { toJSON?: () => unknown })?.toJSON !== undefined && Array.isArray((which as { toJSON(): unknown }).toJSON()) ? (which as { toJSON(): unknown[] }).toJSON() : [which];
      return state.coverage(list.map((l) => state.layer(l, 'coverage')!));
    },
    /** amount_at(point, layer=None) -> the layer's amount 0..1 at a world point (None: the most of any). */
    amount_at(this: Fields, ...args: unknown[]): number {
      const { args: a } = bindArgs('amount_at', args, { positional: ['point', 'layer'], required: ['point'] });
      const point = vec3(a['point'], 'amount_at point');
      const { record, state } = context(this);
      if (state === undefined) return 0;
      return state.amountAt(record.transform.toLocal(point), state.layer(a['layer'], 'amount_at'));
    },
    /** fill(layer=None, amount=1.0): one amount everywhere. */
    fill(this: Fields, ...args: unknown[]): void {
      const { args: a } = bindArgs('fill', args, { positional: ['layer', 'amount'] });
      const amount = a['amount'] === undefined ? 1 : finite(a['amount'], 'fill amount', 0, 1);
      const { state } = context(this);
      if (state === undefined) return;
      state.fill(state.layer(a['layer'], 'fill'), amount);
    },
    /** reset(layer=None): back to the layers' starting coverage. */
    reset(this: Fields, ...args: unknown[]): void {
      const { args: a } = bindArgs('reset', args, { positional: ['layer'] });
      const { state } = context(this);
      if (state === undefined) return;
      state.reset(state.layer(a['layer'], 'reset'));
    },
    /** Whether the mask is built (its model has loaded). */
    get ready(): boolean {
      return context(this as unknown as Fields).state !== undefined;
    },
    /** The surface cells the mask averages over (its detail). */
    get cells(): number {
      return context(this as unknown as Fields).state?.surface.length ?? 0;
    },
  };
}
