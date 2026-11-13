/**
 * A Crowd: rows of seeded, code-built spectators along a straight run (stadium terraces,
 * grandstands, a sideline, a concert pit), with an optional stepped stand under them. The
 * same spectators a Track's stands carry, for venues that aren't race circuits.
 *
 * Entity-local: the run is `length` meters along x, centred on the origin; spectators face
 * +z; row k stands at y = k × row_rise, its centre z = −(k + 0.5) × row_gap. With `stands`,
 * one block per row fills from its floor down to −stand_depth, so the rows read as steps.
 * Spectators can be split into `groups` by a seeded draw and one built per entity (`group`),
 * so a game can move each group separately (a bouncing end, a Mexican wave). Pure: spec in,
 * surfaces out; same data, same crowd.
 */

import { latheMesh } from './lathe.js';
import { cross, normalize } from './mesh.js';
import type { Surface, V3 } from './mesh.js';
import { CROWD_PALETTE, Painter, SKIN, hash01 } from './track.js';
import type { Rgba4, TrackPart } from './track.js';

export interface CrowdSpec {
  readonly length: number;
  readonly rows: number;
  readonly rowGap: number;
  readonly rowRise: number;
  /** Spectators per meter per row (before `fill`). */
  readonly density: number;
  /** Share of places taken, 0..1. */
  readonly fill: number;
  /** Share of spectators with their arms up, 0..1. */
  readonly armsUp: number;
  /** Share of those with arms up who hold a scarf over their head, 0..1. */
  readonly scarves: number;
  readonly colors: readonly Rgba4[];
  readonly scarfColors: readonly Rgba4[];
  readonly stands: boolean;
  readonly standColor: Rgba4;
  readonly standDepth: number;
  readonly groups: number;
  readonly group: number;
  readonly max: number;
  readonly seed: number;
  readonly collide: boolean;
}

export interface CrowdGeometry {
  readonly parts: readonly TrackPart[];
  readonly spectators: number;
}

/** What is wrong with a spec (a sentence), or undefined. */
export function crowdProblem(spec: CrowdSpec): string | undefined {
  const positive: [string, number][] = [['length', spec.length], ['row_gap', spec.rowGap], ['density', spec.density]];
  for (const [name, value] of positive) if (!(value > 0 && Number.isFinite(value))) return `${name} must be a number above 0, got ${value}`;
  const nonNegative: [string, number][] = [['row_rise', spec.rowRise], ['stand_depth', spec.standDepth]];
  for (const [name, value] of nonNegative) if (!(value >= 0 && Number.isFinite(value))) return `${name} can't be negative, got ${value}`;
  const shares: [string, number][] = [['fill', spec.fill], ['arms_up', spec.armsUp], ['scarves', spec.scarves]];
  for (const [name, value] of shares) if (!(value >= 0 && value <= 1)) return `${name} is a share from 0 to 1, got ${value}`;
  if (!Number.isInteger(spec.rows) || spec.rows < 1 || spec.rows > 60) return `rows must be a whole number from 1 to 60, got ${spec.rows}`;
  if (!Number.isInteger(spec.max) || spec.max < 0) return `max must be a whole number >= 0, got ${spec.max}`;
  if (!Number.isInteger(spec.groups) || spec.groups < 1) return `groups must be a whole number >= 1, got ${spec.groups}`;
  if (!Number.isInteger(spec.group) || spec.group < 0 || spec.group >= spec.groups) return `group must be a whole number from 0 to groups - 1 (${spec.groups - 1}), got ${spec.group}`;
  return undefined;
}

const UP: V3 = [0, 1, 0];
const along = (p: V3, d: V3, s: number): [number, number, number] => [p[0] + d[0] * s, p[1] + d[1] * s, p[2] + d[2] * s];

export function buildCrowd(spec: CrowdSpec): CrowdGeometry {
  const parts: TrackPart[] = [];
  const flat = (color: Rgba4, roughness: number) => ({ color, texture: null, tile: 1, roughness, metallic: 0 });
  const half = spec.length / 2;
  const { rows, rowGap: gap, rowRise: rise } = spec;

  if (spec.stands) {
    const steps = new Painter();
    for (let k = 0; k < rows; k++) {
      const top = k * rise;
      const bottom = -spec.standDepth;
      if (top - bottom <= 1e-4) continue;
      const c: V3 = [0, (top + bottom) / 2, -(k + 0.5) * gap];
      steps.box(c, [1, 0, 0], UP, [0, 0, 1], half, (top - bottom) / 2, gap / 2, [1, 1, 1, 1]);
    }
    const surface = steps.build();
    if (surface.indices.length > 0) parts.push({ name: 'crowd:stands', surface, material: flat(spec.standColor, 0.9), collide: spec.collide, shadows: true });
  }

  let spectators = 0;
  const body = latheMesh({ profile: [[0.15, 0], [0.19, 0.32], [0.21, 0.66], [0.15, 0.84], [0.06, 0.9]], segments: 6, sweep: 360, caps: true, hard: false, tile: 1 });
  const head = latheMesh({ profile: [[0, 0.91], [0.09, 0.95], [0.115, 1.03], [0.09, 1.11], [0, 1.14]], segments: 6, sweep: 360, caps: false, hard: false, tile: 1 });
  const crowd = new Painter();
  const palette = spec.colors.length > 0 ? spec.colors : CROWD_PALETTE;
  const step = 1 / spec.density;
  outer: for (let k = 0; k < rows; k++) {
    for (let x = -half + step * 0.5, i = 0; x < half; x += step, i++) {
      if (spectators >= spec.max) break outer;
      const r = (salt: number): number => hash01(spec.seed, k, i, salt);
      if (r(8) >= spec.fill) continue;
      if (spec.groups > 1 && Math.min(spec.groups - 1, Math.floor(r(9) * spec.groups)) !== spec.group) continue;
      const px = Math.max(-half, Math.min(half, x + (r(1) - 0.5) * step * 0.6));
      const pz = -(k + 0.5) * gap + (r(2) - 0.5) * gap * 0.3;
      const base: V3 = [px, k * rise, pz];
      const yaw = (r(3) - 0.5) * 0.6;
      const scale = 0.9 + r(4) * 0.2;
      const shirt = palette[Math.floor(r(5) * palette.length) % palette.length]!;
      crowd.place(body, base, yaw, scale, shirt);
      crowd.place(head, base, yaw, scale, SKIN[Math.floor(r(6) * SKIN.length) % SKIN.length]!);
      if (r(7) < spec.armsUp) {
        // Arms up: two thin boxes from the shoulders; some hold a scarf between their hands.
        const fwd: V3 = [Math.sin(yaw), 0, Math.cos(yaw)];
        const side: V3 = [Math.cos(yaw), 0, -Math.sin(yaw)];
        const scarf = r(10) < spec.scarves;
        const spread = scarf ? 0.55 : 0.3;
        for (const s of [1, -1]) {
          const c = along(along(base, side, s * 0.24 * scale), UP, 1.02 * scale);
          const tilt = normalize([side[0] * s * spread, 1, side[2] * s * spread]);
          const across = normalize(cross(tilt, fwd));
          crowd.box(c, across, tilt, fwd, 0.04 * scale, 0.26 * scale, 0.04 * scale, shirt);
        }
        if (scarf) {
          const colors = spec.scarfColors.length > 0 ? spec.scarfColors : [shirt];
          const color = colors[Math.floor(r(11) * colors.length) % colors.length]!;
          const c = along(base, UP, 1.5 * scale);
          crowd.box(c, side, UP, fwd, 0.42 * scale, 0.07 * scale, 0.015 * scale, color);
        }
      }
      spectators++;
    }
  }
  const surface: Surface = crowd.build();
  if (surface.indices.length > 0) parts.push({ name: 'crowd:spectators', surface, material: flat([1, 1, 1, 1], 0.88), collide: false, shadows: false });
  return { parts, spectators };
}
