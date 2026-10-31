/**
 * Fog of war (gameplay state): per team, which ground cells are visible now and which have
 * been explored. Sources are `Vision` entities (team: `Vision.team`, else their combat
 * `Side`) and timed reveals (`ctx.ai.fog.reveal`). Every FOG_INTERVAL seconds each team's
 * visible bits are recomputed: a source sees the cells whose centers lie within its range
 * and in straight line of sight across the grid — a cell is opaque when static geometry
 * fills it at eye height (nav's world; without nav nothing is opaque). An opaque cell is
 * itself seen (you see the wall) but hides what lies behind it. Reveals ignore walls.
 *
 * The grid is sparse: 16×16-cell chunks, created where a team has looked, so maps have no
 * bounds to declare. Cells hold bit 1 (visible) and bit 2 (explored).
 */

import { fail } from '../../../core/index.js';
import type { Json, JsonObject } from '../../../resource/index.js';
import type { FogField } from '../../services/index.js';

export const FOG_INTERVAL = 0.2;
/** Eye height (m) at which cells are tested for opacity. */
export const FOG_EYE = 1.5;
const CHUNK = 16;
const MAX_FIELD = 4096;

export interface FogSource {
  readonly team: string;
  readonly x: number;
  readonly z: number;
  /** Ground height under the source; cells are tested at this + FOG_EYE. */
  readonly y: number;
  readonly range: number;
  /** False for reveals: walls don't stop them. */
  readonly occluded: boolean;
}

export interface Reveal {
  readonly team: string;
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  readonly until: number;
}

function chunkKey(ci: number, ck: number): string {
  return `${ci},${ck}`;
}

export class FogGrid {
  readonly cell: number;
  readonly #teams = new Map<string, Map<string, Uint8Array>>();
  reveals: Reveal[] = [];
  version = 0;
  nextAt = 0;

  constructor(cell: number) {
    if (!(Number.isFinite(cell) && cell > 0)) fail('PP3285', `fog cell must be a number of meters greater than 0, got ${cell}`);
    this.cell = cell;
  }

  clear(): void {
    this.#teams.clear();
    this.reveals = [];
    this.version++;
    this.nextAt = 0;
  }

  teams(): string[] {
    return [...this.#teams.keys()].sort();
  }

  #chunk(team: string, i: number, k: number, create: boolean): Uint8Array | undefined {
    let chunks = this.#teams.get(team);
    if (chunks === undefined) {
      if (!create) return undefined;
      chunks = new Map();
      this.#teams.set(team, chunks);
    }
    const key = chunkKey(Math.floor(i / CHUNK), Math.floor(k / CHUNK));
    let chunk = chunks.get(key);
    if (chunk === undefined && create) {
      chunk = new Uint8Array(CHUNK * CHUNK);
      chunks.set(key, chunk);
    }
    return chunk;
  }

  #slot(i: number, k: number): number {
    return (((k % CHUNK) + CHUNK) % CHUNK) * CHUNK + (((i % CHUNK) + CHUNK) % CHUNK);
  }

  bits(team: string, x: number, z: number): number {
    const i = Math.floor(x / this.cell);
    const k = Math.floor(z / this.cell);
    return this.#chunk(team, i, k, false)?.[this.#slot(i, k)] ?? 0;
  }

  /** Recompute visibility. `opaque(x, z, y)` tests a cell center at height y. */
  update(sources: readonly FogSource[], opaque: (x: number, z: number, y: number) => boolean): void {
    const before = new Map<string, Map<string, Uint8Array>>();
    for (const [team, chunks] of this.#teams) {
      const copy = new Map<string, Uint8Array>();
      for (const [key, chunk] of chunks) {
        copy.set(key, chunk.slice());
        for (let s = 0; s < chunk.length; s++) chunk[s] = chunk[s]! & 2;
      }
      before.set(team, copy);
    }
    const c = this.cell;
    const center = (i: number): number => (i + 0.5) * c;
    const cache = new Map<string, boolean>();
    const blocked = (i: number, k: number, y: number): boolean => {
      const key = `${i},${k},${y}`;
      let v = cache.get(key);
      if (v === undefined) {
        v = opaque(center(i), center(k), y);
        cache.set(key, v);
      }
      return v;
    };
    const mark = (team: string, i: number, k: number): void => {
      const chunk = this.#chunk(team, i, k, true)!;
      chunk[this.#slot(i, k)] = 3;
    };
    for (const src of sources) {
      const si = Math.floor(src.x / c);
      const sk = Math.floor(src.z / c);
      const reach = Math.ceil(src.range / c);
      const eye = src.y + FOG_EYE;
      for (let dk = -reach; dk <= reach; dk++) {
        for (let di = -reach; di <= reach; di++) {
          const i = si + di;
          const k = sk + dk;
          if (Math.hypot(center(i) - src.x, center(k) - src.z) > src.range) continue;
          if (src.occluded && !this.#lineOpen(si, sk, i, k, eye, blocked)) continue;
          mark(src.team, i, k);
        }
      }
    }
    let changed = false;
    for (const [team, chunks] of this.#teams) {
      const old = before.get(team);
      for (const [key, chunk] of chunks) {
        const prev = old?.get(key);
        if (prev === undefined || prev.some((b, s) => b !== chunk[s])) {
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
    if (changed) this.version++;
  }

  /** Whether the cells strictly between (si, sk) and (i, k) are all clear. */
  #lineOpen(si: number, sk: number, i: number, k: number, y: number, blocked: (i: number, k: number, y: number) => boolean): boolean {
    const steps = Math.max(Math.abs(i - si), Math.abs(k - sk)) * 2;
    let pi = si;
    let pk = sk;
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const ci = Math.floor(si + 0.5 + (i - si) * t);
      const ck = Math.floor(sk + 0.5 + (k - sk) * t);
      if ((ci === pi && ck === pk) || (ci === i && ck === k) || (ci === si && ck === sk)) continue;
      pi = ci;
      pk = ck;
      if (blocked(ci, ck, y)) return false;
    }
    return true;
  }

  field(team: string, minX: number, minZ: number, maxX: number, maxZ: number): FogField {
    const c = this.cell;
    const i0 = Math.floor(minX / c);
    const k0 = Math.floor(minZ / c);
    const cols = Math.min(MAX_FIELD, Math.max(0, Math.floor(maxX / c) - i0 + 1));
    const rows = Math.min(MAX_FIELD, Math.max(0, Math.floor(maxZ / c) - k0 + 1));
    const cells = new Uint8Array(cols * rows);
    for (let r = 0; r < rows; r++) {
      for (let q = 0; q < cols; q++) {
        const chunk = this.#chunk(team, i0 + q, k0 + r, false);
        if (chunk !== undefined) cells[r * cols + q] = chunk[this.#slot(i0 + q, k0 + r)]!;
      }
    }
    return { cell: c, minX: i0 * c, minZ: k0 * c, cols, rows, cells };
  }

  snapshot(): Json {
    return {
      version: this.version,
      next_at: this.nextAt,
      teams: [...this.#teams].map(([team, chunks]) => [team, [...chunks].map(([key, chunk]) => [key, [...chunk].join('')])]),
      reveals: this.reveals.map((r) => ({ team: r.team, x: r.x, z: r.z, radius: r.radius, until: r.until })),
    };
  }

  restore(json: Json): void {
    const o = json as JsonObject;
    this.#teams.clear();
    for (const [team, chunks] of o['teams'] as [string, [string, string][]][]) {
      const map = new Map<string, Uint8Array>();
      for (const [key, digits] of chunks) map.set(key, Uint8Array.from(digits, (d) => Number(d)));
      this.#teams.set(team, map);
    }
    this.reveals = (o['reveals'] as JsonObject[]).map((r) => ({
      team: r['team'] as string, x: r['x'] as number, z: r['z'] as number, radius: r['radius'] as number, until: r['until'] as number,
    }));
    this.version = o['version'] as number;
    this.nextAt = o['next_at'] as number;
  }
}
