/**
 * Melee strikes, hit reactions, lock-on, aim assist and impact damage — the parts of
 * combat that look at the world (sdk/parallax/combat.pyi). Every hit still goes through
 * the one pipeline (`CombatState.hit`).
 *
 * Strikes. `Striker.strike(Content.strike.jab)` starts a strike: a capsule from `offset`
 * to `offset + reach` (radius `radius`) in the frame of the attacker's Model socket
 * `socket` (a hand bone, a blade's socket; None: the attacker itself), live while its
 * active window is open — `active` seconds after it starts, or between the animation
 * markers `start_event` and `end_event` (AnimationEvent on the attacker; the window then
 * follows the clip, slowed or sped up with it). Each frame the capsule is swept from where
 * it was to where it is now, in steps no longer than its radius, so a fast swing can't
 * pass through a target between frames. It hits each target at most once per strike
 * (`max_targets` 0: any number), never the attacker, and not the attacker's side unless
 * `friendly_fire`. Targets are entities with Health, measured against their `Hurtbox`
 * zones (capsules on sockets, each with a damage `multiplier` — headshots) or, without
 * one, a standing capsule filling their Collider (else 1.8 m × 0.4 m).
 *
 * A hit deals `damage` × the zone's multiplier through the pipeline (source: the
 * attacker; point: where the capsules met), then the reaction: `knockback` (N·s along
 * the swing, physics3d dynamic bodies), `stagger` seconds of `Health.staggered`, and the
 * target's Animator `reaction` trigger (targets without an Animator, or whose Animator
 * declares no such trigger, just skip it). `StrikeHit` is raised
 * for game code (sparks, sounds, hit-stop).
 *
 * Lock-on. `LockOn.lock()` takes the best target in front: living Health entities that
 * are enemies (or, for an attacker without a Side, anything with Health), within `range`
 * and `angle` of the holder's facing, with line of sight when physics3d is present —
 * scored by angle then distance. `cycle(direction)` steps to the next target clockwise
 * (1) or anticlockwise (−1) around the holder. A lock lets go by itself when its target
 * dies, is destroyed, goes beyond `break_range` or out of sight; `LockChanged` says so.
 *
 * Aim assist (`ctx.combat.aim_assist`) bends an aim direction towards the nearest enemy
 * aim point inside a cone by `strength` (magnetism); `ctx.combat.aim_target` names it
 * (for friction: slow the look speed while it is not None).
 *
 * Impacts. `ImpactDamage` on a Health entity turns physics3d contact forces over
 * `threshold` newtons into damage (force / threshold, at the contact; source: what it hit),
 * and with `from_breakable` mirrors the destruction plugin's `breakable_damaged` on the
 * same entity into its Health.
 */

import { fail, Quat, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import type { EntityRecord, Fields, Kernel } from '../../kernel/index.js';
import { MODEL_RIG_SERVICE, PHYSICS3D_SERVICE } from '../../services/index.js';
import { describe, finite } from './args.js';
import type { CombatState } from './state.js';

export const STRIKER = 'striker';
export const HURTBOX = 'hurtbox';
export const LOCK_ON = 'lock_on';
export const IMPACT_DAMAGE = 'impact_damage';
export const STRIKE = 'strike';
const HEALTH = 'health';
const ANIMATOR = 'animator';

export const ENGAGEMENT_EVENTS = {
  strikeHit: { id: 'strike_hit', target: 'entity' },
  lockChanged: { id: 'lock_changed', target: 'entity' },
} as const;

/** Physics3d contact-force watches are per owner. */
const WATCH = 'combat';

/** A `strike` content entry as game code holds it (the api's ContentRef). */
export interface StrikeRef {
  readonly id: string;
  readonly kind: string;
  readonly data: unknown;
}

interface StrikeData {
  readonly socket: string | null;
  readonly offset: Vec3;
  readonly reach: Vec3;
  readonly radius: number;
  readonly damage: number;
  readonly kind: unknown;
  readonly active: readonly [number, number];
  readonly startEvent: string | null;
  readonly endEvent: string | null;
  readonly duration: number | null;
  readonly maxTargets: number;
  readonly friendlyFire: boolean;
  readonly knockback: number;
  readonly stagger: number;
  readonly reaction: string | null;
}

interface Swing {
  readonly ref: StrikeRef;
  readonly data: StrikeData;
  readonly started: number;
  /** Event-driven window: opened by start_event, closed by end_event. */
  open: boolean;
  closed: boolean;
  hits: EntityId[];
  /** The capsule's frame at the last frame it was live (world). */
  last: Frame | null;
}

interface Frame {
  readonly position: Vec3;
  readonly rotation: Quat;
}

/** Normalized lerp along the shorter arc: close enough to slerp for the sub-steps of one frame. */
function nlerp(a: Quat, b: Quat, k: number): Quat {
  const dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  const s = dot < 0 ? -1 : 1;
  const x = a.x + (b.x * s - a.x) * k;
  const y = a.y + (b.y * s - a.y) * k;
  const z = a.z + (b.z * s - a.z) * k;
  const w = a.w + (b.w * s - a.w) * k;
  const n = Math.hypot(x, y, z, w);
  return new Quat(x / n, y / n, z / n, w / n);
}

interface Zone {
  readonly a: Vec3;
  readonly b: Vec3;
  readonly radius: number;
  readonly multiplier: number;
  readonly name: string;
}

export interface EngagementSnapshot {
  readonly swings: ReadonlyArray<{
    readonly entity: number; readonly strike: string; readonly started: number; readonly open: boolean; readonly closed: boolean;
    readonly hits: number[]; readonly last: number[][] | null;
  }>;
  readonly stagger: ReadonlyArray<readonly [number, number]>;
}

export interface EngagementHost {
  strike?(kernel: Kernel, id: string): StrikeRef;
}

const DUE = 1e-9;

function vec(value: unknown, where: string): Vec3 {
  if (value instanceof Vec3) return value;
  if (Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === 'number')) return new Vec3(value[0], value[1], value[2]);
  return fail('PP7400', `${where} must be a Vec3, got ${describe(value)}`);
}

/** Closest points between segments p1–q1 and p2–q2 (Ericson, Real-Time Collision Detection 5.1.9). */
export function segmentDistance(p1: Vec3, q1: Vec3, p2: Vec3, q2: Vec3): { distance: number; point: Vec3 } {
  const d1 = q1.__sub__(p1);
  const d2 = q2.__sub__(p2);
  const r = p1.__sub__(p2);
  const a = d1.dot(d1);
  const e = d2.dot(d2);
  const f = d2.dot(r);
  let s = 0;
  let t = 0;
  const clamp = (v: number): number => Math.min(1, Math.max(0, v));
  if (a <= 1e-12 && e <= 1e-12) {
    s = 0;
    t = 0;
  } else if (a <= 1e-12) {
    t = clamp(f / e);
  } else {
    const c = d1.dot(r);
    if (e <= 1e-12) {
      s = clamp(-c / a);
    } else {
      const b = d1.dot(d2);
      const denom = a * e - b * b;
      s = denom > 1e-12 ? clamp((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp((b - c) / a);
      }
    }
  }
  const c1 = p1.__add__(d1.__mul__(s));
  const c2 = p2.__add__(d2.__mul__(t));
  return { distance: c1.distance_to(c2), point: c1.lerp(c2, 0.5) };
}

export class Engagement {
  readonly kernel: Kernel;
  readonly #combat: CombatState;
  readonly #host: EngagementHost;
  readonly #swings = new Map<EntityId, Swing>();
  readonly #stagger = new Map<EntityId, number>();

  constructor(kernel: Kernel, combat: CombatState, host: EngagementHost) {
    this.kernel = kernel;
    this.#combat = combat;
    this.#host = host;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  observe(record: EntityRecord): void {
    const impact = record.components.get(IMPACT_DAMAGE);
    const threshold = (impact?.['threshold'] ?? null) as number | null;
    this.kernel.tryService(PHYSICS3D_SERVICE)?.watchContactForces(record.id, WATCH, threshold === null ? undefined : threshold);
    if (!record.components.has(STRIKER)) this.#swings.delete(record.id);
  }

  removed(ids: readonly EntityId[]): void {
    for (const id of ids) {
      this.#swings.delete(id);
      this.#stagger.delete(id);
    }
    for (const swing of this.#swings.values()) swing.hits = swing.hits.filter((h) => !ids.includes(h));
  }

  // ── Strikes ──────────────────────────────────────────────────────────────────

  #data(ref: StrikeRef): StrikeData {
    const where = `strike "${ref.id}"`;
    const d = (ref.data ?? {}) as Record<string, unknown>;
    const active = (d['active'] ?? [0, 0.2]) as unknown[];
    if (!Array.isArray(active) || active.length !== 2 || !(Number(active[1]) >= Number(active[0]))) {
      fail('PP7401', `${where} active must be [start, end] seconds with end >= start, got ${describe(active)}`);
    }
    const startEvent = (d['start_event'] ?? null) as string | null;
    const endEvent = (d['end_event'] ?? null) as string | null;
    if ((startEvent === null) !== (endEvent === null)) {
      fail('PP7401', `${where} names only one of start_event / end_event`, { fix: 'Give both markers, or neither (then `active` times it).' });
    }
    const rawKind = d['kind'] ?? null;
    return {
      socket: (d['socket'] ?? null) as string | null,
      offset: vec(d['offset'] ?? [0, 0, 0], `${where} offset`),
      reach: vec(d['reach'] ?? [0, 0, 1], `${where} reach`),
      radius: finite(d['radius'] ?? 0.15, `${where} radius`),
      damage: finite(d['damage'] ?? 10, `${where} damage`),
      kind: typeof rawKind === 'string' ? this.#combat.host.tag(rawKind) : rawKind,
      active: [Number(active[0]), Number(active[1])],
      startEvent, endEvent,
      duration: d['duration'] === null || d['duration'] === undefined ? null : finite(d['duration'], `${where} duration`),
      maxTargets: finite(d['max_targets'] ?? 0, `${where} max_targets`),
      friendlyFire: d['friendly_fire'] === true,
      knockback: finite(d['knockback'] ?? 0, `${where} knockback`),
      stagger: finite(d['stagger'] ?? 0, `${where} stagger`),
      reaction: (d['reaction'] ?? null) as string | null,
    };
  }

  strike(attacker: EntityId, ref: StrikeRef): void {
    this.#swings.set(attacker, { ref, data: this.#data(ref), started: this.kernel.time.now, open: false, closed: false, hits: [], last: null });
  }

  cancel(attacker: EntityId): void {
    this.#swings.delete(attacker);
  }

  swing(attacker: EntityId): Swing | undefined {
    return this.#swings.get(attacker);
  }

  #live(s: Swing, now: number): boolean {
    if (s.data.startEvent !== null) return s.open && !s.closed;
    const t = now - s.started;
    return t >= s.data.active[0] - DUE && t <= s.data.active[1] + DUE;
  }

  #over(s: Swing, now: number): boolean {
    const t = now - s.started;
    if (s.data.duration !== null) return t > s.data.duration + DUE;
    if (s.data.startEvent !== null) return s.closed;
    return t > s.data.active[1] + DUE;
  }

  active(attacker: EntityId): boolean {
    const s = this.#swings.get(attacker);
    return s !== undefined && this.#live(s, this.kernel.time.now);
  }

  /** An AnimationEvent on an attacker opens or closes its marker-timed window. */
  animationEvent(payload: Fields): void {
    const id = this.kernel.handles.unwrap(payload['entity']);
    const s = id === undefined ? undefined : this.#swings.get(id);
    if (s === undefined || s.data.startEvent === null) return;
    const name = payload['name'];
    if (name === s.data.startEvent && !s.closed) s.open = true;
    else if (name === s.data.endEvent && s.open) {
      // Sweep up to the closing frame before the window shuts.
      this.#sweep(id!, s);
      s.closed = true;
    }
  }

  /** The strike's frame (socket, else the attacker) in world space now. */
  #frame(attacker: EntityId, d: StrikeData): Frame | undefined {
    if (d.socket === null) {
      const t = this.kernel.world.require(attacker).transform;
      return { position: t.worldPosition(), rotation: t.worldRotation() };
    }
    const frame = this.kernel.tryService(MODEL_RIG_SERVICE)?.socket(attacker, d.socket, 'world');
    return frame === null || frame === undefined ? undefined : { position: frame.position, rotation: frame.rotation };
  }

  #capsule(f: Frame, d: StrikeData): [Vec3, Vec3] {
    const a = f.position.__add__(f.rotation.rotate(d.offset));
    return [a, a.__add__(f.rotation.rotate(d.reach))];
  }

  #zones(id: EntityId): Zone[] {
    const record = this.kernel.world.require(id);
    const box = record.components.get(HURTBOX);
    const zones = (box?.['zones'] ?? []) as Array<Record<string, unknown>>;
    if (zones.length > 0) {
      const rig = this.kernel.tryService(MODEL_RIG_SERVICE);
      return zones.flatMap((z, i) => {
        const socket = (z['socket'] ?? null) as string | null;
        let position = record.transform.worldPosition();
        let rotation = record.transform.worldRotation();
        if (socket !== null) {
          const frame = rig?.socket(id, socket, 'world');
          if (frame === null || frame === undefined) return [];
          position = frame.position;
          rotation = frame.rotation;
        }
        const a = position.__add__(rotation.rotate(vec(z['offset'] ?? [0, 0, 0], `hurtbox zone ${i} offset`)));
        const length = z['length'] as number;
        return [{
          a, b: a.__add__(rotation.rotate(new Vec3(0, length, 0))), radius: z['radius'] as number,
          multiplier: z['multiplier'] as number, name: (z['name'] ?? '') as string,
        }];
      });
    }
    const t = record.transform;
    const bounds = this.kernel.tryService(PHYSICS3D_SERVICE)?.bounds(id);
    if (bounds !== undefined) {
      const h = bounds.halfExtents;
      const r = Math.max(0.05, Math.min(h.x, h.z));
      const half = Math.max(0, h.y - r);
      const c = bounds.center;
      return [{ a: t.toWorld(c.__sub__(new Vec3(0, half, 0))), b: t.toWorld(c.__add__(new Vec3(0, half, 0))), radius: r, multiplier: 1, name: '' }];
    }
    const p = t.worldPosition();
    return [{ a: p.__add__(new Vec3(0, 0.4, 0)), b: p.__add__(new Vec3(0, 1.4, 0)), radius: 0.4, multiplier: 1, name: '' }];
  }

  #targets(attacker: EntityId, s: Swing): EntityId[] {
    return this.kernel.world.query([HEALTH]).map(([id]) => id).filter((id) => {
      if (id === attacker || s.hits.includes(id)) return false;
      if ((this.kernel.world.require(id).components.get(HEALTH)!['current'] as number) <= 0) return false;
      if (s.data.friendlyFire) return true;
      const mine = this.#combat.sideOf(attacker);
      return mine === undefined || this.#combat.sideOf(id) !== mine;
    });
  }

  #sweep(attacker: EntityId, s: Swing): void {
    const now = this.#frame(attacker, s.data);
    if (now === undefined) return;
    const from = s.last ?? now;
    s.last = now;
    // Sub-steps no longer than the radius, along the arc the frame turned through.
    const a0 = this.#capsule(from, s.data);
    const a1 = this.#capsule(now, s.data);
    const dot = Math.min(1, Math.abs(from.rotation.x * now.rotation.x + from.rotation.y * now.rotation.y + from.rotation.z * now.rotation.z + from.rotation.w * now.rotation.w));
    const turned = 2 * Math.acos(dot);
    const lever = s.data.offset.length() + s.data.reach.length();
    const travel = Math.max(from.position.distance_to(now.position) + turned * lever, a0[1].distance_to(a1[1]));
    const steps = Math.max(1, Math.ceil(travel / Math.max(s.data.radius, 0.05)));
    const capsules: Array<[Vec3, Vec3]> = [];
    for (let i = 0; i <= steps; i++) {
      const k = i / steps;
      capsules.push(this.#capsule({ position: from.position.lerp(now.position, k), rotation: nlerp(from.rotation, now.rotation, k) }, s.data));
    }
    const swingDir = a1[1].__sub__(a0[1]);
    for (const target of this.#targets(attacker, s)) {
      if (s.data.maxTargets > 0 && s.hits.length >= s.data.maxTargets) return;
      const zones = this.#zones(target);
      let best: { zone: Zone; point: Vec3 } | undefined;
      for (const [a, b] of capsules) {
        for (const zone of zones) {
          const d = segmentDistance(a, b, zone.a, zone.b);
          if (d.distance <= s.data.radius + zone.radius && (best === undefined || zone.multiplier > best.zone.multiplier)) {
            best = { zone, point: d.point };
          }
        }
        if (best !== undefined) break;
      }
      if (best !== undefined) this.#land(attacker, target, s, best.zone, best.point, swingDir);
    }
  }

  #land(attacker: EntityId, target: EntityId, s: Swing, zone: Zone, point: Vec3, swingDir: Vec3): void {
    s.hits.push(target);
    const h = this.kernel.handles;
    const amount = s.data.damage * zone.multiplier;
    const result = this.#combat.hit(target, {
      amount, source: h.wrap(attacker), kind: s.data.kind, point, ignoresArmor: false, lethal: true,
    });
    if (!result.landed) return;
    const service = this.kernel.tryService(PHYSICS3D_SERVICE);
    if (s.data.knockback > 0 && service?.body(target)?.kind === 'dynamic') {
      const fallback = this.kernel.world.require(target).transform.worldPosition().__sub__(this.kernel.world.require(attacker).transform.worldPosition());
      const dir = (swingDir.length() > 1e-6 ? swingDir : fallback).normalized();
      service.applyImpulse(target, dir.__mul__(s.data.knockback), point);
    }
    if (s.data.stagger > 0) {
      this.#stagger.set(target, Math.max(this.#stagger.get(target) ?? 0, this.kernel.time.now + s.data.stagger));
    }
    if (s.data.reaction !== null) {
      // Targets whose Animator doesn't declare that trigger (a crate, a different rig) skip it.
      const animator = this.kernel.world.get(target)?.components.get(ANIMATOR) as
        Fields & { trigger?: (name: string) => void; has_param?: (name: string, kind: string) => boolean } | undefined;
      if (animator?.trigger !== undefined && animator.has_param?.(s.data.reaction, 'trigger') === true) animator.trigger(s.data.reaction);
    }
    this.kernel.emit(ENGAGEMENT_EVENTS.strikeHit, {
      entity: h.wrap(target), source: h.wrap(attacker), strike: s.ref, point, zone: zone.name, damage: result.dealt,
      reaction: s.data.reaction,
    });
  }

  staggered(id: EntityId): boolean {
    return this.kernel.time.now < (this.#stagger.get(id) ?? 0) - DUE;
  }

  // ── Lock-on ──────────────────────────────────────────────────────────────────

  #facing(id: EntityId): { at: Vec3; forward: Vec3 } {
    const t = this.kernel.world.require(id).transform;
    return { at: t.worldPosition(), forward: t.worldRotation().rotate(Vec3.FORWARD).flat().normalized() };
  }

  /** Where aim and lock-on point at an entity: its first hurtbox zone's middle, its Collider's centre, or its origin. */
  aimPoint(id: EntityId): Vec3 {
    const zones = this.#zones(id);
    const z = zones[0]!;
    return z.a.lerp(z.b, 0.5);
  }

  #candidates(holder: EntityId, range: number): EntityId[] {
    const mine = this.#combat.sideOf(holder);
    const at = this.kernel.world.require(holder).transform.worldPosition();
    return this.kernel.world.query([HEALTH]).map(([id]) => id).filter((id) => {
      if (id === holder || (this.kernel.world.require(id).components.get(HEALTH)!['current'] as number) <= 0) return false;
      if (mine !== undefined && !this.#combat.areEnemies(holder, id)) return false;
      return this.kernel.world.require(id).transform.worldPosition().distance_to(at) <= range;
    });
  }

  #visible(from: EntityId, to: EntityId, lineOfSight: boolean): boolean {
    const service = this.kernel.tryService(PHYSICS3D_SERVICE);
    if (!lineOfSight || service === undefined) return true;
    const a = this.aimPoint(from);
    const b = this.aimPoint(to);
    const d = b.__sub__(a);
    const length = d.length();
    if (length < 1e-6) return true;
    const hit = service.raycast(a, d.__mul__(1 / length), length, { ignore: [from, to] });
    return hit === undefined;
  }

  /** Signed heading (deg, clockwise positive) of `to` seen from `holder`'s facing. */
  #bearing(holder: EntityId, to: EntityId): number {
    const { at, forward } = this.#facing(holder);
    const d = this.kernel.world.require(to).transform.worldPosition().__sub__(at).flat();
    if (d.length() < 1e-6) return 0;
    const n = d.normalized();
    return (Math.atan2(forward.x * n.z - forward.z * n.x, forward.dot(n)) * -180) / Math.PI;
  }

  lock(holder: EntityId, fields: Fields): boolean {
    const range = fields['range'] as number;
    const angle = fields['angle'] as number;
    const at = this.kernel.world.require(holder).transform.worldPosition();
    let best: { id: EntityId; score: number } | undefined;
    for (const id of this.#candidates(holder, range)) {
      const bearing = Math.abs(this.#bearing(holder, id));
      if (bearing > angle || !this.#visible(holder, id, fields['line_of_sight'] === true)) continue;
      const score = bearing / Math.max(angle, 1) + 0.5 * (this.kernel.world.require(id).transform.worldPosition().distance_to(at) / Math.max(range, 1e-6));
      if (best === undefined || score < best.score) best = { id, score };
    }
    this.#setTarget(holder, fields, best?.id ?? null);
    return best !== undefined;
  }

  cycle(holder: EntityId, fields: Fields, direction: number): boolean {
    const current = this.kernel.handles.unwrap(fields['target'] ?? null);
    const around = this.#candidates(holder, fields['range'] as number)
      .filter((id) => this.#visible(holder, id, fields['line_of_sight'] === true))
      .map((id) => ({ id, bearing: this.#bearing(holder, id) }))
      .sort((a, b) => a.bearing - b.bearing || (a.id as number) - (b.id as number));
    if (around.length === 0) {
      this.#setTarget(holder, fields, null);
      return false;
    }
    if (current === undefined) return this.lock(holder, fields);
    const here = current === undefined ? 0 : this.#bearing(holder, current);
    const next = direction >= 0
      ? around.find((c) => c.id !== current && c.bearing > here) ?? around.find((c) => c.id !== current)
      : [...around].reverse().find((c) => c.id !== current && c.bearing < here) ?? [...around].reverse().find((c) => c.id !== current);
    if (next === undefined) return false;
    this.#setTarget(holder, fields, next.id);
    return true;
  }

  release(holder: EntityId, fields: Fields): void {
    this.#setTarget(holder, fields, null);
  }

  #setTarget(holder: EntityId, fields: Fields, target: EntityId | null): void {
    const h = this.kernel.handles;
    const before = this.kernel.handles.unwrap(fields['target'] ?? null) ?? null;
    if (before === target) return;
    fields['target'] = target === null ? null : h.wrap(target);
    this.kernel.emit(ENGAGEMENT_EVENTS.lockChanged, {
      entity: h.wrap(holder), target: target === null ? null : h.wrap(target), previous: before === null ? null : h.wrap(before),
    });
  }

  // ── Aim assist ───────────────────────────────────────────────────────────────

  aimTarget(origin: Vec3, direction: Vec3, shooter: EntityId | undefined, angle: number, range: number): { id: EntityId; point: Vec3; off: number } | undefined {
    const dir = direction.normalized();
    let best: { id: EntityId; point: Vec3; off: number } | undefined;
    for (const [id, fields] of this.kernel.world.query([HEALTH])) {
      if (id === shooter || (fields!['current'] as number) <= 0) continue;
      if (shooter !== undefined && this.#combat.sideOf(shooter) !== undefined && !this.#combat.areEnemies(shooter, id)) continue;
      const point = this.aimPoint(id);
      const to = point.__sub__(origin);
      const distance = to.length();
      if (distance > range || distance < 1e-6) continue;
      const off = (Math.acos(Math.min(1, Math.max(-1, to.dot(dir) / distance))) * 180) / Math.PI;
      if (off > angle) continue;
      if (shooter !== undefined && !this.#visible(shooter, id, true)) continue;
      if (best === undefined || off < best.off) best = { id, point, off };
    }
    return best;
  }

  aimAssist(origin: Vec3, direction: Vec3, shooter: EntityId | undefined, angle: number, range: number, strength: number): Vec3 {
    const dir = direction.normalized();
    const target = this.aimTarget(origin, dir, shooter, angle, range);
    if (target === undefined) return dir;
    const want = target.point.__sub__(origin).normalized();
    return dir.lerp(want, Math.min(1, Math.max(0, strength))).normalized();
  }

  // ── Impacts ──────────────────────────────────────────────────────────────────

  /** Once per frame: contact forces over each ImpactDamage threshold (physics3d). */
  impacts(): void {
    const service = this.kernel.tryService(PHYSICS3D_SERVICE);
    if (service === undefined) return;
    for (const c of service.contactForces()) {
      const record = this.kernel.world.get(c.entity);
      const impact = record?.components.get(IMPACT_DAMAGE);
      const threshold = (impact?.['threshold'] ?? null) as number | null;
      if (record === undefined || impact === undefined || threshold === null || threshold <= 0 || !record.components.has(HEALTH)) continue;
      if (c.force < threshold || c.speed < (impact['min_speed'] as number)) continue;
      const h = this.kernel.handles;
      this.#combat.hit(record.id, {
        amount: c.force / threshold, source: c.other === undefined ? null : h.wrap(c.other), kind: this.#kind(impact['kind']),
        point: c.point, ignoresArmor: false, lethal: true,
      });
    }
  }

  #kind(raw: unknown): unknown {
    return typeof raw === 'string' ? this.#combat.host.tag(raw) : raw ?? null;
  }

  /** The destruction plugin's `breakable_damaged` on an entity with `ImpactDamage(from_breakable=True)`. */
  breakableDamaged(payload: Fields): void {
    const id = this.kernel.handles.unwrap(payload['entity']);
    const record = id === undefined ? undefined : this.kernel.world.get(id);
    const impact = record?.components.get(IMPACT_DAMAGE);
    if (record === undefined || impact === undefined || impact['from_breakable'] !== true || !record.components.has(HEALTH)) return;
    const amount = payload['amount'] as number;
    if (!(amount > 0)) return;
    this.#combat.hit(record.id, {
      amount, source: payload['source'] ?? null, kind: this.#kind(impact['kind']), point: payload['point'] ?? null, ignoresArmor: false, lethal: true,
    });
  }

  // ── The frame ────────────────────────────────────────────────────────────────

  update(): void {
    const now = this.kernel.time.now;
    for (const [attacker, s] of [...this.#swings]) {
      if (!this.kernel.world.isAlive(attacker)) {
        this.#swings.delete(attacker);
        continue;
      }
      if (this.#live(s, now)) this.#sweep(attacker, s);
      else if (s.data.startEvent === null) s.last = null;
      if (this.#over(s, now)) this.#swings.delete(attacker);
    }
    for (const [id, until] of [...this.#stagger]) if (until <= now) this.#stagger.delete(id);
    // Locks let go by themselves.
    for (const [holder, fields] of this.kernel.world.query([LOCK_ON])) {
      const target = this.kernel.handles.unwrap(fields!['target'] ?? null);
      if (target === undefined) continue;
      const record = this.kernel.world.get(target);
      const health = record?.components.get(HEALTH);
      const gone = record === undefined || health === undefined || (health['current'] as number) <= 0
        || record.transform.worldPosition().distance_to(this.kernel.world.require(holder).transform.worldPosition()) > (fields!['break_range'] as number)
        || !this.#visible(holder, target, fields!['line_of_sight'] === true);
      if (gone) this.#setTarget(holder, fields!, null);
    }
  }

  // ── Snapshots ────────────────────────────────────────────────────────────────

  snapshot(): EngagementSnapshot {
    return {
      swings: [...this.#swings].map(([entity, s]) => ({
        entity: entity as number, strike: s.ref.id, started: s.started, open: s.open, closed: s.closed, hits: s.hits.map((h) => h as number),
        last: s.last === null ? null : [[s.last.position.x, s.last.position.y, s.last.position.z], [s.last.rotation.x, s.last.rotation.y, s.last.rotation.z, s.last.rotation.w]],
      })),
      stagger: [...this.#stagger].map(([id, until]) => [id as number, until] as const),
    };
  }

  restore(saved: EngagementSnapshot | undefined): void {
    this.#swings.clear();
    this.#stagger.clear();
    if (saved === undefined) return;
    const alive = (id: number): boolean => this.kernel.world.isAlive(id as EntityId);
    for (const s of saved.swings) {
      if (!alive(s.entity)) continue;
      const ref = this.#host.strike?.(this.kernel, s.strike)
        ?? fail('PP9902', 'Restoring a strike needs the combat host to resolve strike content', { fix: 'Build combat through parallax.plugins.combat().' });
      this.#swings.set(s.entity as EntityId, {
        ref, data: this.#data(ref), started: s.started, open: s.open, closed: s.closed, hits: s.hits.filter(alive).map((h) => h as EntityId),
        last: s.last === null ? null : {
          position: new Vec3(s.last[0]![0], s.last[0]![1], s.last[0]![2]),
          rotation: new Quat(s.last[1]![0]!, s.last[1]![1]!, s.last[1]![2]!, s.last[1]![3]!),
        },
      });
    }
    for (const [id, until] of saved.stagger) if (alive(id)) this.#stagger.set(id as EntityId, until);
  }
}
