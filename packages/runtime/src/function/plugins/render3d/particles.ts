/**
 * 3D particle emitters, simulated in world space in game time. Deterministic: every
 * random draw comes from one seeded generator, in emitter order; a snapshot holds the
 * generator and every live particle, so a restore continues exactly. Turbulence is a pure
 * function of a particle's position and age (no draws).
 *
 * Within a frame, live particles move first (those that die may play their effect's
 * `on_death`), then new ones are emitted at age 0 at the emitter's current position.
 * Particles outlive their emitter: when an emitting entity is torn down, what it already
 * emitted finishes its life.
 *
 * A one-shot (`play`) also plays its effect's children (each its own one-shot, after its
 * delay), and when it bursts reports an event (its sound and camera shake: the engine's).
 * Its light and haze are worked out from the time since the burst (`lights`, `hazes`).
 */

import { fail, PARTICLE3D_STRIDE, SeededRandom } from '../../../core/index.js';
import type { EntityId, RandomState, Rgba } from '../../../core/index.js';
import type { Json } from '../../../resource/index.js';
import type { EffectDef, EffectLibrary, Range } from './effects.js';

/** Numbers per live particle: x, y, z, vx, vy, vz, age, life, size0, size1, angle, spin. */
const P = 12;
/** Emitters alive at once at most; `on_death` effects past it are dropped (a runaway chain). */
const MAX_EMITTERS = 1024;

type Point = readonly [number, number, number];

export interface OneShot {
  readonly position: Point;
  readonly color: Rgba | null;
  readonly scale: number;
  /** Unit axis replacing the effect's direction. */
  readonly direction: Point | null;
  /** Replaces the end colour the effect fades to (`play(color_end=)`); null: the effect's, tinted by `color`. */
  readonly colorEnd?: Rgba | null;
  /** How many particles the effect emits in all (its burst and rate scaled to it); null: the effect's own. */
  readonly count?: number | null;
}

export interface EmitterSource {
  readonly position: Point;
  readonly emitting: boolean;
  readonly rateScale: number;
}

/** One emitter's particles, ready to draw (`PARTICLE3D_STRIDE` numbers each). */
export interface ParticleDraw {
  readonly entity: EntityId | null;
  readonly def: EffectDef;
  readonly count: number;
  readonly data: Float32Array;
  /** The emitter's distance from the eye `draws` was given (0 without one). */
  readonly distance: number;
}

/** A one-shot bursting, or a continuous emitter starting to emit: its sound and camera shake play here. */
export interface EffectEvent {
  readonly def: EffectDef;
  readonly position: Point;
  readonly scale: number;
  readonly entity: EntityId | null;
}

export interface EffectLightNow {
  readonly position: Point;
  readonly color: Rgba;
  readonly intensity: number;
  readonly range: number;
  readonly entity: EntityId | null;
}

export interface EffectHazeNow {
  readonly position: Point;
  readonly radius: number;
  readonly strength: number;
  readonly ring: number;
}

/** A continuous emitter with a sound, emitting now (its loop plays). */
export interface EffectLoop {
  readonly entity: EntityId;
  readonly sound: string;
  readonly position: Point;
}

class Emitter {
  readonly def: EffectDef;
  readonly ref: string;
  entity: EntityId | null;
  readonly override: Rgba | null;
  readonly color: Rgba;
  readonly colorEnd: Rgba | null;
  /** `play(color_end=)`, kept for snapshots. */
  readonly overrideEnd: Rgba | null;
  /** × the effect's burst and rate (`play(count=)`); 1 = as authored. */
  readonly amount: number;
  readonly scale: number;
  readonly axis: Point;
  position: [number, number, number];
  /** One-shots: seconds since emission began (negative during a delay). Continuous: seconds emitting. */
  elapsed = 0;
  carry = 0;
  wasEmitting = false;
  pendingBurst: boolean;
  orphaned = false;
  particles: number[] = [];

  constructor(def: EffectDef, ref: string, entity: EntityId | null, position: Point, color: Rgba | null, scale: number, axis: Point | null,
    colorEnd: Rgba | null = null, amount = 1) {
    this.def = def;
    this.ref = ref;
    this.entity = entity;
    this.position = [position[0], position[1], position[2]];
    this.override = color;
    this.color = color === null ? def.color : [color[0], color[1], color[2], def.color[3] * color[3]];
    this.colorEnd = colorEnd !== null ? [colorEnd[0], colorEnd[1], colorEnd[2], (def.colorEnd ?? def.color)[3] * colorEnd[3]]
      : def.colorEnd === null || color === null ? def.colorEnd : [color[0], color[1], color[2], def.colorEnd[3] * color[3]];
    this.overrideEnd = colorEnd;
    this.amount = amount;
    this.scale = scale;
    const d = (def.direction * Math.PI) / 180;
    this.axis = axis ?? [Math.cos(d), Math.sin(d), 0];
    this.pendingBurst = entity === null;
    if (entity === null) this.elapsed = -def.delay;
  }

  get count(): number {
    return this.particles.length / P;
  }
}

function pick(random: SeededRandom, range: Range): number {
  return range.lo === range.hi ? range.lo : range.lo + (range.hi - range.lo) * random.next();
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

/** How long a one-shot's light and haze outlast its burst. */
function afterglow(def: EffectDef): number {
  return Math.max(def.light?.seconds ?? 0, def.haze !== null && def.haze.ring > 0 ? def.haze.seconds : 0);
}

// ── Smooth noise (turbulence, flicker): pure functions of their inputs ─────────

function hash3(x: number, y: number, z: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(z, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Value noise in -1..1. */
function noise3(x: number, y: number, z: number): number {
  const xi = Math.floor(x); const yi = Math.floor(y); const zi = Math.floor(z);
  const fx = x - xi; const fy = y - yi; const fz = z - zi;
  const u = fx * fx * (3 - 2 * fx); const v = fy * fy * (3 - 2 * fy); const w = fz * fz * (3 - 2 * fz);
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number): number => hash3(xi + dx, yi + dy, zi + dz);
  const n = lerp(
    lerp(lerp(c(0, 0, 0), c(1, 0, 0), u), lerp(c(0, 1, 0), c(1, 1, 0), u), v),
    lerp(lerp(c(0, 0, 1), c(1, 0, 1), u), lerp(c(0, 1, 1), c(1, 1, 1), u), v), w);
  return n * 2 - 1;
}

/** 1 - flicker × (0..1 of smooth noise over time). */
function flickerAt(flicker: number, t: number): number {
  return flicker === 0 ? 1 : 1 - flicker * (0.5 + 0.5 * noise3(t * 9, 0.5, 7.5));
}

interface SavedEmitter {
  readonly ref: string;
  readonly entity: number | null;
  readonly override: Rgba | null;
  /** `play(color_end=)` and `count=`'s multiplier (absent in older snapshots: none, 1). */
  readonly overrideEnd?: Rgba | null;
  readonly amount?: number;
  readonly scale: number;
  readonly axis: Point;
  readonly position: [number, number, number];
  readonly elapsed: number;
  readonly carry: number;
  readonly wasEmitting: boolean;
  readonly pendingBurst: boolean;
  readonly orphaned: boolean;
  readonly particles: number[];
}

export interface ParticlesState {
  readonly random: RandomState;
  readonly emitters: SavedEmitter[];
}

export class ParticleSystem3d {
  readonly #effects: EffectLibrary;
  #random = new SeededRandom(0);
  #emitters: Emitter[] = [];
  readonly #byEntity = new Map<EntityId, Emitter>();
  #events: EffectEvent[] = [];

  constructor(effects: EffectLibrary) {
    this.#effects = effects;
  }

  /** The effect a reference names (parsed and checked now). */
  effect(ref: string, where: string): EffectDef {
    return this.#effects.get(ref, where);
  }

  reset(seed: number): void {
    this.#random = new SeededRandom(seed);
    this.#emitters = [];
    this.#byEntity.clear();
    this.#events = [];
  }

  play(ref: string, shot: OneShot, where: string): void {
    this.#oneShot(this.#effects.get(ref, where), ref, shot, 0, where);
  }

  attach(entity: EntityId, ref: string, where: string): void {
    const current = this.#byEntity.get(entity);
    if (current !== undefined && current.ref === ref) return;
    const def = this.#effects.get(ref, where);
    if (current !== undefined) this.detach(entity);
    const emitter = new Emitter(def, ref, entity, [0, 0, 0], null, 1, null);
    this.#byEntity.set(entity, emitter);
    this.#emitters.push(emitter);
  }

  detach(entity: EntityId): void {
    const emitter = this.#byEntity.get(entity);
    if (emitter === undefined) return;
    emitter.orphaned = true;
    emitter.entity = null;
    this.#byEntity.delete(entity);
  }

  emitterEntities(): EntityId[] {
    return [...this.#byEntity.keys()];
  }

  step(dt: number, source: (entity: EntityId) => EmitterSource): void {
    const deaths: { emitter: Emitter; at: Point }[] = [];
    for (const emitter of [...this.#emitters]) {
      this.#move(emitter, dt, deaths);
      if (emitter.orphaned) continue;
      if (emitter.entity === null) this.#emitOneShot(emitter, dt);
      else this.#emitContinuous(emitter, dt, source(emitter.entity));
    }
    for (const { emitter, at } of deaths) {
      if (this.#emitters.length >= MAX_EMITTERS) break;
      const death = emitter.def.onDeath!;
      const def = death.def ?? this.#effects.get(death.ref!, `${emitter.def.path} "on_death"`);
      this.#oneShot(def, death.def === null ? death.ref! : def.path, { position: at, color: emitter.override, scale: emitter.scale, direction: null }, 0, emitter.def.path);
    }
    this.#emitters = this.#emitters.filter((e) => e.count > 0 || (!e.orphaned && (e.entity !== null || this.#oneShotLive(e))));
  }

  /** Bursts since the last call (sound, camera shake). */
  takeEvents(): EffectEvent[] {
    const events = this.#events;
    this.#events = [];
    return events;
  }

  /** Effects' lights now: one-shots' flashes fading out, continuous emitters' steady (flickering) glow. */
  lights(): EffectLightNow[] {
    const out: EffectLightNow[] = [];
    for (const e of this.#emitters) {
      const light = e.def.light;
      if (light === null || e.orphaned) continue;
      let k: number;
      if (e.entity === null) {
        if (e.pendingBurst || e.elapsed >= light.seconds) continue;
        const left = 1 - e.elapsed / light.seconds;
        k = left * left;
      } else {
        if (!e.wasEmitting) continue;
        k = 1;
      }
      k *= flickerAt(light.flicker, e.elapsed);
      if (k <= 0.001) continue;
      const c = e.override ?? light.color;
      out.push({ position: e.position, color: [c[0], c[1], c[2], 1], intensity: light.intensity * k, range: light.range * e.scale, entity: e.entity });
    }
    return out;
  }

  /** Effects' heat haze now: one-shots' shockwave rings growing, continuous emitters' shimmer. */
  hazes(): EffectHazeNow[] {
    const out: EffectHazeNow[] = [];
    for (const e of this.#emitters) {
      const haze = e.def.haze;
      if (haze === null || e.orphaned) continue;
      if (e.entity === null) {
        if (e.pendingBurst) continue;
        if (haze.ring > 0) {
          if (e.elapsed >= haze.seconds) continue;
          const t = e.elapsed / haze.seconds;
          const grow = 1 - (1 - t) * (1 - t);
          out.push({ position: e.position, radius: Math.max(0.05, haze.radius * e.scale * grow), strength: haze.strength * (1 - t), ring: haze.ring });
        } else if (e.count > 0) {
          out.push({ position: e.position, radius: haze.radius * e.scale, strength: haze.strength, ring: 0 });
        }
      } else if (e.wasEmitting) {
        out.push({ position: e.position, radius: haze.radius * e.scale, strength: haze.strength, ring: 0 });
      }
    }
    return out;
  }

  /** Continuous emitters with a sound that emit now. */
  loops(): EffectLoop[] {
    const out: EffectLoop[] = [];
    for (const e of this.#byEntity.values()) {
      if (e.wasEmitting && e.def.sound !== null) out.push({ entity: e.entity!, sound: e.def.sound, position: e.position });
    }
    return out;
  }

  /**
   * Every emitter's particles. With an eye, alpha-blended particles come back to front
   * within their emitter (additive ones need no order).
   */
  draws(eye: Point | null = null): ParticleDraw[] {
    const out: ParticleDraw[] = [];
    for (const emitter of this.#emitters) {
      const n = emitter.count;
      if (n === 0) continue;
      const def = emitter.def;
      const data = new Float32Array(n * PARTICLE3D_STRIDE);
      const ps = emitter.particles;
      const c0 = emitter.color;
      const c1 = emitter.colorEnd ?? c0;
      let order: number[] | null = null;
      if (eye !== null && def.blend === 'alpha' && n > 1) {
        const d = new Float64Array(n);
        for (let i = 0; i < n; i++) d[i] = (ps[i * P]! - eye[0]) ** 2 + (ps[i * P + 1]! - eye[1]) ** 2 + (ps[i * P + 2]! - eye[2]) ** 2;
        order = Array.from({ length: n }, (_, i) => i).sort((a, b) => d[b]! - d[a]!);
      }
      const stretch = def.facing === 'velocity' ? def.stretch : 0;
      for (let j = 0; j < n; j++) {
        const i = order === null ? j : order[j]!;
        const p = i * P;
        const t = ps[p + 6]! / ps[p + 7]!;
        const o = j * PARTICLE3D_STRIDE;
        const size = ps[p + 8]! + (ps[p + 9]! - ps[p + 8]!) * t;
        data[o] = ps[p]!; data[o + 1] = ps[p + 1]!; data[o + 2] = ps[p + 2]!;
        data[o + 3] = size; data[o + 4] = size; data[o + 5] = ps[p + 10]!;
        for (let c = 0; c < 4; c++) data[o + 6 + c] = c0[c]! + (c1[c]! - c0[c]!) * t;
        if (def.fadeIn > 0 && t < def.fadeIn) data[o + 9]! *= t / def.fadeIn;
        data[o + 10] = ps[p + 3]! * stretch; data[o + 11] = ps[p + 4]! * stretch; data[o + 12] = ps[p + 5]! * stretch;
        data[o + 13] = t;
      }
      const distance = eye === null ? 0 : Math.hypot(emitter.position[0] - eye[0], emitter.position[1] - eye[1], emitter.position[2] - eye[2]);
      out.push({ entity: emitter.entity, def, count: n, data, distance });
    }
    return out;
  }

  get liveParticles(): number {
    return this.#emitters.reduce((n, e) => n + e.count, 0);
  }

  snapshot(): ParticlesState {
    return {
      random: this.#random.state(),
      emitters: this.#emitters.map((e) => ({
        ref: e.ref, entity: e.entity, override: e.override, scale: e.scale, axis: e.axis, position: [...e.position],
        ...(e.overrideEnd !== null && { overrideEnd: e.overrideEnd }), ...(e.amount !== 1 && { amount: e.amount }),
        elapsed: e.elapsed, carry: e.carry, wasEmitting: e.wasEmitting, pendingBurst: e.pendingBurst, orphaned: e.orphaned,
        particles: [...e.particles],
      })),
    };
  }

  restore(state: ParticlesState, alive: (entity: EntityId) => boolean): void {
    this.#random = new SeededRandom(0);
    this.#random.restore(state.random);
    this.#emitters = [];
    this.#byEntity.clear();
    this.#events = [];
    for (const saved of state.emitters) {
      const def = this.#effects.get(saved.ref, 'a restored effect');
      const emitter = new Emitter(def, saved.ref, saved.entity as EntityId | null, saved.position, saved.override, saved.scale, saved.axis,
        saved.overrideEnd ?? null, saved.amount ?? 1);
      Object.assign(emitter, {
        elapsed: saved.elapsed, carry: saved.carry, wasEmitting: saved.wasEmitting, pendingBurst: saved.pendingBurst,
        orphaned: saved.orphaned, particles: [...saved.particles],
      });
      if (emitter.entity !== null) {
        if (alive(emitter.entity)) this.#byEntity.set(emitter.entity, emitter);
        else { emitter.orphaned = true; emitter.entity = null; }
      }
      this.#emitters.push(emitter);
    }
  }

  /** A one-shot and its children (each after its delay, offset and scaled with the shot). */
  #oneShot(def: EffectDef, ref: string, shot: OneShot, delay: number, where: string): void {
    const emitter = new Emitter(def, ref, null, shot.position, shot.color, shot.scale, shot.direction, shot.colorEnd ?? null, countAmount(def, shot.count ?? null));
    emitter.elapsed -= delay;
    this.#emitters.push(emitter);
    for (const child of def.children) {
      const childDef = child.def ?? this.#effects.get(child.ref!, `${where} "children"`);
      const s = shot.scale;
      this.#oneShot(childDef, child.def === null ? child.ref! : childDef.path, {
        position: [shot.position[0] + child.offset[0] * s, shot.position[1] + child.offset[1] * s, shot.position[2] + child.offset[2] * s],
        color: shot.color, scale: s * child.scale, direction: shot.direction, colorEnd: shot.colorEnd ?? null,
      }, delay + child.delay, where);
    }
  }

  #oneShotLive(e: Emitter): boolean {
    if (e.pendingBurst) return true;
    if (e.elapsed < afterglow(e.def)) return true;
    return e.def.rate > 0 && e.elapsed < e.def.duration;
  }

  #move(e: Emitter, dt: number, deaths: { emitter: Emitter; at: Point }[]): void {
    if (dt === 0 || e.count === 0) return;
    const { gravity: [gx, gy], drag, turbulence, onDeath } = e.def;
    const keep = Math.max(0, 1 - drag * dt);
    const swirl = turbulence * e.scale * dt;
    const ps = e.particles;
    let write = 0;
    for (let read = 0; read < ps.length; read += P) {
      const age = ps[read + 6]! + dt;
      if (age >= ps[read + 7]!) {
        if (onDeath !== null && (onDeath.chance >= 1 || this.#random.next() < onDeath.chance)) {
          deaths.push({ emitter: e, at: [ps[read]!, ps[read + 1]!, ps[read + 2]!] });
        }
        continue;
      }
      let vx = ps[read + 3]! * keep + gx * e.scale * dt;
      let vy = ps[read + 4]! * keep + gy * e.scale * dt;
      let vz = ps[read + 5]! * keep;
      if (swirl !== 0) {
        // Smooth swirl: three noise channels over position (per scale) and age.
        const s = 0.8 / e.scale;
        const x = ps[read]! * s; const y = ps[read + 1]! * s; const z = ps[read + 2]! * s; const a = age * 0.7;
        vx += noise3(x + a, y, z + 17.1) * swirl;
        vy += noise3(x + 31.7, y + a, z) * swirl;
        vz += noise3(x, y + 53.3, z + a) * swirl;
      }
      ps[write] = ps[read]! + vx * dt;
      ps[write + 1] = ps[read + 1]! + vy * dt;
      ps[write + 2] = ps[read + 2]! + vz * dt;
      ps[write + 3] = vx; ps[write + 4] = vy; ps[write + 5] = vz;
      ps[write + 6] = age;
      ps[write + 7] = ps[read + 7]!;
      ps[write + 8] = ps[read + 8]!;
      ps[write + 9] = ps[read + 9]!;
      ps[write + 10] = ps[read + 10]! + ps[read + 11]! * dt;
      ps[write + 11] = ps[read + 11]!;
      write += P;
    }
    ps.length = write;
  }

  #emitOneShot(e: Emitter, dt: number): void {
    if (e.pendingBurst) {
      const before = e.elapsed;
      e.elapsed += dt;
      if (e.elapsed < 0) return;
      e.pendingBurst = false;
      // The part of this step after the delay ended.
      const window = before < 0 ? e.elapsed : dt;
      this.#spawn(e, Math.round(e.def.burst * e.amount));
      if (e.def.rate > 0 && e.def.duration > 0) this.#spawn(e, this.#owed(e, e.def.rate * e.amount, Math.min(window, e.def.duration)));
      this.#events.push({ def: e.def, position: e.position, scale: e.scale, entity: null });
      return;
    }
    const start = e.elapsed;
    e.elapsed += dt;
    if (e.def.rate === 0 || start >= e.def.duration) return;
    this.#spawn(e, this.#owed(e, e.def.rate * e.amount, Math.min(dt, e.def.duration - start)));
  }

  #emitContinuous(e: Emitter, dt: number, src: EmitterSource): void {
    e.position = [src.position[0], src.position[1], src.position[2]];
    if (!Number.isFinite(src.rateScale) || src.rateScale < 0) {
      fail('PP3809', `particles.rate_scale is ${src.rateScale}; it must be 0 or more`, { fix: 'Set rate_scale to a number ≥ 0.' });
    }
    if (src.emitting && !e.wasEmitting) {
      this.#spawn(e, e.def.burst);
      this.#events.push({ def: e.def, position: e.position, scale: e.scale, entity: e.entity });
    }
    if (src.emitting) {
      this.#spawn(e, this.#owed(e, e.def.rate * src.rateScale, dt));
      e.elapsed += dt;
    } else {
      e.carry = 0;
    }
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
    // An orthonormal basis around the emission axis.
    const [ax, ay, az] = e.axis;
    const helper = Math.abs(ay) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let ux = helper[1]! * az - helper[2]! * ay;
    let uy = helper[2]! * ax - helper[0]! * az;
    let uz = helper[0]! * ay - helper[1]! * ax;
    const ul = Math.hypot(ux, uy, uz);
    ux /= ul; uy /= ul; uz /= ul;
    const vx = ay * uz - az * uy;
    const vy = az * ux - ax * uz;
    const vz = ax * uy - ay * ux;
    const minCos = Math.cos(((def.spread / 2) * Math.PI) / 180);
    for (let i = 0; i < count; i++) {
      const cos = 1 - r.next() * (1 - minCos);
      const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
      const around = r.next() * Math.PI * 2;
      const c = Math.cos(around) * sin;
      const d = Math.sin(around) * sin;
      const dx = ax * cos + ux * c + vx * d;
      const dy = ay * cos + uy * c + vy * d;
      const dz = az * cos + uz * c + vz * d;
      const speed = pick(r, def.speed) * s;
      // Uniform in a ball of `radius`.
      const at = Math.cbrt(r.next()) * def.radius * s;
      const pz = r.next() * 2 - 1;
      const pa = r.next() * Math.PI * 2;
      const pr = Math.sqrt(1 - pz * pz);
      const size0 = pick(r, def.size) * s;
      e.particles.push(
        e.position[0] + Math.cos(pa) * pr * at, e.position[1] + Math.sin(pa) * pr * at, e.position[2] + pz * at,
        dx * speed, dy * speed, dz * speed,
        0, pick(r, def.lifetime),
        size0, def.sizeEnd === null ? size0 : def.sizeEnd * s,
        pick(r, def.angle), pick(r, def.spin),
      );
    }
    const over = e.count - def.max;
    if (over > 0) e.particles.splice(0, over * P);
  }
}

export function particlesState(json: Json): ParticlesState {
  return json as unknown as ParticlesState;
}
