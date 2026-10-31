/**
 * The particle solver cloth and soft bodies share: extended position-based dynamics
 * (XPBD) with small steps — every fixed step is split into substeps, each predicting
 * positions from velocities, projecting constraints once (Lagrange multipliers reset per
 * substep, which is what makes many small steps beat many iterations), and deriving
 * velocities from the moved positions.
 *
 * Everything here is plain arithmetic on typed arrays: no kernel, no allocation per step,
 * the same results on every machine for the same inputs (each array is walked in index
 * order). That is what makes a step job-ready — `stepParticles` could run in a worker on a
 * copy of the buffers — though the plugin runs it inline, because the kernel's frame
 * order needs the result before the next phase.
 */

/** Compliance (m/N) of stiffness 0.5; stiffness s maps to SCALE · (1 − s) / s, so 1 is rigid. */
const COMPLIANCE_SCALE = 1e-3;

/** XPBD compliance (m/N) for an authored 0..1 stiffness. */
export function compliance(stiffness: number): number {
  if (stiffness >= 1) return 0;
  const s = Math.max(stiffness, 1e-3);
  return COMPLIANCE_SCALE * (1 - s) / s;
}

export class Particles {
  readonly count: number;
  /** World positions, x y z per particle. */
  readonly x: Float64Array;
  /** Positions at the start of the substep. */
  readonly prev: Float64Array;
  readonly v: Float64Array;
  /** Inverse masses; 0 = pinned (moved by its target, never by constraints). */
  readonly w: Float64Array;
  /** Per-particle inverse mass when free (pins set `w` to 0 and back). */
  readonly freeW: Float64Array;
  /** Accumulated external acceleration this step (wind), x y z per particle. */
  readonly a: Float64Array;

  constructor(count: number, mass: number) {
    this.count = count;
    this.x = new Float64Array(count * 3);
    this.prev = new Float64Array(count * 3);
    this.v = new Float64Array(count * 3);
    this.w = new Float64Array(count);
    this.freeW = new Float64Array(count);
    this.a = new Float64Array(count * 3);
    const inv = 1 / (mass / count);
    this.w.fill(inv);
    this.freeW.fill(inv);
  }
}

/** Pairs of particle indices with rest lengths and one compliance per group. */
export class DistanceSet {
  readonly a: Uint32Array;
  readonly b: Uint32Array;
  readonly rest: Float64Array;
  compliance = 0;

  constructor(pairs: readonly (readonly [number, number])[], x: Float64Array) {
    this.a = new Uint32Array(pairs.length);
    this.b = new Uint32Array(pairs.length);
    this.rest = new Float64Array(pairs.length);
    pairs.forEach(([i, j], k) => {
      this.a[k] = i;
      this.b[k] = j;
      this.rest[k] = Math.hypot(x[i * 3]! - x[j * 3]!, x[i * 3 + 1]! - x[j * 3 + 1]!, x[i * 3 + 2]! - x[j * 3 + 2]!);
    });
  }
}

/** Integrate one substep: gravity, accumulated acceleration, damping; remember positions. */
export function predict(p: Particles, h: number, gravity: number, damping: number): void {
  const keep = Math.max(0, 1 - damping * h);
  const { x, prev, v, w, a } = p;
  for (let i = 0; i < p.count; i++) {
    const k = i * 3;
    prev[k] = x[k]!;
    prev[k + 1] = x[k + 1]!;
    prev[k + 2] = x[k + 2]!;
    if (w[i] === 0) continue;
    v[k] = (v[k]! + a[k]! * h) * keep;
    v[k + 1] = (v[k + 1]! + (a[k + 1]! + gravity) * h) * keep;
    v[k + 2] = (v[k + 2]! + a[k + 2]! * h) * keep;
    x[k] = x[k]! + v[k]! * h;
    x[k + 1] = x[k + 1]! + v[k + 1]! * h;
    x[k + 2] = x[k + 2]! + v[k + 2]! * h;
  }
}

/** Project every distance constraint once (XPBD, λ reset per substep). */
export function solveDistances(p: Particles, set: DistanceSet, h: number): void {
  const alpha = set.compliance / (h * h);
  const { x, w } = p;
  for (let c = 0; c < set.rest.length; c++) {
    const i = set.a[c]!;
    const j = set.b[c]!;
    const wsum = w[i]! + w[j]!;
    if (wsum === 0) continue;
    const ix = i * 3;
    const jx = j * 3;
    const dx = x[ix]! - x[jx]!;
    const dy = x[ix + 1]! - x[jx + 1]!;
    const dz = x[ix + 2]! - x[jx + 2]!;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-12) continue;
    const lambda = -(len - set.rest[c]!) / (wsum + alpha);
    const s = lambda / len;
    x[ix] = x[ix]! + w[i]! * s * dx;
    x[ix + 1] = x[ix + 1]! + w[i]! * s * dy;
    x[ix + 2] = x[ix + 2]! + w[i]! * s * dz;
    x[jx] = x[jx]! - w[j]! * s * dx;
    x[jx + 1] = x[jx + 1]! - w[j]! * s * dy;
    x[jx + 2] = x[jx + 2]! - w[j]! * s * dz;
  }
}

/** Velocities from the substep's displacement. */
export function updateVelocities(p: Particles, h: number): void {
  const { x, prev, v } = p;
  const inv = 1 / h;
  for (let k = 0; k < p.count * 3; k++) v[k] = (x[k]! - prev[k]!) * inv;
}

/** Per-vertex unit normals of a triangle list over `x`, into `out` (float32, x y z per vertex). */
export function vertexNormals(x: Float64Array, indices: Uint32Array | Uint16Array, out: Float32Array): void {
  out.fill(0);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]! * 3;
    const b = indices[t + 1]! * 3;
    const c = indices[t + 2]! * 3;
    const e1x = x[b]! - x[a]!;
    const e1y = x[b + 1]! - x[a + 1]!;
    const e1z = x[b + 2]! - x[a + 2]!;
    const e2x = x[c]! - x[a]!;
    const e2y = x[c + 1]! - x[a + 1]!;
    const e2z = x[c + 2]! - x[a + 2]!;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    out[a] = out[a]! + nx; out[a + 1] = out[a + 1]! + ny; out[a + 2] = out[a + 2]! + nz;
    out[b] = out[b]! + nx; out[b + 1] = out[b + 1]! + ny; out[b + 2] = out[b + 2]! + nz;
    out[c] = out[c]! + nx; out[c + 1] = out[c + 1]! + ny; out[c + 2] = out[c + 2]! + nz;
  }
  for (let k = 0; k < out.length; k += 3) {
    const l = Math.hypot(out[k]!, out[k + 1]!, out[k + 2]!);
    if (l > 0) {
      out[k] = out[k]! / l;
      out[k + 1] = out[k + 1]! / l;
      out[k + 2] = out[k + 2]! / l;
    } else {
      out[k + 1] = 1;
    }
  }
}
