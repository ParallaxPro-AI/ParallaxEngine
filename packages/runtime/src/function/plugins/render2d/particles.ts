/**
 * Particle emitters, simulated in world space in game time (they pause with the game).
 * Deterministic: every random draw comes from one seeded generator, in emitter order, so
 * the same frames produce the same particles — and a snapshot holds the generator and
 * every live particle, so a restore continues exactly.
 *
 * Within a frame, live particles move first, then new ones are emitted at age 0 at the
 * emitter's current position. Particles outlive their emitter: when an emitting entity is
 * torn down, what it already emitted finishes its life.
 */

import { PARTICLE_STRIDE, SeededRandom, fail } from '../../../core/index.js';
import type { EntityId, ParticlesDraw, RandomState, Rgba, Ripple2d } from '../../../core/index.js';
import type { Json } from '../../../resource/index.js';
import type { EffectDef, EffectLibrary, Range } from './effects.js';

/** Numbers per live particle: x, y, vx, vy, age, life, size0, size1, angle, spin. */
const P = 10;

export interface OneShot {
  readonly x: number;
  readonly y: number;
  /** Draw order; null draws above everything (a point given without a z). */
  readonly z: number | null;
  /** Replaces the effect's color (start and end keep their own alpha). */
  readonly color: Rgba | null;
  readonly scale: number;
  /** Degrees; replaces the effect's direction. */
  readonly direction: number | null;
  /** Replaces the end colour the effect fades to (`play(color_end=)`); null: the effect's, tinted by `color`. */
  readonly colorEnd?: Rgba | null;
  /** How many particles the effect emits in all (its burst and rate scaled to it); null: the effect's own. */
  readonly count?: number | null;
}

/** What a continuous emitter reads from its `particles` component each frame. */
export interface EmitterSource {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly emitting: boolean;
  readonly rateScale: number;
}

class Emitter {
  readonly def: EffectDef;
  readonly ref: string;
  /** The emitting entity (continuous emitters); null for one-shots. */
  entity: EntityId | null;
  /** The color `play(color=)` gave, kept for snapshots. */
  readonly override: Rgba | null;
  readonly color: Rgba;
  readonly colorEnd: Rgba | null;
  /** `play(color_end=)`, kept for snapshots. */
  readonly overrideEnd: Rgba | null;
  /** × the effect's burst and rate (`play(count=)`); 1 = as authored. */
  readonly amount: number;
  readonly scale: number;
  readonly direction: number;
  x: number;
  y: number;
  z: number | null;
  /** Seconds since a one-shot started. */
  elapsed = 0;
  /** Fractional particles owed by `rate`. */
  carry = 0;
  /** Was emitting last frame (a burst fires when emission starts). */
  wasEmitting = false;
  /** A one-shot's burst is still to come. */
  pendingBurst: boolean;
  /** The entity was torn down: emit no more, finish what is alive. */
  orphaned = false;
  particles: number[] = [];

  constructor(def: EffectDef, ref: string, entity: EntityId | null, x: number, y: number, z: number | null,
    color: Rgba | null, scale: number, direction: number | null, colorEnd: Rgba | null = null, amount = 1) {
    this.def = def;
    this.ref = ref;
    this.entity = entity;
    this.x = x;
    this.y = y;
    this.z = z;
    this.override = color;
    this.color = color === null ? def.color : [color[0], color[1], color[2], def.color[3] * color[3]];
    this.colorEnd = colorEnd !== null ? [colorEnd[0], colorEnd[1], colorEnd[2], (def.colorEnd ?? def.color)[3] * colorEnd[3]]
      : def.colorEnd === null || color === null
        ? def.colorEnd
        : [color[0], color[1], color[2], def.colorEnd[3] * color[3]];
    this.overrideEnd = colorEnd;
    this.amount = amount;
    this.scale = scale;
    this.direction = direction ?? def.direction;
    this.pendingBurst = entity === null;
  }

  get count(): number {
    return this.particles.length / P;
  }
}

/**
 * `play(count=)` as a multiplier of the effect's burst and rate: the one-shot then emits about
 * `count` particles in all. An effect that emits none on its own stays empty.
 */
export function countAmount(def: { readonly burst: number; readonly rate: number; readonly duration: number }, count: number | null): number {
  if (count === null) return 1;
  const total = def.burst + def.rate * def.duration;
  return total > 0 ? count / total : 1;
}

function pick(random: SeededRandom, range: Range): number {
  return range.lo === range.hi ? range.lo : range.lo + (range.hi - range.lo) * random.next();
}

interface SavedEmitter {
  readonly ref: string;
  readonly entity: number | null;
  readonly override: Rgba | null;
  /** `play(color_end=)` and `count=`'s multiplier (absent in older snapshots: none, 1). */
  readonly overrideEnd?: Rgba | null;
  readonly amount?: number;
  readonly scale: number;
  readonly direction: number;
  readonly x: number;
  readonly y: number;
  readonly z: number | null;
  readonly elapsed: number;
  readonly carry: number;
  readonly wasEmitting: boolean;
  readonly pendingBurst: boolean;
  readonly orphaned: boolean;
  readonly particles: number[];
}

/** A one-shot's shockwave (its effect's `haze`), growing in game time. */
interface Ripple {
  readonly x: number;
  readonly y: number;
  /** Meters it grows to (the effect's radius × play scale). */
  readonly radius: number;
  readonly ring: number;
  readonly strength: number;
  readonly seconds: number;
  elapsed: number;
}

export interface ParticlesState {
  readonly random: RandomState;
  readonly emitters: SavedEmitter[];
  /** Shockwaves still growing (absent in older snapshots). */
  readonly ripples?: readonly Ripple[];
}

export class ParticleSystem {
  readonly #effects: EffectLibrary;
  #random = new SeededRandom(0);
  #emitters: Emitter[] = [];
  #ripples: Ripple[] = [];
  /** Continuous emitters by entity. */
  readonly #byEntity = new Map<EntityId, Emitter>();

  constructor(effects: EffectLibrary) {
    this.#effects = effects;
  }

  /** A scene load: every effect ends, and the generator is reseeded. */
  reset(seed: number): void {
    this.#random = new SeededRandom(seed);
    this.#emitters = [];
    this.#ripples = [];
    this.#byEntity.clear();
  }

  /** Start a one-shot effect. Its particles appear on the next render. */
  play(ref: string, shot: OneShot, where: string): void {
    const def = this.#effects.get(ref, where);
    this.#emitters.push(new Emitter(def, ref, null, shot.x, shot.y, shot.z, shot.color, shot.scale, shot.direction, shot.colorEnd ?? null, countAmount(def, shot.count ?? null)));
    const h = def.haze;
    if (h !== null && h.radius > 0 && h.strength > 0) {
      this.#ripples.push({ x: shot.x, y: shot.y, radius: h.radius * shot.scale, ring: h.ring, strength: h.strength, seconds: h.seconds, elapsed: 0 });
    }
  }

  /** Make sure `entity` has an emitter for `ref` (a changed effect replaces it). */
  attach(entity: EntityId, ref: string, where: string): void {
    const current = this.#byEntity.get(entity);
    if (current !== undefined && current.ref === ref) return;
    const def = this.#effects.get(ref, where);
    if (current !== undefined) this.detach(entity);
    const emitter = new Emitter(def, ref, entity, 0, 0, 0, null, 1, null);
    this.#byEntity.set(entity, emitter);
    this.#emitters.push(emitter);
  }

  /** The entity lost its emitter (component removed, entity torn down): live particles finish. */
  detach(entity: EntityId): void {
    const emitter = this.#byEntity.get(entity);
    if (emitter === undefined) return;
    emitter.orphaned = true;
    emitter.entity = null;
    this.#byEntity.delete(entity);
  }

  /** Entities that have a continuous emitter. */
  emitterEntities(): EntityId[] {
    return [...this.#byEntity.keys()];
  }

  /** Advance every emitter by `dt` game seconds. `source` reads a continuous emitter's entity. */
  step(dt: number, source: (entity: EntityId) => EmitterSource): void {
    for (const r of this.#ripples) r.elapsed += dt;
    this.#ripples = this.#ripples.filter((r) => r.elapsed < r.seconds);
    for (const emitter of this.#emitters) {
      this.#move(emitter, dt);
      if (emitter.orphaned) continue;
      if (emitter.entity === null) this.#emitOneShot(emitter, dt);
      else this.#emitContinuous(emitter, dt, source(emitter.entity));
    }
    this.#emitters = this.#emitters.filter((e) => e.count > 0 || (!e.orphaned && (e.entity !== null || this.#oneShotEmitting(e))));
  }

  /** One draw command per emitter with live particles, in emitter order. */
  draws(): ParticlesDraw[] {
    const out: ParticlesDraw[] = [];
    for (const emitter of this.#emitters) {
      const n = emitter.count;
      if (n === 0) continue;
      const data: number[] = new Array<number>(n * PARTICLE_STRIDE);
      const ps = emitter.particles;
      const c0 = emitter.color;
      const c1 = emitter.colorEnd ?? c0;
      for (let i = 0; i < n; i++) {
        const p = i * P;
        const t = ps[p + 4]! / ps[p + 5]!;
        const o = i * PARTICLE_STRIDE;
        data[o] = ps[p]!;
        data[o + 1] = ps[p + 1]!;
        data[o + 2] = ps[p + 6]! + (ps[p + 7]! - ps[p + 6]!) * t;
        data[o + 3] = ps[p + 8]!;
        data[o + 4] = c0[0] + (c1[0] - c0[0]) * t;
        data[o + 5] = c0[1] + (c1[1] - c0[1]) * t;
        data[o + 6] = c0[2] + (c1[2] - c0[2]) * t;
        data[o + 7] = c0[3] + (c1[3] - c0[3]) * t;
      }
      out.push({
        kind: 'particles', z: emitter.z ?? Infinity, entity: emitter.entity, shape: emitter.def.shape, image: emitter.def.image,
        ...(emitter.def.blend === 'additive' && { blend: 'additive' as const }), count: n, data,
      });
    }
    return out;
  }

  /** The shockwaves growing now: each ring reaches its radius over its seconds, fading as it goes. */
  ripples(): Ripple2d[] {
    return this.#ripples.map((r) => {
      const t = r.elapsed / r.seconds;
      const radius = Math.max(0.01, r.radius * t);
      return { x: r.x, y: r.y, radius, width: Math.max(0.01, r.radius * r.ring), strength: r.strength * (1 - t) * (1 - t) };
    });
  }

  /** Live particles across every emitter (tests, budgets). */
  get liveParticles(): number {
    return this.#emitters.reduce((n, e) => n + e.count, 0);
  }

  get activeEffects(): number {
    return this.#emitters.length;
  }

  snapshot(): ParticlesState {
    return {
      random: this.#random.state(),
      emitters: this.#emitters.map((e) => ({
        ref: e.ref,
        entity: e.entity,
        override: e.override,
        ...(e.overrideEnd !== null && { overrideEnd: e.overrideEnd }),
        ...(e.amount !== 1 && { amount: e.amount }),
        scale: e.scale,
        direction: e.direction,
        x: e.x, y: e.y, z: e.z,
        elapsed: e.elapsed,
        carry: e.carry,
        wasEmitting: e.wasEmitting,
        pendingBurst: e.pendingBurst,
        orphaned: e.orphaned,
        particles: [...e.particles],
      })),
      ...(this.#ripples.length > 0 && { ripples: this.#ripples.map((r) => ({ ...r })) }),
    };
  }

  restore(state: ParticlesState, alive: (entity: EntityId) => boolean): void {
    this.#random = new SeededRandom(0);
    this.#random.restore(state.random);
    this.#emitters = [];
    this.#ripples = (state.ripples ?? []).map((r) => ({ ...r }));
    this.#byEntity.clear();
    for (const saved of state.emitters) {
      const def = this.#effects.get(saved.ref, 'a restored effect');
      const emitter = new Emitter(def, saved.ref, saved.entity as EntityId | null, saved.x, saved.y, saved.z,
        saved.override, saved.scale, saved.direction, saved.overrideEnd ?? null, saved.amount ?? 1);
      Object.assign(emitter, {
        elapsed: saved.elapsed, carry: saved.carry, wasEmitting: saved.wasEmitting, pendingBurst: saved.pendingBurst,
        orphaned: saved.orphaned, particles: [...saved.particles],
      });
      if (emitter.entity !== null) {
        if (alive(emitter.entity)) {
          this.#byEntity.set(emitter.entity, emitter);
        } else {
          emitter.orphaned = true;
          emitter.entity = null;
        }
      }
      this.#emitters.push(emitter);
    }
  }

  #oneShotEmitting(e: Emitter): boolean {
    return e.pendingBurst || (e.def.rate > 0 && e.elapsed < e.def.duration);
  }

  #move(e: Emitter, dt: number): void {
    if (dt === 0 || e.count === 0) return;
    const { drag } = e.def;
    const [gx, gy] = e.def.gravity;
    const keep = Math.max(0, 1 - drag * dt);
    const ps = e.particles;
    let write = 0;
    for (let read = 0; read < ps.length; read += P) {
      const age = ps[read + 4]! + dt;
      if (age >= ps[read + 5]!) continue;
      const vx = ps[read + 2]! * keep + gx * dt;
      const vy = ps[read + 3]! * keep + gy * dt;
      ps[write] = ps[read]! + vx * dt;
      ps[write + 1] = ps[read + 1]! + vy * dt;
      ps[write + 2] = vx;
      ps[write + 3] = vy;
      ps[write + 4] = age;
      ps[write + 5] = ps[read + 5]!;
      ps[write + 6] = ps[read + 6]!;
      ps[write + 7] = ps[read + 7]!;
      ps[write + 8] = ps[read + 8]! + ps[read + 9]! * dt;
      ps[write + 9] = ps[read + 9]!;
      write += P;
    }
    ps.length = write;
  }

  #emitOneShot(e: Emitter, dt: number): void {
    if (e.pendingBurst) {
      e.pendingBurst = false;
      this.#spawn(e, Math.round(e.def.burst * e.amount));
      if (e.def.rate > 0 && e.def.duration > 0) this.#spawn(e, this.#owed(e, e.def.rate * e.amount, Math.min(dt, e.def.duration)));
      e.elapsed = dt;
      return;
    }
    if (e.def.rate === 0 || e.elapsed >= e.def.duration) return;
    const window = Math.min(dt, e.def.duration - e.elapsed);
    e.elapsed += dt;
    this.#spawn(e, this.#owed(e, e.def.rate * e.amount, window));
  }

  #emitContinuous(e: Emitter, dt: number, src: EmitterSource): void {
    e.x = src.x;
    e.y = src.y;
    e.z = src.z;
    if (!Number.isFinite(src.rateScale) || src.rateScale < 0) {
      fail('PP3602', `particles.rate_scale is ${src.rateScale}; it must be 0 or more`, { fix: 'Set rate_scale to a number ≥ 0.' });
    }
    if (src.emitting && !e.wasEmitting) this.#spawn(e, e.def.burst);
    if (src.emitting) this.#spawn(e, this.#owed(e, e.def.rate * src.rateScale, dt));
    else e.carry = 0;
    e.wasEmitting = src.emitting;
  }

  #owed(e: Emitter, rate: number, seconds: number): number {
    const total = e.carry + rate * seconds;
    const whole = Math.floor(total);
    e.carry = total - whole;
    return whole;
  }

  #spawn(e: Emitter, count: number): void {
    if (count <= 0) return;
    const def = e.def;
    const r = this.#random;
    const s = e.scale;
    for (let i = 0; i < count; i++) {
      const heading = ((e.direction + (r.next() - 0.5) * def.spread) * Math.PI) / 180;
      const speed = pick(r, def.speed) * s;
      const at = Math.sqrt(r.next()) * def.radius * s;
      const around = r.next() * Math.PI * 2;
      const size0 = pick(r, def.size) * s;
      e.particles.push(
        e.x + Math.cos(around) * at, e.y + Math.sin(around) * at,
        Math.cos(heading) * speed, Math.sin(heading) * speed,
        0, pick(r, def.lifetime),
        size0, def.sizeEnd === null ? size0 : def.sizeEnd * s,
        0, pick(r, def.spin),
      );
    }
    const over = e.count - def.max;
    if (over > 0) e.particles.splice(0, over * P);
  }
}

/** Snapshot data back to its typed form (it was produced by `snapshot`). */
export function particlesState(json: Json): ParticlesState {
  return json as unknown as ParticlesState;
}
