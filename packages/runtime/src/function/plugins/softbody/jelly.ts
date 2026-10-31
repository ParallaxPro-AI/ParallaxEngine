/**
 * Soft bodies: a closed surface of particles (sphere, box or capsule of `size`) held
 * together by three XPBD constraints per substep:
 *
 *   edges   every surface edge keeps its rest length, at `stiffness` (wobble vs. stretch)
 *   volume  the enclosed volume stays `pressure` × its rest volume, exactly (zero
 *           compliance: incompressible jelly; pressure > 1 inflates, < 1 sags)
 *   shape   every particle is pulled toward where the best-fit rigid motion of the rest
 *           shape puts it (shape matching), a share `shape_stiffness` of the way per
 *           fixed step: 0 is a water balloon, 1 a rigid body; jelly lives around 0.02–0.2
 *
 * The best-fit rotation is extracted from the moment matrix A = Σ (x − c) qᵀ with the
 * iterative method of Müller et al. 2016 ("A Robust Method to Extract the Rotational Part
 * of Deformations"), warm-started from the last step's, so it never flips. The entity
 * follows the body: after every step its world position is the particles' centroid and its
 * rotation the best-fit rotation, so children (eyes on a slime) ride along.
 */

import { Quat, Vec3 } from '../../../core/index.js';
import type { Fields } from '../../kernel/index.js';
import { collideParticle } from './colliders.js';
import type { Obstacles } from './colliders.js';
import { compliance, DistanceSet, Particles, predict, solveDistances, updateVelocities } from './xpbd.js';

export const SOFT_SHAPES = ['sphere', 'box', 'capsule'] as const;
export type SoftShape = (typeof SOFT_SHAPES)[number];

export function softKey(fields: Fields): string {
  const size = fields['size'] as Vec3;
  return [fields['shape'], size.x, size.y, size.z, fields['detail'], fields['mass']].join(',');
}

interface Surface {
  readonly positions: number[];
  readonly indices: number[];
}

/** An icosphere of unit radius, `detail` times subdivided (12, 42, 162, 642 vertices). */
function icosphere(detail: number): Surface {
  const t = (1 + Math.sqrt(5)) / 2;
  const positions: number[] = [];
  const add = (x: number, y: number, z: number): number => {
    const l = Math.hypot(x, y, z);
    positions.push(x / l, y / l, z / l);
    return positions.length / 3 - 1;
  };
  for (const [x, y, z] of [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]] as const) add(x, y, z);
  let faces = [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
    3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1];
  for (let d = 0; d < detail; d++) {
    const mids = new Map<string, number>();
    const mid = (a: number, b: number): number => {
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      let m = mids.get(key);
      if (m === undefined) {
        m = add((positions[a * 3]! + positions[b * 3]!) / 2, (positions[a * 3 + 1]! + positions[b * 3 + 1]!) / 2, (positions[a * 3 + 2]! + positions[b * 3 + 2]!) / 2);
        mids.set(key, m);
      }
      return m;
    };
    const next: number[] = [];
    for (let f = 0; f < faces.length; f += 3) {
      const a = faces[f]!;
      const b = faces[f + 1]!;
      const c = faces[f + 2]!;
      const ab = mid(a, b);
      const bc = mid(b, c);
      const ca = mid(c, a);
      next.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
    }
    faces = next;
  }
  // Wind counter-clockwise seen from outside (the port's front-face rule): positive enclosed volume.
  if (enclosedVolume(positions, faces) < 0) for (let f = 0; f < faces.length; f += 3) [faces[f + 1], faces[f + 2]] = [faces[f + 2]!, faces[f + 1]!];
  return { positions, indices: faces };
}

/** A unit cube surface (-0.5..0.5) with `n` segments per edge, vertices welded. */
function cube(n: number): Surface {
  const positions: number[] = [];
  const indices: number[] = [];
  const index = new Map<string, number>();
  const vertex = (x: number, y: number, z: number): number => {
    const key = `${Math.round(x * 1e6)},${Math.round(y * 1e6)},${Math.round(z * 1e6)}`;
    let i = index.get(key);
    if (i === undefined) {
      i = positions.length / 3;
      positions.push(x, y, z);
      index.set(key, i);
    }
    return i;
  };
  // Each face: a normal axis and sign, spanned by (u, v) with u × v = normal (outward, counter-clockwise).
  const faces: ReadonlyArray<readonly [readonly number[], readonly number[], readonly number[]]> = [
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  for (const [nrm, u, v] of faces) {
    const grid: number[][] = [];
    for (let i = 0; i <= n; i++) {
      const row: number[] = [];
      for (let j = 0; j <= n; j++) {
        const a = i / n - 0.5;
        const b = j / n - 0.5;
        row.push(vertex(nrm[0]! * 0.5 + u[0]! * a + v[0]! * b, nrm[1]! * 0.5 + u[1]! * a + v[1]! * b, nrm[2]! * 0.5 + u[2]! * a + v[2]! * b));
      }
      grid.push(row);
    }
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        indices.push(grid[i]![j]!, grid[i + 1]![j]!, grid[i + 1]![j + 1]!, grid[i]![j]!, grid[i + 1]![j + 1]!, grid[i]![j + 1]!);
      }
    }
  }
  return { positions, indices };
}

/** The rest surface of a soft body in its own space, centered on its centroid. */
export function softSurface(shape: SoftShape, size: Vec3, detail: number): Surface {
  if (shape === 'box') {
    const s = cube(detail + 1);
    for (let k = 0; k < s.positions.length; k += 3) {
      s.positions[k] = s.positions[k]! * size.x;
      s.positions[k + 1] = s.positions[k + 1]! * size.y;
      s.positions[k + 2] = s.positions[k + 2]! * size.z;
    }
    return s;
  }
  const s = icosphere(detail);
  const r = size.x / 2;
  const half = shape === 'capsule' ? Math.max(0, size.y / 2 - r) : 0;
  for (let k = 0; k < s.positions.length; k += 3) {
    const y = s.positions[k + 1]!;
    s.positions[k] = s.positions[k]! * (shape === 'capsule' ? r : size.x / 2);
    s.positions[k + 1] = shape === 'capsule' ? y * r + Math.sign(y) * half : y * size.y / 2;
    s.positions[k + 2] = s.positions[k + 2]! * (shape === 'capsule' ? r : size.z / 2);
  }
  return s;
}

/** Signed volume enclosed by a closed counter-clockwise triangle surface. */
export function enclosedVolume(x: ArrayLike<number>, indices: ArrayLike<number>): number {
  let v = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]! * 3;
    const b = indices[t + 1]! * 3;
    const c = indices[t + 2]! * 3;
    v += x[a]! * (x[b + 1]! * x[c + 2]! - x[b + 2]! * x[c + 1]!)
      - x[a + 1]! * (x[b]! * x[c + 2]! - x[b + 2]! * x[c]!)
      + x[a + 2]! * (x[b]! * x[c + 1]! - x[b + 1]! * x[c]!);
  }
  return v / 6;
}

export class SoftSim {
  readonly key: string;
  readonly p: Particles;
  /** Rest positions relative to the rest centroid, world-scaled. */
  readonly rest: Float64Array;
  readonly edges: DistanceSet;
  readonly indices: Uint32Array;
  readonly uvs: Float32Array;
  readonly restVolume: number;
  /** Best-fit rotation (x, y, z, w), warm start for the next extraction. */
  readonly q = new Float64Array([0, 0, 0, 1]);
  readonly center = new Float64Array(3);
  readonly #grad: Float64Array;

  constructor(fields: Fields, position: Vec3, rotation: Quat, scale: Vec3) {
    this.key = softKey(fields);
    const surface = softSurface(fields['shape'] as SoftShape, fields['size'] as Vec3, fields['detail'] as number);
    const n = surface.positions.length / 3;
    this.p = new Particles(n, fields['mass'] as number);
    this.rest = new Float64Array(n * 3);
    this.uvs = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const local = new Vec3(surface.positions[i * 3]! * scale.x, surface.positions[i * 3 + 1]! * scale.y, surface.positions[i * 3 + 2]! * scale.z);
      this.rest[i * 3] = local.x;
      this.rest[i * 3 + 1] = local.y;
      this.rest[i * 3 + 2] = local.z;
      const world = rotation.rotate(local).__add__(position);
      this.p.x[i * 3] = world.x;
      this.p.x[i * 3 + 1] = world.y;
      this.p.x[i * 3 + 2] = world.z;
      // Spherical uvs from the rest direction.
      const l = Math.hypot(local.x, local.y, local.z) || 1;
      this.uvs[i * 2] = 0.5 + Math.atan2(local.x, local.z) / (2 * Math.PI);
      this.uvs[i * 2 + 1] = 0.5 - Math.asin(Math.max(-1, Math.min(1, local.y / l))) / Math.PI;
    }
    this.p.prev.set(this.p.x);
    this.indices = Uint32Array.from(surface.indices);
    const seen = new Set<string>();
    const pairs: [number, number][] = [];
    for (let t = 0; t < surface.indices.length; t += 3) {
      for (let e = 0; e < 3; e++) {
        const a = surface.indices[t + e]!;
        const b = surface.indices[t + ((e + 1) % 3)]!;
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push(a < b ? [a, b] : [b, a]);
      }
    }
    // Rest lengths from the rest shape (not the placed particles), so a rebuild anywhere gives the same bits.
    this.edges = new DistanceSet(pairs, this.rest);
    this.restVolume = enclosedVolume(this.rest, this.indices);
    this.#grad = new Float64Array(n * 3);
    this.q.set([rotation.x, rotation.y, rotation.z, rotation.w]);
    this.center.set([position.x, position.y, position.z]);
  }

  volume(): number {
    return enclosedVolume(this.p.x, this.indices);
  }

  #solveVolume(target: number): void {
    const { x, w } = this.p;
    const g = this.#grad;
    g.fill(0);
    const ix = this.indices;
    for (let t = 0; t < ix.length; t += 3) {
      const a = ix[t]! * 3;
      const b = ix[t + 1]! * 3;
      const c = ix[t + 2]! * 3;
      // ∂V/∂x_a = (x_b × x_c) / 6, and cyclically.
      g[a] = g[a]! + (x[b + 1]! * x[c + 2]! - x[b + 2]! * x[c + 1]!) / 6;
      g[a + 1] = g[a + 1]! + (x[b + 2]! * x[c]! - x[b]! * x[c + 2]!) / 6;
      g[a + 2] = g[a + 2]! + (x[b]! * x[c + 1]! - x[b + 1]! * x[c]!) / 6;
      g[b] = g[b]! + (x[c + 1]! * x[a + 2]! - x[c + 2]! * x[a + 1]!) / 6;
      g[b + 1] = g[b + 1]! + (x[c + 2]! * x[a]! - x[c]! * x[a + 2]!) / 6;
      g[b + 2] = g[b + 2]! + (x[c]! * x[a + 1]! - x[c + 1]! * x[a]!) / 6;
      g[c] = g[c]! + (x[a + 1]! * x[b + 2]! - x[a + 2]! * x[b + 1]!) / 6;
      g[c + 1] = g[c + 1]! + (x[a + 2]! * x[b]! - x[a]! * x[b + 2]!) / 6;
      g[c + 2] = g[c + 2]! + (x[a]! * x[b + 1]! - x[a + 1]! * x[b]!) / 6;
    }
    let denom = 0;
    for (let i = 0; i < this.p.count; i++) {
      denom += w[i]! * (g[i * 3]! ** 2 + g[i * 3 + 1]! ** 2 + g[i * 3 + 2]! ** 2);
    }
    if (denom < 1e-18) return;
    const lambda = -(this.volume() - target) / denom;
    for (let i = 0; i < this.p.count; i++) {
      const s = lambda * w[i]!;
      x[i * 3] = x[i * 3]! + s * g[i * 3]!;
      x[i * 3 + 1] = x[i * 3 + 1]! + s * g[i * 3 + 1]!;
      x[i * 3 + 2] = x[i * 3 + 2]! + s * g[i * 3 + 2]!;
    }
  }

  /** Centroid and best-fit rotation of the current particles (into `center` and `q`). */
  fit(): void {
    const { x } = this.p;
    const n = this.p.count;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let i = 0; i < n; i++) {
      cx += x[i * 3]!;
      cy += x[i * 3 + 1]!;
      cz += x[i * 3 + 2]!;
    }
    cx /= n;
    cy /= n;
    cz /= n;
    this.center[0] = cx;
    this.center[1] = cy;
    this.center[2] = cz;
    // A = Σ p qᵀ, columns a0 a1 a2 (a_j = Σ p · q_j).
    const A = new Float64Array(9);
    const r = this.rest;
    for (let i = 0; i < n; i++) {
      const px = x[i * 3]! - cx;
      const py = x[i * 3 + 1]! - cy;
      const pz = x[i * 3 + 2]! - cz;
      for (let j = 0; j < 3; j++) {
        const qj = r[i * 3 + j]!;
        A[j * 3] = A[j * 3]! + px * qj;
        A[j * 3 + 1] = A[j * 3 + 1]! + py * qj;
        A[j * 3 + 2] = A[j * 3 + 2]! + pz * qj;
      }
    }
    extractRotation(A, this.q, 20);
  }

  #matchShape(stiffness: number): void {
    if (stiffness <= 0) return;
    this.fit();
    const [qx, qy, qz, qw] = this.q as unknown as [number, number, number, number];
    const R = rotationMatrix(qx, qy, qz, qw);
    const { x, w } = this.p;
    const r = this.rest;
    for (let i = 0; i < this.p.count; i++) {
      if (w[i] === 0) continue;
      const lx = r[i * 3]!;
      const ly = r[i * 3 + 1]!;
      const lz = r[i * 3 + 2]!;
      const gx = this.center[0]! + R[0]! * lx + R[3]! * ly + R[6]! * lz;
      const gy = this.center[1]! + R[1]! * lx + R[4]! * ly + R[7]! * lz;
      const gz = this.center[2]! + R[2]! * lx + R[5]! * ly + R[8]! * lz;
      x[i * 3] = x[i * 3]! + (gx - x[i * 3]!) * stiffness;
      x[i * 3 + 1] = x[i * 3 + 1]! + (gy - x[i * 3 + 1]!) * stiffness;
      x[i * 3 + 2] = x[i * 3 + 2]! + (gz - x[i * 3 + 2]!) * stiffness;
    }
  }

  step(fields: Fields, dt: number, gravity: number, obstacles: Obstacles | null): void {
    const substeps = fields['substeps'] as number;
    const h = dt / substeps;
    const p = this.p;
    this.edges.compliance = compliance(fields['stiffness'] as number);
    // Shape matching per substep, so the response doesn't depend on the substep count.
    const shape = 1 - Math.pow(1 - Math.min(1, Math.max(0, fields['shape_stiffness'] as number)), 1 / substeps);
    const target = this.restVolume * (fields['pressure'] as number);
    const margin = fields['thickness'] as number;
    const friction = fields['friction'] as number;
    const damping = fields['damping'] as number;
    p.a.fill(0);
    for (let s = 0; s < substeps; s++) {
      predict(p, h, gravity, damping);
      solveDistances(p, this.edges, h);
      this.#solveVolume(target);
      this.#matchShape(shape);
      if (obstacles !== null) for (let i = 0; i < p.count; i++) collideParticle(p.x, p.prev, i, obstacles, margin, friction);
      updateVelocities(p, h);
    }
    this.fit();
  }

  /** Add `dv` to the velocity of particles within `radius` of `point` (all for radius ≤ 0), fading out. */
  impulse(point: Vec3 | null, dv: Vec3, radius: number): void {
    const { x, v } = this.p;
    for (let i = 0; i < this.p.count; i++) {
      let f = 1;
      if (point !== null && radius > 0) {
        const d = Math.hypot(x[i * 3]! - point.x, x[i * 3 + 1]! - point.y, x[i * 3 + 2]! - point.z);
        if (d >= radius) continue;
        f = 1 - d / radius;
      }
      v[i * 3] = v[i * 3]! + dv.x * f;
      v[i * 3 + 1] = v[i * 3 + 1]! + dv.y * f;
      v[i * 3 + 2] = v[i * 3 + 2]! + dv.z * f;
    }
  }

  velocity(): Vec3 {
    const v = this.p.v;
    let x = 0;
    let y = 0;
    let z = 0;
    for (let i = 0; i < this.p.count; i++) {
      x += v[i * 3]!;
      y += v[i * 3 + 1]!;
      z += v[i * 3 + 2]!;
    }
    return new Vec3(x / this.p.count, y / this.p.count, z / this.p.count);
  }

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

/** Column-major 3×3 rotation of a unit quaternion. */
export function rotationMatrix(x: number, y: number, z: number, w: number): number[] {
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w),
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w),
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y),
  ];
}

/** Müller et al. 2016: refine unit quaternion `q` (x y z w) toward the rotation of A (column-major). */
export function extractRotation(A: Float64Array, q: Float64Array, iterations: number): void {
  for (let it = 0; it < iterations; it++) {
    const R = rotationMatrix(q[0]!, q[1]!, q[2]!, q[3]!);
    let ox = 0;
    let oy = 0;
    let oz = 0;
    let dot = 0;
    for (let c = 0; c < 3; c++) {
      const rx = R[c * 3]!;
      const ry = R[c * 3 + 1]!;
      const rz = R[c * 3 + 2]!;
      const ax = A[c * 3]!;
      const ay = A[c * 3 + 1]!;
      const az = A[c * 3 + 2]!;
      ox += ry * az - rz * ay;
      oy += rz * ax - rx * az;
      oz += rx * ay - ry * ax;
      dot += rx * ax + ry * ay + rz * az;
    }
    const scale = 1 / (Math.abs(dot) + 1e-9);
    ox *= scale;
    oy *= scale;
    oz *= scale;
    const angle = Math.hypot(ox, oy, oz);
    if (angle < 1e-9) break;
    const s = Math.sin(angle / 2) / angle;
    const dx = ox * s;
    const dy = oy * s;
    const dz = oz * s;
    const dw = Math.cos(angle / 2);
    // q = dq · q
    const [x, y, z, w] = [q[0]!, q[1]!, q[2]!, q[3]!];
    q[0] = dw * x + dx * w + dy * z - dz * y;
    q[1] = dw * y - dx * z + dy * w + dz * x;
    q[2] = dw * z + dx * y - dy * x + dz * w;
    q[3] = dw * w - dx * x - dy * y - dz * z;
    const l = Math.hypot(q[0]!, q[1]!, q[2]!, q[3]!);
    q[0] = q[0]! / l;
    q[1] = q[1]! / l;
    q[2] = q[2]! / l;
    q[3] = q[3]! / l;
  }
}
