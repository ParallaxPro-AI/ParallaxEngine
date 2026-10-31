/**
 * Tactical queries: places to stand, chosen from candidates by tests and scores.
 *
 * Cover (`find_cover`): candidates are the `CoverPoint` entities within `radius` of the
 * agent, or — when there are none — points sampled on rings around the agent (16
 * directions, every 2 m), snapped onto nav ground. A candidate *hides* the agent when the
 * line from the threat's eye to a crouched head over it (0.75 × the cover's height; 0.9 m
 * for sampled points) is blocked. With `peek`, it must also let the agent see the threat
 * standing up (eye 1.6 m): fighting cover rather than hiding cover. Hidden candidates
 * closer than `min_distance` to the threat, or reserved by another living agent, are out;
 * the nearest to the agent wins (ties: candidate order), and with nav it must be reachable
 * (the first 8 by distance are tried). The winner is reserved for the agent until it
 * releases it, reserves another, or dies — so two units never pick the same crate.
 *
 * Flanking (`flank_position`): points `distance` from the threat at 90° to either side of
 * the agent's line to it (then 60° and 120°), on nav ground, reachable, with a clear shot
 * at the threat. `side` "right" / "left" is the agent's own right or left as it faces the
 * threat; without it the nearer good point wins.
 *
 * Safe spots (`safe_spot`): ring samples (24 directions × 3 radii up to `radius`) on nav
 * ground and reachable, scored by the distance to the nearest threat, plus `radius` when
 * hidden from every threat.
 */

import { Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import type { Kernel } from '../../kernel/index.js';
import type { Json } from '../../../resource/index.js';
import type { NavService } from '../../services/index.js';
import { COVER_POINT } from './schemas.js';

const STAND_EYE = 1.6;
const SAMPLED_HEAD = 0.9;
const AGENT_RADIUS = 0.4;
const REACH_TRIES = 8;

export interface TacticsWorld {
  /** Occlusion: whether the segment is clear, ignoring these entities. */
  clear(a: Vec3, b: Vec3, ignore: readonly EntityId[]): boolean;
  /** Nav, when the game has it. */
  nav(): NavService | undefined;
}

interface Candidate {
  readonly key: string;
  readonly at: Vec3;
  /** Height of the head to hide. */
  readonly head: number;
  readonly entity?: EntityId;
}

export class Tactics {
  readonly #kernel: Kernel;
  readonly #world: TacticsWorld;
  /** Candidate key → the agent holding it. */
  readonly #reserved = new Map<string, EntityId>();

  constructor(kernel: Kernel, world: TacticsWorld) {
    this.#kernel = kernel;
    this.#world = world;
  }

  clear(): void {
    this.#reserved.clear();
  }

  removed(id: EntityId): void {
    for (const [key, holder] of [...this.#reserved]) if (holder === id || key === `e${id}`) this.#reserved.delete(key);
  }

  release(agent: EntityId): void {
    for (const [key, holder] of [...this.#reserved]) if (holder === agent) this.#reserved.delete(key);
  }

  /** The cover an agent holds, if any. */
  held(agent: EntityId): string | undefined {
    for (const [key, holder] of this.#reserved) if (holder === agent) return key;
    return undefined;
  }

  #ground(at: Vec3): Vec3 | null {
    const nav = this.#world.nav();
    if (nav === undefined) return at;
    return nav.nearest(at, AGENT_RADIUS, 1);
  }

  #reachable(from: Vec3, to: Vec3): boolean {
    const nav = this.#world.nav();
    return nav === undefined || nav.path(from, to, AGENT_RADIUS) !== null;
  }

  #candidates(agent: Vec3, radius: number): Candidate[] {
    const world = this.#kernel.world;
    const points: Candidate[] = [];
    for (const [id, f] of world.query([COVER_POINT])) {
      const at = world.require(id).transform.worldPosition();
      if (Math.hypot(at.x - agent.x, at.z - agent.z) > radius) continue;
      points.push({ key: `e${id}`, at, head: 0.75 * (f!['height'] as number), entity: id });
    }
    if (points.length > 0) return points;
    for (let r = 2; r <= radius + 1e-9; r += 2) {
      for (let d = 0; d < 16; d++) {
        const a = (d / 16) * 2 * Math.PI;
        const at = this.#ground(new Vec3(agent.x + Math.sin(a) * r, agent.y, agent.z + Math.cos(a) * r));
        if (at === null) continue;
        points.push({ key: `p${Math.round(at.x * 4)},${Math.round(at.z * 4)}`, at, head: SAMPLED_HEAD });
      }
    }
    return points;
  }

  findCover(agent: EntityId, threat: Vec3, ignore: readonly EntityId[], options: { radius: number; minDistance: number; peek: boolean; reserve: boolean }): Vec3 | null {
    const from = this.#kernel.world.require(agent).transform.worldPosition();
    const eye = threat.__add__(new Vec3(0, STAND_EYE, 0));
    const ok: { c: Candidate; d: number; order: number }[] = [];
    this.#candidates(from, options.radius).forEach((c, order) => {
      const holder = this.#reserved.get(c.key);
      if (holder !== undefined && holder !== agent && this.#kernel.world.isAlive(holder)) return;
      if (Math.hypot(c.at.x - threat.x, c.at.z - threat.z) < options.minDistance) return;
      const skip = [...ignore, agent, ...(c.entity === undefined ? [] : [c.entity])];
      if (this.#world.clear(eye, c.at.__add__(new Vec3(0, c.head, 0)), skip)) return;
      if (options.peek && !this.#world.clear(c.at.__add__(new Vec3(0, STAND_EYE, 0)), eye, skip)) return;
      ok.push({ c, d: Math.hypot(c.at.x - from.x, c.at.z - from.z), order });
    });
    ok.sort((a, b) => a.d - b.d || a.order - b.order);
    for (const { c } of ok.slice(0, REACH_TRIES)) {
      if (!this.#reachable(from, c.at)) continue;
      if (options.reserve) {
        this.release(agent);
        this.#reserved.set(c.key, agent);
      }
      return c.at;
    }
    return null;
  }

  flankPosition(agent: EntityId, threat: Vec3, ignore: readonly EntityId[], distance: number, side: 'left' | 'right' | null): Vec3 | null {
    const from = this.#kernel.world.require(agent).transform.worldPosition();
    let dx = from.x - threat.x;
    let dz = from.z - threat.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-9) { dx = 0; dz = -1; } else { dx /= len; dz /= len; }
    // The agent faces the threat along (-dx, -dz); its right is (-dz, dx).
    const sides = side === null ? [1, -1] : side === 'right' ? [1] : [-1];
    const eye = threat.__add__(new Vec3(0, STAND_EYE, 0));
    let best: { at: Vec3; d: number } | null = null;
    for (const angle of [90, 60, 120]) {
      for (const s of sides) {
        // Rotate the threat→agent direction about the threat: +90° lands on the agent's right.
        const a = (s * angle * Math.PI) / 180;
        const rx = dx * Math.cos(a) - dz * Math.sin(a);
        const rz = dx * Math.sin(a) + dz * Math.cos(a);
        const at = this.#ground(new Vec3(threat.x + rx * distance, from.y, threat.z + rz * distance));
        if (at === null) continue;
        if (!this.#world.clear(at.__add__(new Vec3(0, STAND_EYE, 0)), eye, [...ignore, agent])) continue;
        if (!this.#reachable(from, at)) continue;
        const d = Math.hypot(at.x - from.x, at.z - from.z);
        if (best === null || d < best.d) best = { at, d };
      }
      if (best !== null) return best.at;
    }
    return null;
  }

  safeSpot(agent: EntityId, threats: readonly Vec3[], ignore: readonly EntityId[], radius: number): Vec3 | null {
    const from = this.#kernel.world.require(agent).transform.worldPosition();
    let best: { at: Vec3; score: number } | null = null;
    for (const r of [radius / 3, (2 * radius) / 3, radius]) {
      for (let d = 0; d < 24; d++) {
        const a = (d / 24) * 2 * Math.PI;
        const at = this.#ground(new Vec3(from.x + Math.sin(a) * r, from.y, from.z + Math.cos(a) * r));
        if (at === null) continue;
        const head = at.__add__(new Vec3(0, SAMPLED_HEAD, 0));
        const nearest = Math.min(...threats.map((t) => Math.hypot(t.x - at.x, t.z - at.z)));
        const hidden = threats.every((t) => !this.#world.clear(t.__add__(new Vec3(0, STAND_EYE, 0)), head, [...ignore, agent]));
        const score = nearest + (hidden ? radius : 0);
        if (best !== null && score <= best.score) continue;
        if (!this.#reachable(from, at)) continue;
        best = { at, score };
      }
    }
    return best?.at ?? null;
  }

  snapshot(): Json {
    return [...this.#reserved].map(([key, id]) => [key, id]);
  }

  restore(json: Json, alive: (id: EntityId) => boolean): void {
    this.#reserved.clear();
    for (const [key, id] of json as [string, EntityId][]) if (alive(id)) this.#reserved.set(key, id);
  }
}
