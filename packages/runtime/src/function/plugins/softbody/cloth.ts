/**
 * Cloth: a rectangle of particles in the entity's local x/y plane, hanging from the
 * entity's origin — the top edge runs along local x at y = 0 and the cloth hangs toward
 * -y, facing +z. `size` is (width, height) in meters, `cols` × `rows` particles.
 *
 * Constraints: stretch — every triangle edge (row and column neighbours, and one diagonal
 * per quad) at `stiffness` — and bending — the two particles facing each other across every
 * interior edge (which also resists shear) at `bend`. (Both diagonals plus skip-one bending
 * over-constrain a sheet and jitter at high stiffness; this set is stable even rigid.)
 * Pins hold particles where they lie in the rest shape under the entity's transform, moving with it between substeps: attach the cloth entity to a bone
 * socket (`attach(cape, socket="spine")`) and its pinned edge follows the bone.
 *
 * Wind (the wind service) pushes each triangle along its normal by the air's velocity
 * relative to it: F = ½ ρ · drag · A · (v_rel · n) |v_rel · n| n, ρ = 1.2 kg/m³, shared by
 * the triangle's three particles.
 */

import { Vec3 } from '../../../core/index.js';
import type { Fields } from '../../kernel/index.js';
import type { WindService } from '../../services/index.js';
import { collideParticle } from './colliders.js';
import type { Obstacles } from './colliders.js';
import { compliance, DistanceSet, Particles, predict, solveDistances, updateVelocities } from './xpbd.js';

export const PIN_MODES = ['top', 'top_corners', 'left', 'corners', 'none'] as const;
export type PinMode = (typeof PIN_MODES)[number];

const AIR_DENSITY = 1.2;

/** The fields that decide the cloth's particles and constraints (changing one rebuilds it). */
export function clothKey(fields: Fields): string {
  const size = fields['size'] as { x: number; y: number };
  return [size.x, size.y, fields['cols'], fields['rows'], fields['density']].join(',');
}

/** A world placement as a column-major matrix. */
export type Placement = Float64Array;

export function placementOf(position: Vec3, rotation: { rotate(v: Vec3): Vec3 }, scale: Vec3): Placement {
  const x = rotation.rotate(new Vec3(scale.x, 0, 0));
  const y = rotation.rotate(new Vec3(0, scale.y, 0));
  const z = rotation.rotate(new Vec3(0, 0, scale.z));
  return Float64Array.from([x.x, x.y, x.z, 0, y.x, y.y, y.z, 0, z.x, z.y, z.z, 0, position.x, position.y, position.z, 1]);
}

function place(m: Placement, lx: number, ly: number, lz: number, out: Float64Array, k: number): void {
  out[k] = m[0]! * lx + m[4]! * ly + m[8]! * lz + m[12]!;
  out[k + 1] = m[1]! * lx + m[5]! * ly + m[9]! * lz + m[13]!;
  out[k + 2] = m[2]! * lx + m[6]! * ly + m[10]! * lz + m[14]!;
}

export class ClothSim {
  readonly key: string;
  readonly cols: number;
  readonly rows: number;
  readonly p: Particles;
  /** Rest positions in the entity's local space. */
  readonly local: Float64Array;
  readonly stretch: DistanceSet;
  readonly bending: DistanceSet;
  readonly indices: Uint32Array;
  readonly uvs: Float32Array;
  /** The entity's placement at the end of the last step (pins move from it to the current one). */
  placement: Placement;
  readonly #target = new Float64Array(3);

  constructor(fields: Fields, placement: Placement) {
    this.key = clothKey(fields);
    const size = fields['size'] as { x: number; y: number };
    const cols = fields['cols'] as number;
    const rows = fields['rows'] as number;
    this.cols = cols;
    this.rows = rows;
    const n = cols * rows;
    const mass = (fields['density'] as number) * size.x * size.y;
    this.p = new Particles(n, mass);
    this.local = new Float64Array(n * 3);
    this.uvs = new Float32Array(n * 2);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        this.local[i * 3] = (c / (cols - 1) - 0.5) * size.x;
        this.local[i * 3 + 1] = -(r / (rows - 1)) * size.y;
        this.uvs[i * 2] = c / (cols - 1);
        this.uvs[i * 2 + 1] = r / (rows - 1);
        place(placement, this.local[i * 3]!, this.local[i * 3 + 1]!, 0, this.p.x, i * 3);
      }
    }
    this.p.prev.set(this.p.x);
    this.placement = placement;
    const id = (r: number, c: number): number => r * cols + c;
    const stretch: [number, number][] = [];
    const tris: number[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (c + 1 < cols) stretch.push([id(r, c), id(r, c + 1)]);
        if (r + 1 < rows) stretch.push([id(r, c), id(r + 1, c)]);
        if (c + 1 < cols && r + 1 < rows) {
          stretch.push([id(r, c), id(r + 1, c + 1)]);
          // Counter-clockwise seen from +z (the cloth's front).
          tris.push(id(r, c), id(r + 1, c), id(r + 1, c + 1), id(r, c), id(r + 1, c + 1), id(r, c + 1));
        }
      }
    }
    // Bending: the two vertices facing each other across every interior edge.
    const across = new Map<string, number[]>();
    for (let t = 0; t < tris.length; t += 3) {
      for (let e = 0; e < 3; e++) {
        const a = tris[t + e]!;
        const b = tris[t + ((e + 1) % 3)]!;
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        let list = across.get(key);
        if (list === undefined) across.set(key, list = []);
        list.push(tris[t + ((e + 2) % 3)]!);
      }
    }
    const bend: [number, number][] = [];
    for (const facing of across.values()) if (facing.length === 2) bend.push([facing[0]!, facing[1]!]);
    // Rest lengths from the rest grid under the entity's scale only (never its pose), so a scaled
    // entity keeps its look and a rebuild anywhere (a restore) gives the same bits.
    const scaled = new Float64Array(n * 3);
    const sx = Math.hypot(placement[0]!, placement[1]!, placement[2]!);
    const sy = Math.hypot(placement[4]!, placement[5]!, placement[6]!);
    for (let i = 0; i < n; i++) {
      scaled[i * 3] = this.local[i * 3]! * sx;
      scaled[i * 3 + 1] = this.local[i * 3 + 1]! * sy;
    }
    this.stretch = new DistanceSet(stretch, scaled);
    this.bending = new DistanceSet(bend, scaled);
    this.indices = Uint32Array.from(tris);
  }

  /** Which particles a pin mode (plus explicit indices) holds. */
  pinned(mode: PinMode, extra: readonly number[]): Set<number> {
    const { cols, rows } = this;
    const set = new Set<number>();
    if (mode === 'top') for (let c = 0; c < cols; c++) set.add(c);
    else if (mode === 'top_corners') set.add(0).add(cols - 1);
    else if (mode === 'left') for (let r = 0; r < rows; r++) set.add(r * cols);
    else if (mode === 'corners') set.add(0).add(cols - 1).add((rows - 1) * cols).add(rows * cols - 1);
    for (const i of extra) set.add(i);
    return set;
  }

  /** Apply wind to `a` (accelerations) from the wind service at this moment. */
  #wind(wind: WindService | undefined, drag: number, scale: number): void {
    const { x, v, w, a } = this.p;
    a.fill(0);
    if (wind === undefined || drag === 0 || scale === 0) return;
    const sample = new Float64Array(2);
    const ix = this.indices;
    for (let t = 0; t < ix.length; t += 3) {
      const i = ix[t]! * 3;
      const j = ix[t + 1]! * 3;
      const k = ix[t + 2]! * 3;
      const e1x = x[j]! - x[i]!;
      const e1y = x[j + 1]! - x[i + 1]!;
      const e1z = x[j + 2]! - x[i + 2]!;
      const e2x = x[k]! - x[i]!;
      const e2y = x[k + 1]! - x[i + 1]!;
      const e2z = x[k + 2]! - x[i + 2]!;
      let nx = e1y * e2z - e1z * e2y;
      let ny = e1z * e2x - e1x * e2z;
      let nz = e1x * e2y - e1y * e2x;
      const twice = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (twice < 1e-12) continue;
      nx /= twice;
      ny /= twice;
      nz /= twice;
      const area = twice / 2;
      const cx = (x[i]! + x[j]! + x[k]!) / 3;
      const cz = (x[i + 2]! + x[j + 2]! + x[k + 2]!) / 3;
      wind.sample(cx, cz, sample);
      const rx = sample[0]! * scale - (v[i]! + v[j]! + v[k]!) / 3;
      const ry = -(v[i + 1]! + v[j + 1]! + v[k + 1]!) / 3;
      const rz = sample[1]! * scale - (v[i + 2]! + v[j + 2]! + v[k + 2]!) / 3;
      const along = rx * nx + ry * ny + rz * nz;
      const f = 0.5 * AIR_DENSITY * drag * area * along * Math.abs(along) / 3;
      for (let c = 0; c < 3; c++) {
        const q = c === 0 ? i : c === 1 ? j : k;
        const wq = w[q / 3]!;
        a[q] = a[q]! + f * nx * wq;
        a[q + 1] = a[q + 1]! + f * ny * wq;
        a[q + 2] = a[q + 2]! + f * nz * wq;
      }
    }
  }

  /** One fixed step of `dt` seconds toward the entity's placement `to`. */
  step(fields: Fields, to: Placement, dt: number, gravity: number, wind: WindService | undefined, obstacles: Obstacles | null): void {
    const substeps = fields['substeps'] as number;
    const h = dt / substeps;
    const p = this.p;
    const pins = this.pinned(fields['pin'] as PinMode, (fields['pinned'] as readonly number[]).filter((i) => i >= 0 && i < p.count));
    for (let i = 0; i < p.count; i++) p.w[i] = pins.has(i) ? 0 : p.freeW[i]!;
    this.stretch.compliance = compliance(fields['stiffness'] as number);
    this.bending.compliance = compliance(fields['bend'] as number);
    this.#wind(wind, fields['drag'] as number, fields['wind_scale'] as number);
    const from = this.placement;
    const blend = new Float64Array(16);
    const margin = fields['thickness'] as number;
    const friction = fields['friction'] as number;
    const damping = fields['damping'] as number;
    for (let s = 1; s <= substeps; s++) {
      predict(p, h, gravity, damping);
      const k = s / substeps;
      for (let m = 0; m < 16; m++) blend[m] = from[m]! + (to[m]! - from[m]!) * k;
      for (const i of pins) {
        place(blend, this.local[i * 3]!, this.local[i * 3 + 1]!, 0, this.#target, 0);
        p.x[i * 3] = this.#target[0]!;
        p.x[i * 3 + 1] = this.#target[1]!;
        p.x[i * 3 + 2] = this.#target[2]!;
      }
      solveDistances(p, this.stretch, h);
      solveDistances(p, this.bending, h);
      if (obstacles !== null) {
        for (let i = 0; i < p.count; i++) if (p.w[i] !== 0) collideParticle(p.x, p.prev, i, obstacles, margin, friction);
      }
      updateVelocities(p, h);
    }
    this.placement = to;
  }

  /** Change every free particle's velocity by `dv` within `radius` of `point` (all of them for radius ≤ 0), fading to the edge. */
  impulse(point: Vec3, dv: Vec3, radius: number): void {
    const { x, v, w } = this.p;
    for (let i = 0; i < this.p.count; i++) {
      if (w[i] === 0) continue;
      let f = 1;
      if (radius > 0) {
        const d = Math.hypot(x[i * 3]! - point.x, x[i * 3 + 1]! - point.y, x[i * 3 + 2]! - point.z);
        if (d >= radius) continue;
        f = 1 - d / radius;
      }
      v[i * 3] = v[i * 3]! + dv.x * f;
      v[i * 3 + 1] = v[i * 3 + 1]! + dv.y * f;
      v[i * 3 + 2] = v[i * 3 + 2]! + dv.z * f;
    }
  }

  /** World bounds of the particles, [min, max]. */
  bounds(): [number[], number[]] {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    const x = this.p.x;
    for (let k = 0; k < x.length; k++) {
      const axis = k % 3;
      if (x[k]! < min[axis]!) min[axis] = x[k]!;
      if (x[k]! > max[axis]!) max[axis] = x[k]!;
    }
    return [min, max];
  }
}
