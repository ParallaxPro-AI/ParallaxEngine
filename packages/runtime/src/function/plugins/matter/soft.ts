/**
 * The soft layer of a solid: its particles simulated in the body's own frame with small-step
 * XPBD (the softbody plugin's solver, xpbd.ts), while the rigid body (physics3d) carries the
 * frame. What the particles feel is the frame's specific force — gravity minus the frame's
 * acceleration — so a clay block sags a little on the bench, squashes when it lands, sloshes
 * when its tray jerks and wobbles back; a gel does all of it a lot.
 *
 *   edges   every mesh edge keeps its rest length (stiffness from `softness`)
 *   volume  the enclosed volume stays the rest volume (incompressible: squashing bulges)
 *   shape   every particle is pulled back toward its rest position, a share per step
 *   bounds  particles stay within the rest box (bulging a little sideways), and never pass
 *           the face the body rests on, which the rigid collider holds up
 *
 * The collider stays rigid; this is how the solid looks and moves, not what it collides
 * with. A settled layer sleeps (no work, no geometry upload) until the frame's force
 * changes or something pushes it.
 */

import { compliance, DistanceSet, Particles, predict, solveDistances, updateVelocities } from './xpbd.js';
import { meshBounds, meshVolume } from './mesh.js';
import type { SolidMesh } from './mesh.js';

export interface SoftParams {
  /** 0 firm (hard wax) … 1 gel. */
  readonly softness: number;
  /** Share of velocity lost per second. */
  readonly damping: number;
}

const SUBSTEPS = 4;

export class SoftLayer {
  readonly mesh: SolidMesh;
  readonly p: Particles;
  readonly edges: DistanceSet;
  readonly restVolume: number;
  readonly min: [number, number, number];
  readonly max: [number, number, number];
  /** Unique particle triangles (vertex triangles mapped to particles), for the volume. */
  readonly ptris: Uint32Array;
  readonly #grad: Float64Array;
  readonly #force = new Float64Array(3);
  #still = 0;
  sleeping = false;

  constructor(mesh: SolidMesh) {
    this.mesh = mesh;
    const n = mesh.rest.length / 3;
    this.p = new Particles(n, 1);
    this.p.x.set(mesh.rest);
    this.p.prev.set(mesh.rest);
    // Skin and cut-face vertices share rim particles: the particle surface is closed.
    this.ptris = Uint32Array.from(mesh.tris, (v) => mesh.vp[v]!);
    const seen = new Set<number>();
    const pairs: [number, number][] = [];
    for (let t = 0; t < this.ptris.length; t += 3) {
      for (let e = 0; e < 3; e++) {
        const a = this.ptris[t + e]!;
        const b = this.ptris[t + ((e + 1) % 3)]!;
        if (a === b) continue;
        const key = a < b ? a * n + b : b * n + a;
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push(a < b ? [a, b] : [b, a]);
      }
    }
    this.edges = new DistanceSet(pairs, mesh.rest);
    const ident = new Uint32Array(n);
    for (let i = 0; i < n; i++) ident[i] = i;
    this.restVolume = meshVolume(mesh.rest, ident, this.ptris);
    [this.min, this.max] = meshBounds(mesh.rest);
    this.#grad = new Float64Array(n * 3);
  }

  /** Wake it (a push, a cut, a sharp change of force). */
  wake(): void {
    this.sleeping = false;
    this.#still = 0;
  }

  /**
   * One fixed step. `force` is the specific force in the body's frame (m/s²: gravity minus
   * the frame's acceleration); `down` the frame's unit direction of world down. Returns
   * whether the particles moved (the geometry needs rewriting).
   */
  step(dt: number, force: readonly [number, number, number], down: readonly [number, number, number], params: SoftParams): boolean {
    const f = this.#force;
    const change = Math.hypot(force[0] - f[0]!, force[1] - f[1]!, force[2] - f[2]!);
    f[0] = force[0];
    f[1] = force[1];
    f[2] = force[2];
    if (change > 0.4) this.wake();
    if (this.sleeping) return false;
    const soft = Math.min(1, Math.max(0, params.softness));
    this.edges.compliance = compliance(0.97 - 0.6 * soft);
    // Pull back per substep so the response doesn't depend on the substep count.
    const perStep = 0.55 * (1 - soft) + 0.025 * soft;
    const shape = 1 - Math.pow(1 - perStep, 1 / SUBSTEPS);
    const h = dt / SUBSTEPS;
    const p = this.p;
    const a = p.a;
    for (let i = 0; i < p.count; i++) {
      a[i * 3] = force[0];
      a[i * 3 + 1] = force[1];
      a[i * 3 + 2] = force[2];
    }
    // The face it rests on: the rest box's face most nearly facing world down.
    let axis = 0;
    for (let k = 1; k < 3; k++) if (Math.abs(down[k]!) > Math.abs(down[axis]!)) axis = k;
    const low = down[axis]! < 0;
    const ext = [this.max[0] - this.min[0], this.max[1] - this.min[1], this.max[2] - this.min[2]];
    const bulge = 0.04 + 0.1 * soft;
    let maxV = 0;
    for (let s = 0; s < SUBSTEPS; s++) {
      predict(p, h, 0, params.damping);
      solveDistances(p, this.edges, h);
      this.#solveVolume(this.restVolume);
      this.#matchShape(shape);
      const x = p.x;
      for (let i = 0; i < p.count; i++) {
        for (let k = 0; k < 3; k++) {
          const m = ext[k]! * bulge;
          let lo = this.min[k]! - m;
          let hi = this.max[k]! + m;
          if (k === axis) {
            if (low) lo = this.min[k]!;
            else hi = this.max[k]!;
          }
          const v = x[i * 3 + k]!;
          if (v < lo) x[i * 3 + k] = lo;
          else if (v > hi) x[i * 3 + k] = hi;
        }
      }
      updateVelocities(p, h);
    }
    const v = p.v;
    for (let k = 0; k < v.length; k++) maxV = Math.max(maxV, Math.abs(v[k]!));
    if (maxV < 2e-4) {
      if (++this.#still > 15) this.sleeping = true;
    } else {
      this.#still = 0;
    }
    return true;
  }

  /** Change the velocity of particles within `radius` of `at` (local), fading out; all for radius ≤ 0. */
  push(at: readonly [number, number, number] | null, dv: readonly [number, number, number], radius: number): void {
    const { x, v } = this.p;
    for (let i = 0; i < this.p.count; i++) {
      let f = 1;
      if (at !== null && radius > 0) {
        const d = Math.hypot(x[i * 3]! - at[0], x[i * 3 + 1]! - at[1], x[i * 3 + 2]! - at[2]);
        if (d >= radius) continue;
        f = 1 - d / radius;
      }
      v[i * 3] = v[i * 3]! + dv[0] * f;
      v[i * 3 + 1] = v[i * 3 + 1]! + dv[1] * f;
      v[i * 3 + 2] = v[i * 3 + 2]! + dv[2] * f;
    }
    this.wake();
  }

  /** Largest distance of any particle from its rest position (m). */
  deformation(): number {
    const { x } = this.p;
    const r = this.mesh.rest;
    let out = 0;
    for (let k = 0; k < x.length; k += 3) out = Math.max(out, Math.hypot(x[k]! - r[k]!, x[k + 1]! - r[k + 1]!, x[k + 2]! - r[k + 2]!));
    return out;
  }

  #matchShape(stiffness: number): void {
    const { x } = this.p;
    const r = this.mesh.rest;
    for (let k = 0; k < x.length; k++) x[k] = x[k]! + (r[k]! - x[k]!) * stiffness;
  }

  #solveVolume(target: number): void {
    const { x, w } = this.p;
    const g = this.#grad;
    g.fill(0);
    const ix = this.ptris;
    let vol = 0;
    for (let t = 0; t < ix.length; t += 3) {
      const a = ix[t]! * 3;
      const b = ix[t + 1]! * 3;
      const c = ix[t + 2]! * 3;
      vol += (x[a]! * (x[b + 1]! * x[c + 2]! - x[b + 2]! * x[c + 1]!)
        - x[a + 1]! * (x[b]! * x[c + 2]! - x[b + 2]! * x[c]!)
        + x[a + 2]! * (x[b]! * x[c + 1]! - x[b + 1]! * x[c]!)) / 6;
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
    for (let i = 0; i < this.p.count; i++) denom += w[i]! * (g[i * 3]! ** 2 + g[i * 3 + 1]! ** 2 + g[i * 3 + 2]! ** 2);
    if (denom < 1e-24) return;
    const lambda = -(vol - target) / denom;
    for (let i = 0; i < this.p.count; i++) {
      const s = lambda * w[i]!;
      x[i * 3] = x[i * 3]! + s * g[i * 3]!;
      x[i * 3 + 1] = x[i * 3 + 1]! + s * g[i * 3 + 1]!;
      x[i * 3 + 2] = x[i * 3 + 2]! + s * g[i * 3 + 2]!;
    }
  }
}
