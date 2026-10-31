/**
 * Flocks, shoals and ambient crowds: boids. Every fixed step each `Flock` entity steers by
 *
 *   cohesion     toward its neighbors' center      (within neighbor_radius, same group)
 *   alignment    toward their mean velocity
 *   separation   away from those within separation_radius (stronger the closer)
 *   wander       a small random push (the AI's seeded stream)
 *   home         back toward `home` once farther than home_radius (soft leash)
 *   avoid        away from entities tagged `avoid` within avoid_radius (predators), × flee
 *
 * The sum is capped at `acceleration` (m/s²), the speed kept in [min_speed, max_speed],
 * and the entity moved and turned to face its velocity (steering straight against the
 * velocity turns it rather than stopping it). `flat` keeps it on its height
 * (ground crowds, fish in a band). Neighbors come from a spatial hash, so a few hundred
 * boids stay cheap; iteration is in world order, so a flock is deterministic. Flocks move
 * transforms directly: they don't collide (give obstacles a home leash instead).
 */

import { Quat, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import type { Fields, Kernel } from '../../kernel/index.js';
import type { Json } from '../../../resource/index.js';
import { FLOCK } from './schemas.js';

interface Boid {
  readonly id: EntityId;
  readonly f: Fields;
  p: Vec3;
  v: Vec3;
}

function tagId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  const id = (value as { __tag_id__?: unknown }).__tag_id__;
  return typeof id === 'string' ? id : null;
}

export class Flocks {
  readonly #kernel: Kernel;
  readonly #velocity = new Map<EntityId, Vec3>();

  constructor(kernel: Kernel) {
    this.#kernel = kernel;
  }

  clear(): void {
    this.#velocity.clear();
  }

  removed(id: EntityId): void {
    this.#velocity.delete(id);
  }

  velocity(id: EntityId): Vec3 {
    return this.#velocity.get(id) ?? Vec3.ZERO;
  }

  /** Push a boid (a scare, a current): adds to its velocity now. */
  push(id: EntityId, impulse: Vec3): void {
    this.#velocity.set(id, this.velocity(id).__add__(impulse));
  }

  step(dt: number, random: () => number): void {
    const world = this.#kernel.world;
    const groups = new Map<string, Boid[]>();
    for (const [id, fields] of world.query([FLOCK])) {
      const f = fields!;
      const record = world.require(id);
      let v = this.#velocity.get(id);
      if (v === undefined) {
        // A first heading: the way it faces, at its minimum speed.
        const forward = record.transform.worldRotation().rotate(Vec3.FORWARD);
        v = (f['flat'] === true ? new Vec3(forward.x, 0, forward.z) : forward).normalized().__mul__(Math.max(f['min_speed'] as number, 1e-3));
      }
      const group = f['group'] as string;
      const list = groups.get(group) ?? [];
      list.push({ id, f, p: record.transform.worldPosition(), v });
      groups.set(group, list);
    }
    const predators = new Map<string, Vec3[]>();
    const predatorsOf = (tag: string): Vec3[] => {
      let list = predators.get(tag);
      if (list === undefined) {
        list = [...world.live()].filter((r) => r.tags.has(tag)).map((r) => r.transform.worldPosition());
        predators.set(tag, list);
      }
      return list;
    };
    for (const boids of groups.values()) this.#group(boids, dt, random, predatorsOf);
  }

  #group(boids: Boid[], dt: number, random: () => number, predatorsOf: (tag: string) => Vec3[]): void {
    const cell = Math.max(1e-3, ...boids.map((b) => b.f['neighbor_radius'] as number));
    const hash = new Map<string, Boid[]>();
    const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;
    for (const b of boids) {
      const k = key(Math.floor(b.p.x / cell), Math.floor(b.p.y / cell), Math.floor(b.p.z / cell));
      const list = hash.get(k) ?? [];
      list.push(b);
      hash.set(k, list);
    }
    const next: { b: Boid; v: Vec3 }[] = [];
    for (const b of boids) {
      const f = b.f;
      const nr = f['neighbor_radius'] as number;
      const sr = f['separation_radius'] as number;
      const flat = f['flat'] === true;
      let cx = 0; let cy = 0; let cz = 0;
      let ax = 0; let ay = 0; let az = 0;
      let sx = 0; let sy = 0; let sz = 0;
      let n = 0;
      const bx = Math.floor(b.p.x / cell); const by = Math.floor(b.p.y / cell); const bz = Math.floor(b.p.z / cell);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) {
        for (const o of hash.get(key(bx + i, by + j, bz + k)) ?? []) {
          if (o === b) continue;
          const dx = o.p.x - b.p.x; const dy = o.p.y - b.p.y; const dz = o.p.z - b.p.z;
          const d = Math.hypot(dx, flat ? 0 : dy, dz);
          if (d > nr) continue;
          n++;
          cx += o.p.x; cy += o.p.y; cz += o.p.z;
          ax += o.v.x; ay += o.v.y; az += o.v.z;
          if (d < sr) {
            // Coincident boids part along an id-ordered axis.
            const w = (sr - d) / Math.max(sr, 1e-9) / Math.max(d, 1e-3);
            sx -= (d > 1e-9 ? dx : (b.id < o.id ? -1 : 1) * 1e-3) * w;
            sy -= dy * w;
            sz -= dz * w;
          }
        }
      }
      let fx = 0; let fy = 0; let fz = 0;
      const max = f['max_speed'] as number;
      if (n > 0) {
        const coh = f['cohesion'] as number;
        fx += (cx / n - b.p.x) * coh; fy += (cy / n - b.p.y) * coh; fz += (cz / n - b.p.z) * coh;
        const ali = f['alignment'] as number;
        fx += (ax / n - b.v.x) * ali; fy += (ay / n - b.v.y) * ali; fz += (az / n - b.v.z) * ali;
        const sep = (f['separation'] as number) * max;
        fx += sx * sep; fy += sy * sep; fz += sz * sep;
      }
      const wander = (f['wander'] as number) * max;
      if (wander > 0) {
        fx += (random() * 2 - 1) * wander;
        fy += (random() * 2 - 1) * wander;
        fz += (random() * 2 - 1) * wander;
      }
      const home = f['home'];
      if (home instanceof Vec3) {
        const hr = f['home_radius'] as number;
        const dx = home.x - b.p.x; const dy = home.y - b.p.y; const dz = home.z - b.p.z;
        const d = Math.hypot(dx, flat ? 0 : dy, dz);
        if (d > hr && d > 1e-9) {
          const w = ((d - hr) / Math.max(hr, 1)) * 2 * max;
          fx += (dx / d) * w; fy += (dy / d) * w; fz += (dz / d) * w;
        }
      }
      const avoid = tagId(f['avoid']);
      if (avoid !== null) {
        const r = f['avoid_radius'] as number;
        const flee = (f['flee'] as number) * max;
        for (const p of predatorsOf(avoid)) {
          const dx = b.p.x - p.x; const dy = b.p.y - p.y; const dz = b.p.z - p.z;
          const d = Math.hypot(dx, flat ? 0 : dy, dz);
          if (d >= r || d < 1e-9) continue;
          const w = (1 - d / r) * flee * 2;
          fx += (dx / d) * w; fy += (dy / d) * w; fz += (dz / d) * w;
        }
      }
      if (flat) fy = 0;
      // Steering straight against the velocity would only brake (and min_speed forbids
      // stopping): turn instead, to the side the id picks.
      const vl = Math.hypot(b.v.x, b.v.y, b.v.z);
      const sl = Math.hypot(fx, fy, fz);
      if (vl > 1e-9 && sl > 1e-9 && (fx * b.v.x + fy * b.v.y + fz * b.v.z) / (vl * sl) < -0.98) {
        const side = b.id % 2 === 0 ? 1 : -1;
        fx += (b.v.z / vl) * sl * side;
        fz += (-b.v.x / vl) * sl * side;
      }
      const accel = f['acceleration'] as number;
      const fl = Math.hypot(fx, fy, fz);
      if (fl > accel && fl > 0) {
        fx *= accel / fl; fy *= accel / fl; fz *= accel / fl;
      }
      let vx = b.v.x + fx * dt; let vy = flat ? 0 : b.v.y + fy * dt; let vz = b.v.z + fz * dt;
      const speed = Math.hypot(vx, vy, vz);
      const min = Math.min(f['min_speed'] as number, max);
      const target = Math.min(max, Math.max(min, speed));
      if (speed > 1e-9) {
        vx *= target / speed; vy *= target / speed; vz *= target / speed;
      } else if (min > 0) {
        vx = 0; vy = 0; vz = min;
      }
      next.push({ b, v: new Vec3(vx, vy, vz) });
    }
    // Move after every boid has steered, so the order within a group doesn't matter.
    for (const { b, v } of next) {
      this.#velocity.set(b.id, v);
      const record = this.#kernel.world.require(b.id);
      record.transform.setWorldPosition(b.p.__add__(v.__mul__(dt)));
      if (v.length() > 1e-6 && record.parent === null) record.transform.rotation = Quat.look_rotation(v);
    }
  }

  snapshot(): Json {
    return [...this.#velocity].map(([id, v]) => [id, v.x, v.y, v.z]);
  }

  restore(json: Json, alive: (id: EntityId) => boolean): void {
    this.#velocity.clear();
    for (const [id, x, y, z] of json as [EntityId, number, number, number][]) if (alive(id)) this.#velocity.set(id, new Vec3(x, y, z));
  }
}
