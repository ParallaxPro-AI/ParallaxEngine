/**
 * Perception: what each `Perception` entity sees, hears and remembers.
 *
 * Who is perceived. With `targets` set, entities carrying that tag; without it, entities
 * whose combat `Side` differs from the perceiver's (a perceiver without either is PP3260:
 * it could never perceive anyone). A `Detectable` tunes how visible one is (`visibility`,
 * 0 = invisible to sight; crouching, shadows) and where it is looked at (`height`).
 *
 * Sight, every `interval` seconds (staggered by entity): a target is seen when it is within
 * `sight_range` (and the weather's `visibility`, with weather()), inside the `fov` cone on the ground plane (or within `close_range` in any
 * direction), and the line from the eye (`eye_height`) to its `height` is clear — through
 * physics raycasts when physics3d is in the game (anything solid occludes, the two
 * entities and their children excepted), else nav's static world (walls, terrain), else
 * open ground — not hidden in a terrain brush volume (tall grass: the target's looked-at
 * point is inside a volume, below its top, that the perceiver's feet are not in), and not
 * swallowed by sight blockers (`ctx.ai.block_sight`: smoke, whose
 * thickness along the line dims it). How well it is seen, v in (0, 1]: `visibility` ×
 * distance (1 within a quarter of the range, falling to 0.25 at its edge) × the blockers'
 * transmittance (under 0.05 is not seen).
 *
 * Awareness per known target, 0..1: seen, it rises by v·dt / `notice_time` (0: at once);
 * reaching 1 makes the target *alerted* (`Spotted`). Unseen, an alerted target stays at 1
 * for `memory` seconds after it was last seen (the perceiver hunts its last known
 * position), then drops to the `suspicious` level (`LostTarget`); a target that never
 * alerted decays by dt / `calm_time` and is forgotten at 0. Crossing `suspicious` upward
 * emits `Suspicious` with where to look.
 *
 * Hearing: `ctx.ai.noise(at, loudness, ...)` carries `loudness` meters (× `hearing`; half
 * through walls). A perceiver in range hears it with strength 1 - d/range: it remembers
 * the noise's position (`heard_position`), and when the source is someone it perceives,
 * that target's awareness rises by 0.6 × strength (never past 0.99: hearing alone doesn't
 * spot) with the noise as its last known position. Every hearing emits `HeardNoise`.
 *
 * The perceiver's *primary target*: alerted and seen, then alerted, then most aware;
 * ties by distance, then entity id. Its alert level: "alert" with any alerted target,
 * "suspicious" with any target at or over `suspicious` or a noise heard within `memory`,
 * else "unaware".
 */

import { fail, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import type { EntityRecord, Fields, Kernel } from '../../kernel/index.js';
import type { Json, JsonObject } from '../../../resource/index.js';
import { TERRAIN_SERVICE, WEATHER_SERVICE } from '../../services/index.js';
import type { AlertLevel, KnownTarget, NoiseEvent } from '../../services/index.js';
import { AI_EVENTS, DETECTABLE, PERCEPTION, SIDE } from './schemas.js';

/** Hearing raises awareness by this much at full strength. */
export const HEARING_GAIN = 0.6;
/** Hearing alone never alerts. */
export const HEARING_CAP = 0.99;
/** Noises are kept this long (s) for perceivers ticking at their interval and for the HUD. */
export const NOISE_SECONDS = 2;
const MIN_TRANSMITTANCE = 0.05;
const GOLDEN = 0.6180339887498949;

/** A noise as perception keeps it: which perceivers have already considered it. */
export interface Noise extends NoiseEvent {
  readonly checked: Set<EntityId>;
}

export interface SightBlocker {
  readonly center: Vec3;
  readonly radius: number;
  readonly density: number;
  /** AI clock: when it was made, how long it grows, when it starts fading and when it is gone. */
  readonly born: number;
  readonly grow: number;
  readonly fadeAt: number;
  readonly until: number;
}

interface Known {
  awareness: number;
  alerted: boolean;
  seen: boolean;
  lastPosition: Vec3;
  /** AI clock when last seen; -Infinity when never. */
  lastSeen: number;
  /** Visibility of the last sighting (0 when not seen this update). */
  visibility: number;
}

interface PerceiverState {
  readonly known: Map<EntityId, Known>;
  heard: Vec3 | null;
  heardAt: number;
  nextAt: number;
  lastAt: number;
}

export interface Senses {
  /** Whether the segment is clear (occlusion), ignoring these entities. */
  clear(a: Vec3, b: Vec3, ignore: readonly EntityId[]): boolean;
}

/** What a perceiver tells its brain and HUD after an update. */
export interface Percept {
  readonly target: EntityId | null;
  readonly visible: boolean;
  readonly position: Vec3 | null;
  readonly distance: number | null;
  readonly awareness: number;
  readonly alert: AlertLevel;
  readonly heard: Vec3 | null;
  readonly lastSeenAge: number | null;
}

function tagId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  const id = (value as { __tag_id__?: unknown }).__tag_id__;
  return typeof id === 'string' ? id : null;
}

/** Length of the segment a→b inside a sphere. */
function chord(a: Vec3, b: Vec3, center: Vec3, radius: number): number {
  const dx = b.x - a.x; const dy = b.y - a.y; const dz = b.z - a.z;
  const len2 = dx * dx + dy * dy + dz * dz;
  if (len2 === 0) return 0;
  const fx = a.x - center.x; const fy = a.y - center.y; const fz = a.z - center.z;
  const bq = (fx * dx + fy * dy + fz * dz) / len2;
  const c = (fx * fx + fy * fy + fz * fz - radius * radius) / len2;
  const disc = bq * bq - c;
  if (disc <= 0) return 0;
  const root = Math.sqrt(disc);
  const t0 = Math.max(0, -bq - root);
  const t1 = Math.min(1, -bq + root);
  return t1 > t0 ? (t1 - t0) * Math.sqrt(len2) : 0;
}

export class Perception {
  readonly #kernel: Kernel;
  readonly #senses: Senses;
  readonly #states = new Map<EntityId, PerceiverState>();
  noises: Noise[] = [];
  blockers: SightBlocker[] = [];

  constructor(kernel: Kernel, senses: Senses) {
    this.#kernel = kernel;
    this.#senses = senses;
  }

  clear(): void {
    this.#states.clear();
    this.noises = [];
    this.blockers = [];
  }

  removed(id: EntityId): void {
    this.#states.delete(id);
    for (const state of this.#states.values()) state.known.delete(id);
  }

  #state(id: EntityId, now: number, interval: number): PerceiverState {
    let s = this.#states.get(id);
    if (s === undefined) {
      const phase = ((id * GOLDEN) % 1) * interval;
      s = { known: new Map(), heard: null, heardAt: -Infinity, nextAt: now + phase, lastAt: now };
      this.#states.set(id, s);
    }
    return s;
  }

  /** Blockers' radius at `now` (they grow over `grow` seconds, ease-out). */
  static radiusOf(b: SightBlocker, now: number): number {
    if (b.grow <= 0) return b.radius;
    const t = Math.min(1, Math.max(0, (now - b.born) / b.grow));
    return b.radius * (1 - (1 - t) * (1 - t));
  }

  static densityOf(b: SightBlocker, now: number): number {
    if (now <= b.fadeAt) return b.density;
    return b.density * Math.max(0, (b.until - now) / (b.until - b.fadeAt));
  }

  /** Fraction of sight that gets through the blockers between a and b (1: none). */
  transmittance(a: Vec3, b: Vec3, now: number): number {
    let optical = 0;
    for (const blocker of this.blockers) {
      const r = Perception.radiusOf(blocker, now);
      if (r <= 0) continue;
      // A full-density cloud crossed through its middle lets 1% through.
      optical += (Perception.densityOf(blocker, now) * chord(a, b, blocker.center, r) / (2 * r)) * Math.log(100);
    }
    return Math.exp(-optical);
  }

  #descendants(id: EntityId, out: EntityId[]): void {
    out.push(id);
    const record = this.#kernel.world.get(id);
    if (record !== undefined) for (const child of record.children) this.#descendants(child, out);
  }

  eye(record: EntityRecord, fields: Fields): Vec3 {
    return record.transform.worldPosition().__add__(new Vec3(0, fields['eye_height'] as number, 0));
  }

  aim(record: EntityRecord): Vec3 {
    const d = record.components.get(DETECTABLE);
    return record.transform.worldPosition().__add__(new Vec3(0, d === undefined ? 1 : d['height'] as number, 0));
  }

  /** Whether `aim` hides in a terrain brush volume the perceiver doesn't stand in. */
  #inBrush(from: EntityRecord, aim: Vec3): boolean {
    const field = this.#kernel.tryService(TERRAIN_SERVICE)?.current() ?? null;
    if (field === null || field.brush.length === 0) return false;
    const hiding = field.brushAt(aim.x, aim.y, aim.z);
    if (hiding === null) return false;
    const feet = from.transform.worldPosition();
    return field.brushAt(feet.x, feet.y, feet.z) !== hiding;
  }

  /** Whether `from` (a perceiver) could see `target` now, and how well (0: not). */
  visibility(from: EntityRecord, fields: Fields, target: EntityRecord, now: number): number {
    const detect = target.components.get(DETECTABLE);
    const base = detect === undefined ? 1 : detect['visibility'] as number;
    if (base <= 0) return 0;
    const eye = this.eye(from, fields);
    const aim = this.aim(target);
    // Fog, rain and snow shorten everyone's sight (the weather's visibility, when weather() is in the game).
    const range = Math.min(fields['sight_range'] as number, this.#kernel.tryService(WEATHER_SERVICE)?.conditions().visibility ?? Infinity);
    const to = aim.__sub__(eye);
    const d = to.length();
    if (d > range) return 0;
    const flat = Math.hypot(to.x, to.z);
    const close = flat <= (fields['close_range'] as number);
    const fov = fields['fov'] as number;
    if (!close && fov < 360 && flat > 1e-9) {
      const forward = from.transform.worldRotation().rotate(Vec3.FORWARD);
      const fl = Math.hypot(forward.x, forward.z);
      if (fl > 1e-9) {
        const cos = (to.x * forward.x + to.z * forward.z) / (flat * fl);
        if (cos < Math.cos(((fov / 2) * Math.PI) / 180) - 1e-12) return 0;
      }
    }
    if (this.#inBrush(from, aim)) return 0;
    const transmit = this.transmittance(eye, aim, now);
    if (transmit < MIN_TRANSMITTANCE) return 0;
    const ignore: EntityId[] = [];
    this.#descendants(from.id, ignore);
    this.#descendants(target.id, ignore);
    if (!this.#senses.clear(eye, aim, ignore)) return 0;
    const q = range * 0.25;
    const falloff = d <= q ? 1 : 1 - 0.75 * ((d - q) / Math.max(1e-9, range - q));
    return base * falloff * transmit;
  }

  /** Candidates a perceiver perceives, in world order. */
  #candidates(record: EntityRecord, fields: Fields): EntityRecord[] {
    const tag = tagId(fields['targets']);
    const world = this.#kernel.world;
    if (tag !== null) return [...world.live()].filter((r) => r.id !== record.id && r.tags.has(tag));
    const side = tagId(record.components.get(SIDE)?.['side']);
    if (side === null) {
      const name = record.placedId ?? record.prefab ?? `entity ${record.id}`;
      return fail('PP3260', `The Perception on "${name}" has no \`targets\` tag and no Side, so it can perceive no one`, {
        fix: 'Give it a Side (it perceives other sides) or set Perception(targets=SomeTag).',
      });
    }
    return world.query([SIDE]).filter(([id, s]) => id !== record.id && tagId(s!['side']) !== null && tagId(s!['side']) !== side)
      .map(([id]) => world.require(id));
  }

  /** Every perceiver whose update is due. Returns their new percepts. */
  step(now: number, emit: (type: (typeof AI_EVENTS)[keyof typeof AI_EVENTS], payload: Fields) => void,
    share: (perceiver: EntityId, target: EntityId, position: Vec3) => void): Map<EntityId, Percept> {
    const world = this.#kernel.world;
    const out = new Map<EntityId, Percept>();
    this.noises = this.noises.filter((n) => now - n.time <= NOISE_SECONDS);
    this.blockers = this.blockers.filter((b) => b.until > now);
    for (const [id, fields] of world.query([PERCEPTION])) {
      const f = fields!;
      const interval = f['interval'] as number;
      const state = this.#state(id, now, interval);
      if (now + 1e-9 < state.nextAt) continue;
      const dt = now - state.lastAt;
      state.lastAt = now;
      state.nextAt = now + interval;
      out.set(id, this.#update(world.require(id), f, state, now, dt, emit, share));
    }
    return out;
  }

  #update(record: EntityRecord, f: Fields, state: PerceiverState, now: number, dt: number,
    emit: (type: (typeof AI_EVENTS)[keyof typeof AI_EVENTS], payload: Fields) => void,
    share: (perceiver: EntityId, target: EntityId, position: Vec3) => void): Percept {
    const wrap = (id: EntityId): unknown => this.#kernel.handles.wrap(id);
    const notice = f['notice_time'] as number;
    const calm = f['calm_time'] as number;
    const memory = f['memory'] as number;
    const threshold = f['suspicious'] as number;
    const candidates = this.#candidates(record, f);
    const perceived = new Set(candidates.map((c) => c.id));
    for (const target of candidates) {
      const v = this.visibility(record, f, target, now);
      let known = state.known.get(target.id);
      if (v <= 0) {
        if (known !== undefined) {
          known.seen = false;
          known.visibility = 0;
        }
        continue;
      }
      if (known === undefined) {
        known = { awareness: 0, alerted: false, seen: true, lastPosition: target.transform.worldPosition(), lastSeen: now, visibility: v };
        state.known.set(target.id, known);
      }
      const before = known.awareness;
      known.seen = true;
      known.visibility = v;
      known.lastSeen = now;
      known.lastPosition = target.transform.worldPosition();
      known.awareness = notice <= 0 ? 1 : Math.min(1, known.awareness + (v * Math.max(dt, 1e-9)) / notice);
      if (known.awareness >= 1 && !known.alerted) {
        known.alerted = true;
        emit(AI_EVENTS.spotted, { entity: wrap(record.id), target: wrap(target.id) });
        share(record.id, target.id, known.lastPosition);
      } else if (!known.alerted && before < threshold && known.awareness >= threshold) {
        emit(AI_EVENTS.suspicious, { entity: wrap(record.id), position: known.lastPosition });
      }
    }
    // Unseen targets: hold while hunting, else calm down.
    for (const [target, known] of [...state.known]) {
      if (known.seen && perceived.has(target)) continue;
      known.seen = false;
      if (known.alerted) {
        if (now - known.lastSeen > memory) {
          known.alerted = false;
          known.awareness = Math.min(known.awareness, threshold);
          emit(AI_EVENTS.lostTarget, { entity: wrap(record.id), target: wrap(target), position: known.lastPosition });
        }
        continue;
      }
      known.awareness = calm <= 0 ? 0 : known.awareness - dt / calm;
      if (known.awareness <= 0) state.known.delete(target);
    }
    this.#hear(record, f, state, now, perceived, emit);
    return this.percept(record, f, state, now);
  }

  #hear(record: EntityRecord, f: Fields, state: PerceiverState, now: number, perceived: ReadonlySet<EntityId>,
    emit: (type: (typeof AI_EVENTS)[keyof typeof AI_EVENTS], payload: Fields) => void): void {
    const hearing = f['hearing'] as number;
    if (hearing <= 0) return;
    const ear = this.eye(record, f);
    const threshold = f['suspicious'] as number;
    for (const noise of this.noises) {
      // Each noise is considered once per perceiver: at its first update after the noise.
      if (noise.checked.has(record.id) || noise.source === record.id) continue;
      noise.checked.add(record.id);
      let range = noise.loudness * hearing;
      const d = ear.__sub__(noise.at).length();
      if (d > range) continue;
      const ignore: EntityId[] = [];
      this.#descendants(record.id, ignore);
      if (noise.source !== undefined) this.#descendants(noise.source, ignore);
      if (!this.#senses.clear(noise.at, ear, ignore)) range *= 0.5;
      if (d > range) continue;
      const strength = 1 - d / Math.max(range, 1e-9);
      state.heard = noise.at;
      state.heardAt = now;
      if (noise.source !== undefined && perceived.has(noise.source)) {
        let known = state.known.get(noise.source);
        if (known === undefined) {
          known = { awareness: 0, alerted: false, seen: false, lastPosition: noise.at, lastSeen: -Infinity, visibility: 0 };
          state.known.set(noise.source, known);
        }
        if (!known.alerted) {
          const before = known.awareness;
          known.awareness = Math.max(known.awareness, Math.min(HEARING_CAP, known.awareness + HEARING_GAIN * strength));
          known.lastPosition = noise.at;
          if (before < threshold && known.awareness >= threshold) emit(AI_EVENTS.suspicious, { entity: this.#kernel.handles.wrap(record.id), position: noise.at });
        }
      }
      emit(AI_EVENTS.heardNoise, {
        entity: this.#kernel.handles.wrap(record.id), position: noise.at,
        source: noise.source === undefined ? null : this.#kernel.handles.wrap(noise.source), kind: noise.kind ?? null,
      });
    }
  }

  percept(record: EntityRecord, f: Fields, state: PerceiverState | undefined, now: number): Percept {
    const memory = f['memory'] as number;
    const threshold = f['suspicious'] as number;
    const position = record.transform.worldPosition();
    let best: [EntityId, Known] | undefined;
    const rank = (k: Known): number => (k.alerted && k.seen ? 3 : k.alerted ? 2 : 1);
    const dist = (k: Known): number => Math.hypot(k.lastPosition.x - position.x, k.lastPosition.z - position.z);
    let awareness = 0;
    let alerted = false;
    for (const entry of state?.known ?? []) {
      const k = entry[1];
      awareness = Math.max(awareness, k.awareness);
      alerted ||= k.alerted;
      if (best === undefined) { best = entry; continue; }
      const b = best[1];
      const better = rank(k) !== rank(b) ? rank(k) > rank(b)
        : k.awareness !== b.awareness ? k.awareness > b.awareness
          : dist(k) !== dist(b) ? dist(k) < dist(b) : entry[0] < best[0];
      if (better) best = entry;
    }
    const heard = state !== undefined && state.heard !== null && now - state.heardAt <= memory ? state.heard : null;
    const alert: AlertLevel = alerted ? 'alert' : awareness >= threshold || heard !== null ? 'suspicious' : 'unaware';
    if (best === undefined) return { target: null, visible: false, position: null, distance: null, awareness, alert, heard, lastSeenAge: null };
    const [id, k] = best;
    const live = this.#kernel.world.get(id);
    const at = k.seen && live !== undefined ? live.transform.worldPosition() : k.lastPosition;
    return {
      target: id, visible: k.seen, position: at, distance: Math.hypot(at.x - position.x, at.z - position.z), awareness: k.awareness, alert, heard,
      lastSeenAge: k.lastSeen === -Infinity ? null : now - k.lastSeen,
    };
  }

  /** The current percept without updating (methods, services). */
  current(id: EntityId, now: number): Percept {
    const record = this.#kernel.world.require(id);
    return this.percept(record, record.components.get(PERCEPTION)!, this.#states.get(id), now);
  }

  known(id: EntityId): KnownTarget[] {
    const state = this.#states.get(id);
    return [...state?.known ?? []].map(([target, k]) => ({
      target, awareness: k.awareness, alerted: k.alerted, visible: k.seen, lastPosition: k.lastPosition,
    }));
  }

  awarenessOf(id: EntityId, target: EntityId): number {
    return this.#states.get(id)?.known.get(target)?.awareness ?? 0;
  }

  sees(id: EntityId, target: EntityId): boolean {
    return this.#states.get(id)?.known.get(target)?.seen === true;
  }

  lastSeen(id: EntityId, target: EntityId): Vec3 | null {
    return this.#states.get(id)?.known.get(target)?.lastPosition ?? null;
  }

  /** Make the perceiver alerted to `target` at `position` (an alarm, a squadmate's report); no Spotted. */
  alarm(id: EntityId, target: EntityId | null, position: Vec3, now: number): void {
    const record = this.#kernel.world.require(id);
    const state = this.#state(id, now, record.components.get(PERCEPTION)!['interval'] as number);
    if (target === null) {
      state.heard = position;
      state.heardAt = now;
      return;
    }
    const known = state.known.get(target);
    if (known === undefined) {
      state.known.set(target, { awareness: 1, alerted: true, seen: false, lastPosition: position, lastSeen: now, visibility: 0 });
    } else if (!known.seen) {
      known.awareness = 1;
      known.alerted = true;
      known.lastPosition = position;
      known.lastSeen = Math.max(known.lastSeen, now);
    }
  }

  forget(id: EntityId, target: EntityId | null): void {
    const state = this.#states.get(id);
    if (state === undefined) return;
    if (target === null) {
      state.known.clear();
      state.heard = null;
      state.heardAt = -Infinity;
    } else state.known.delete(target);
  }

  // ── Snapshots ──────────────────────────────────────────────────────────────

  snapshot(): Json {
    const v = (p: Vec3): Json => [p.x, p.y, p.z];
    const time = (t: number): Json => (t === -Infinity ? null : t);
    return {
      perceivers: [...this.#states].map(([id, s]) => ({
        id, heard: s.heard === null ? null : v(s.heard), heard_at: time(s.heardAt), next_at: s.nextAt, last_at: s.lastAt,
        known: [...s.known].map(([target, k]) => ({
          target, awareness: k.awareness, alerted: k.alerted, seen: k.seen, last_position: v(k.lastPosition), last_seen: time(k.lastSeen), visibility: k.visibility,
        })),
      })),
      noises: this.noises.map((n) => ({
        at: v(n.at), loudness: n.loudness, time: n.time, source: n.source ?? null, kind: n.kind ?? null, checked: [...n.checked],
      })),
      blockers: this.blockers.map((b) => ({
        center: v(b.center), radius: b.radius, density: b.density, born: b.born, grow: b.grow, fade_at: b.fadeAt, until: b.until,
      })),
    };
  }

  restore(json: Json, alive: (id: EntityId) => boolean): void {
    const o = json as JsonObject;
    const vec = (j: Json): Vec3 => {
      const [x, y, z] = j as number[];
      return new Vec3(x!, y!, z!);
    };
    const time = (j: Json | undefined): number => (j === null || j === undefined ? -Infinity : j as number);
    this.clear();
    for (const p of o['perceivers'] as JsonObject[]) {
      const id = p['id'] as EntityId;
      if (!alive(id)) continue;
      const known = new Map<EntityId, Known>();
      for (const k of p['known'] as JsonObject[]) {
        const target = k['target'] as EntityId;
        if (!alive(target)) continue;
        known.set(target, {
          awareness: k['awareness'] as number, alerted: k['alerted'] === true, seen: k['seen'] === true,
          lastPosition: vec(k['last_position']!), lastSeen: time(k['last_seen']), visibility: k['visibility'] as number,
        });
      }
      this.#states.set(id, {
        known, heard: p['heard'] === null ? null : vec(p['heard']!), heardAt: time(p['heard_at']),
        nextAt: p['next_at'] as number, lastAt: p['last_at'] as number,
      });
    }
    this.noises = (o['noises'] as JsonObject[]).map((n) => ({
      at: vec(n['at']!), loudness: n['loudness'] as number, time: n['time'] as number,
      ...(n['source'] !== null && { source: n['source'] as EntityId }), ...(n['kind'] !== null && { kind: n['kind'] as string }),
      checked: new Set(n['checked'] as EntityId[]),
    }));
    this.blockers = (o['blockers'] as JsonObject[]).map((b) => ({
      center: vec(b['center']!), radius: b['radius'] as number, density: b['density'] as number, born: b['born'] as number,
      grow: b['grow'] as number, fadeAt: b['fade_at'] as number, until: b['until'] as number,
    }));
  }
}
