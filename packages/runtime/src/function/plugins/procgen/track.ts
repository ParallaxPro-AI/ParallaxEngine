/**
 * Race tracks: everything a circuit is built from, laid along a Spline's centerline from one
 * Track spec — crowned tarmac with painted edge lines, striped kerbs (corners, apexes or the
 * whole lap), a run-off verge pinned to the ground, an armco rail on posts or a concrete
 * wall, tyre walls on the outside of corners, stepped grandstands packed with spectators, a
 * start gantry with its lights over a chequered line, and trackside boards. Pure: centerline
 * + spec + ground in, surfaces out; same data, same track (the crowd is seeded).
 *
 * Space. Everything is in the owning entity's local space, on the centerline's frames
 * (x = right of travel, y = the frame's up). `ground(x, z)` is the terrain height in that
 * space, or null (no terrain): with ground, the ribbon is raised wherever any part of the
 * drivable section (tarmac + kerbs) would be inside it (ramped so it never steps), the
 * run-off's outer edge and every post, stand and spectator stand on it.
 *
 * Corners. The centerline's signed curvature (positive: turning right, so the inside is the
 * right side), smoothed over ~10 m; a corner is a run tighter than `kerbRadius`, widened by
 * `kerbExtend` meters each way. Kerbs follow corners ("corners": both sides; "apex": the
 * inside), tyre walls their outsides.
 *
 * Racing line. A lateral offset per centerline sample: towards the inside where the track
 * turns, towards the outside within 35 m before and after a corner, smoothed, kept
 * 1.5 m inside the edges — the line the AI aims along, exported by Track.racing_line().
 *
 * Parts (one material each, colors per vertex where it varies): tarmac, edge lines, kerbs,
 * run-off, barrier rail/wall, barrier posts, props (tyres, gantry, stands' boards),
 * gantry lamps (unlit), finish line, stands, crowd. The tarmac, kerbs, run-off and (with
 * `barrierCollide`) barriers, tyres and gantry columns collide.
 */

import { latheMesh } from './lathe.js';
import { MeshBuilder, cross, dot, normalize, sub } from './mesh.js';
import type { Surface, V3 } from './mesh.js';
import { sampleAt } from './spline.js';
import type { Centerline, Sample } from './spline.js';
import { sweepLayer } from './sweep.js';
import type { Outline, Profile } from './sweep.js';
import { trackBarrierOffset } from './track_grade.js';

export type Rgba4 = readonly [number, number, number, number];
export type KerbMode = 'corners' | 'apex' | 'full' | 'none';
export type RunoffKind = 'gravel' | 'grass' | 'tarmac' | 'none';
export type BarrierKind = 'armco' | 'wall' | 'none';
export type CrowdSide = 'both' | 'left' | 'right';
export type Ground = (x: number, z: number) => number;

export interface TrackMaterial {
  readonly color: Rgba4;
  readonly texture: string | null;
  /** Meters per texture repeat. */
  readonly tile: number;
  readonly roughness: number;
  readonly metallic: number;
  readonly unlit?: boolean;
}

export interface TrackSpec {
  readonly width: number;
  readonly crown: number;
  readonly surface: TrackMaterial;
  readonly edgeLines: { readonly width: number; readonly inset: number; readonly color: Rgba4 } | null;
  readonly kerbs: KerbMode;
  readonly kerbWidth: number;
  readonly kerbHeight: number;
  readonly kerbStripe: number;
  readonly kerbColors: readonly Rgba4[];
  readonly kerbRadius: number;
  readonly kerbExtend: number;
  readonly runoff: RunoffKind;
  readonly runoffWidth: number;
  readonly runoffColor: Rgba4 | null;
  readonly barrier: BarrierKind;
  readonly barrierGap: number;
  readonly barrierHeight: number;
  readonly barrierColors: readonly Rgba4[];
  readonly postEvery: number;
  readonly barrierCollide: boolean;
  readonly tyreWalls: boolean;
  readonly tyreColors: readonly Rgba4[];
  /** Lap fractions [from, to] with spectators (from > to wraps over the start on a closed track). */
  readonly crowd: readonly (readonly [number, number])[];
  readonly crowdSide: CrowdSide;
  readonly crowdRows: number;
  readonly crowdRowGap: number;
  readonly crowdRowRise: number;
  /** Spectators per meter per row. */
  readonly crowdDensity: number;
  readonly crowdSetback: number;
  readonly crowdMax: number;
  readonly stands: boolean;
  readonly standColor: Rgba4;
  readonly crowdColors: readonly Rgba4[];
  readonly gantry: boolean;
  /** Meters along the centerline of the start/finish line. */
  readonly start: number;
  readonly gantryColor: Rgba4;
  readonly finishLine: boolean;
  readonly signsEvery: number;
  readonly signColors: readonly Rgba4[];
  readonly seed: number;
  readonly collide: boolean;
}

export interface TrackPart {
  readonly name: string;
  readonly surface: Surface;
  readonly material: TrackMaterial;
  readonly collide: boolean;
  readonly shadows: boolean;
}

export interface TrackCorner {
  /** Meters along the centerline (start may be negative / end beyond the length on a closed track: it wraps). */
  readonly start: number;
  readonly end: number;
  readonly apex: number;
  /** The inside of the turn: 1 right, -1 left. */
  readonly side: 1 | -1;
  /** Tightest radius in the corner, meters. */
  readonly radius: number;
}

export interface TrackGeometry {
  readonly parts: readonly TrackPart[];
  readonly corners: readonly TrackCorner[];
  /** Kerbed stretches per side (meters along, wrapped into [0, length]). */
  readonly kerbs: readonly { readonly start: number; readonly end: number; readonly side: 1 | -1 }[];
  /** Racing line: signed meters along `right` from the centerline, per centerline sample. */
  readonly racing: readonly number[];
  /** How far each centerline sample was raised to clear the ground. */
  readonly lift: readonly number[];
  readonly spectators: number;
}

// ── Defaults and palettes (sRGB) ────────────────────────────────────────────────

const RUNOFF_COLORS: Readonly<Record<Exclude<RunoffKind, 'none'>, Rgba4>> = {
  gravel: [0.70, 0.61, 0.46, 1],
  grass: [0.37, 0.49, 0.24, 1],
  tarmac: [0.33, 0.33, 0.36, 1],
};
const ARMCO: Rgba4 = [0.79, 0.8, 0.82, 1];
const CONCRETE: Rgba4 = [0.72, 0.71, 0.68, 1];
const POST: Rgba4 = [0.47, 0.49, 0.52, 1];
const STEEL: Rgba4 = [0.55, 0.57, 0.6, 1];
const WHITE: Rgba4 = [0.95, 0.93, 0.88, 1];
const BLACK: Rgba4 = [0.08, 0.08, 0.09, 1];
const LAMP: Rgba4 = [1, 0.16, 0.1, 1];
const SKIN: readonly Rgba4[] = [[0.93, 0.76, 0.62, 1], [0.78, 0.57, 0.42, 1], [0.55, 0.38, 0.27, 1], [0.36, 0.25, 0.18, 1]];
export const CROWD_PALETTE: readonly Rgba4[] = [
  [0.88, 0.27, 0.25, 1], [0.95, 0.93, 0.88, 1], [0.31, 0.76, 1, 1], [1, 0.62, 0.18, 1], [0.75, 0.36, 1, 1],
  [0.25, 0.66, 0.36, 1], [0.96, 0.89, 0.69, 1], [0.18, 0.5, 0.85, 1], [0.91, 0.65, 0.63, 1], [0.25, 0.28, 0.34, 1],
];
export const SIGN_PALETTE: readonly Rgba4[] = [[0.88, 0.27, 0.25, 1], [0.12, 0.23, 0.42, 1], [1, 0.62, 0.18, 1], [0.15, 0.15, 0.17, 1]];

/** Where the barrier stands (meters from the centerline). */
export function barrierOffset(spec: TrackSpec): number {
  return trackBarrierOffset({
    width: spec.width, kerbs: spec.kerbs, kerbWidth: spec.kerbWidth, runoff: spec.runoff, runoffWidth: spec.runoffWidth, barrierGap: spec.barrierGap,
  });
}

/** What is wrong with a spec (a sentence), or undefined. */
export function trackProblem(spec: TrackSpec): string | undefined {
  const positive: [string, number][] = [
    ['width', spec.width], ['kerbs.width', spec.kerbWidth], ['kerbs.height', spec.kerbHeight], ['kerbs.stripe', spec.kerbStripe],
    ['kerbs.radius', spec.kerbRadius], ['runoff.width', spec.runoffWidth], ['barrier.height', spec.barrierHeight], ['barrier.post_every', spec.postEvery],
    ['crowd.row_gap', spec.crowdRowGap], ['crowd.density', spec.crowdDensity], ['edge_lines.width', spec.edgeLines?.width ?? 1],
  ];
  for (const [name, value] of positive) if (!(value > 0 && Number.isFinite(value))) return `${name} must be a number above 0, got ${value}`;
  const nonNegative: [string, number][] = [
    ['surface.crown', spec.crown], ['kerbs.extend', spec.kerbExtend], ['barrier.gap', spec.barrierGap], ['crowd.row_rise', spec.crowdRowRise],
    ['crowd.setback', spec.crowdSetback], ['signs.every', spec.signsEvery], ['start', spec.start],
  ];
  for (const [name, value] of nonNegative) if (!(value >= 0 && Number.isFinite(value))) return `${name} can't be negative, got ${value}`;
  if (spec.crown > spec.width / 4) return `surface.crown ${spec.crown} m is too high for a ${spec.width} m road (at most width / 4)`;
  if (!Number.isInteger(spec.crowdRows) || spec.crowdRows < 1 || spec.crowdRows > 40) return `crowd.rows must be a whole number from 1 to 40, got ${spec.crowdRows}`;
  if (!Number.isInteger(spec.crowdMax) || spec.crowdMax < 0) return `crowd.max must be a whole number >= 0, got ${spec.crowdMax}`;
  for (let i = 0; i < spec.crowd.length; i++) {
    const [a, b] = spec.crowd[i]!;
    if (!(a >= 0 && a <= 1 && b >= 0 && b <= 1) || a === b) return `crowd.sections[${i}] [${a}, ${b}] must be two different lap fractions in 0..1`;
  }
  if (spec.edgeLines !== null && spec.edgeLines.inset + spec.edgeLines.width >= spec.width / 2) return 'edge lines (inset + width) must fit inside half the road';
  if (spec.kerbColors.length === 0 && spec.kerbs !== 'none') return 'kerbs.colors needs at least one color';
  return undefined;
}

// ── Small helpers ───────────────────────────────────────────────────────────────

/** Deterministic 0..1 from integers (seeded variety without a stream to keep in order). */
function hash01(...n: number[]): number {
  let h = 0x811c9dc5;
  for (const v of n) {
    h = Math.imul(h ^ (v | 0), 0x01000193);
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 12;
  }
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const flat = (v: V3): [number, number, number] => normalize([v[0], 0, v[2]]);
const UP: V3 = [0, 1, 0];
const along = (p: V3, d: V3, s: number): [number, number, number] => [p[0] + d[0] * s, p[1] + d[1] * s, p[2] + d[2] * s];

/** Box-filter `values` twice with a half-width of `radius` samples. */
function smooth(values: number[], radius: number, closed: boolean): number[] {
  let cur = values;
  const n = cur.length;
  if (radius < 1 || n === 0) return cur.slice();
  for (let pass = 0; pass < 2; pass++) {
    const next = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      let count = 0;
      for (let k = -radius; k <= radius; k++) {
        let j = i + k;
        if (closed) j = ((j % n) + n) % n;
        else if (j < 0 || j >= n) continue;
        sum += cur[j]!;
        count++;
      }
      next[i] = sum / count;
    }
    cur = next;
  }
  return cur;
}

/** A distance range split at the seam of a closed line (open lines: clamped). */
function spans(line: Centerline, a: number, b: number): [number, number][] {
  const L = line.length;
  if (!line.closed) {
    const s = Math.max(0, a);
    const e = Math.min(L, b);
    return e > s ? [[s, e]] : [];
  }
  if (b - a >= L) return [[0, L]];
  const s = ((a % L) + L) % L;
  const e = s + (b - a);
  return e <= L ? [[s, e]] : [[s, L], [0, e - L]];
}

/** Vertex-colored geometry built from oriented quads, boxes and transformed prototypes. */
class Painter {
  readonly mesh = new MeshBuilder();
  readonly colors: number[] = [];

  #paint(from: number, color: Rgba4): void {
    for (let i = from; i < this.mesh.vertexCount; i++) this.colors.push(color[0], color[1], color[2], color[3]);
  }

  /** A flat quad facing `outward` (corners in ring order, either winding). */
  quad(a: V3, b: V3, c: V3, d: V3, outward: V3, color: Rgba4): void {
    const from = this.mesh.vertexCount;
    if (dot(cross(sub(b, a), sub(d, a)), outward) >= 0) this.mesh.quad(a, b, c, d);
    else this.mesh.quad(a, d, c, b);
    this.#paint(from, color);
  }

  /** A box centered at `c` with half extents along three orthonormal axes. */
  box(c: V3, ax: V3, ay: V3, az: V3, hx: number, hy: number, hz: number, color: Rgba4): void {
    const corner = (sx: number, sy: number, sz: number): V3 => [
      c[0] + ax[0] * hx * sx + ay[0] * hy * sy + az[0] * hz * sz,
      c[1] + ax[1] * hx * sx + ay[1] * hy * sy + az[1] * hz * sz,
      c[2] + ax[2] * hx * sx + ay[2] * hy * sy + az[2] * hz * sz,
    ];
    const neg = (v: V3): V3 => [-v[0], -v[1], -v[2]];
    this.quad(corner(1, -1, -1), corner(1, 1, -1), corner(1, 1, 1), corner(1, -1, 1), ax, color);
    this.quad(corner(-1, -1, -1), corner(-1, -1, 1), corner(-1, 1, 1), corner(-1, 1, -1), neg(ax), color);
    this.quad(corner(-1, 1, -1), corner(-1, 1, 1), corner(1, 1, 1), corner(1, 1, -1), ay, color);
    this.quad(corner(-1, -1, -1), corner(1, -1, -1), corner(1, -1, 1), corner(-1, -1, 1), neg(ay), color);
    this.quad(corner(-1, -1, 1), corner(1, -1, 1), corner(1, 1, 1), corner(-1, 1, 1), az, color);
    this.quad(corner(-1, -1, -1), corner(-1, 1, -1), corner(1, 1, -1), corner(1, -1, -1), neg(az), color);
  }

  /** A prototype surface rotated `yaw` radians about +y (local +z → (sin, 0, cos)), scaled, moved to `origin`. */
  place(s: Surface, origin: V3, yaw: number, scale: number, color: Rgba4): void {
    const from = this.mesh.vertexCount;
    const c = Math.cos(yaw);
    const sn = Math.sin(yaw);
    for (let i = 0; i < s.positions.length / 3; i++) {
      const x = s.positions[i * 3]!;
      const y = s.positions[i * 3 + 1]!;
      const z = s.positions[i * 3 + 2]!;
      const nx = s.normals[i * 3]!;
      const nz = s.normals[i * 3 + 2]!;
      this.mesh.vertex(
        [origin[0] + (x * c + z * sn) * scale, origin[1] + y * scale, origin[2] + (-x * sn + z * c) * scale],
        [nx * c + nz * sn, s.normals[i * 3 + 1]!, -nx * sn + nz * c], s.uvs[i * 2]!, s.uvs[i * 2 + 1]!,
      );
    }
    for (const index of s.indices) this.mesh.indices.push(from + index);
    this.#paint(from, color);
  }

  build(): Surface { return this.mesh.build(this.colors); }
}

/** Merge surfaces (all with or all without vertex colors) into one. */
function merge(surfaces: readonly Surface[]): Surface {
  const out = new MeshBuilder();
  const colors: number[] = [];
  let colored = false;
  for (const s of surfaces) {
    if (s.indices.length === 0) continue;
    const base = out.vertexCount;
    // Element by element: spreading a big typed array into push() overflows the stack.
    for (const v of s.positions) out.positions.push(v);
    for (const v of s.normals) out.normals.push(v);
    for (const v of s.uvs) out.uvs.push(v);
    for (const i of s.indices) out.indices.push(base + i);
    if (s.colors !== null) {
      colored = true;
      for (const v of s.colors) colors.push(v);
    } else {
      for (let i = 0; i < s.positions.length / 3; i++) colors.push(1, 1, 1, 1);
    }
  }
  return out.build(colored ? colors : null);
}

const profile = (...outlines: Outline[]): Profile => ({ outlines, width: 1, height: 1 });
/** The same outline on the left: x negated, order reversed (so it still faces out). */
const mirrored = (o: Outline): Outline => ({ ...o, points: o.points.map(([x, y]) => [-x, y] as const).reverse() });
const sided = (o: Outline, side: 1 | -1): Outline => (side === 1 ? o : mirrored(o));

// ── Corners and the racing line ─────────────────────────────────────────────────

/** Signed curvature (1/m, positive turning right) per sample, smoothed over ~10 m. */
export function curvature(line: Centerline): number[] {
  const s = line.samples;
  const n = s.length;
  const L = line.length;
  const heading = s.map((p) => Math.atan2(p.tangent[0], p.tangent[2]));
  const raw = s.map((_, i) => {
    const a = line.closed ? (i - 1 + n) % n : Math.max(0, i - 1);
    const b = line.closed ? (i + 1) % n : Math.min(n - 1, i + 1);
    let ds = s[b]!.distance - s[a]!.distance;
    if (line.closed && ds <= 0) ds += L;
    if (ds <= 0) return 0;
    let dh = heading[b]! - heading[a]!;
    while (dh > Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    return dh / ds;
  });
  const step = n > 1 ? L / (line.closed ? n : n - 1) : 1;
  return smooth(raw, Math.max(1, Math.round(5 / step)), line.closed);
}

export function findCorners(line: Centerline, kappa: readonly number[], radius: number, extend: number): TrackCorner[] {
  const s = line.samples;
  const n = s.length;
  const L = line.length;
  const threshold = 1 / radius;
  const sign = (i: number): number => (Math.abs(kappa[i]!) > threshold ? Math.sign(kappa[i]!) : 0);
  // Runs of one sign; on a closed line start the scan just after a straight so no run is cut by the seam.
  let first = 0;
  if (line.closed) {
    const straight = kappa.findIndex((_, i) => sign(i) === 0);
    if (straight < 0) {
      // Never straight: one corner the whole way round.
      const side = Math.sign(kappa.reduce((a, b) => a + b, 0)) >= 0 ? 1 : -1;
      return [{ start: 0, end: L, apex: 0, side, radius: 1 / kappa.reduce((m, k) => Math.max(m, Math.abs(k)), 1e-9) }];
    }
    first = straight;
  }
  const corners: TrackCorner[] = [];
  let i = 0;
  const count = n;
  while (i < count) {
    const idx = (first + i) % n;
    const sg = sign(idx);
    if (sg === 0) {
      i++;
      continue;
    }
    let j = i;
    let apex = idx;
    while (j < count && sign((first + j) % n) === sg) {
      const k = (first + j) % n;
      if (Math.abs(kappa[k]!) > Math.abs(kappa[apex]!)) apex = k;
      j++;
    }
    const startIdx = idx;
    const endIdx = (first + j - 1) % n;
    let start = s[startIdx]!.distance - extend;
    let end = s[endIdx]!.distance + extend;
    if (end < start) end += L;
    if (!line.closed) {
      start = Math.max(0, start);
      end = Math.min(L, end);
    }
    corners.push({ start, end, apex: s[apex]!.distance, side: sg > 0 ? 1 : -1, radius: 1 / Math.abs(kappa[apex]!) });
    i = j;
  }
  corners.sort((a, b) => a.start - b.start);
  return corners;
}

/** Lateral offsets of a racing line: inside through a corner, outside before and after it, within ±limit. */
export function racingOffsets(line: Centerline, kappa: readonly number[], limit: number): number[] {
  const n = kappa.length;
  if (n === 0) return [];
  const step = line.length / (line.closed ? n : Math.max(1, n - 1));
  // Full inside for corners of radius 45 m or tighter.
  const c = kappa.map((k) => Math.max(-1, Math.min(1, k * 45)));
  const reach = Math.max(1, Math.round(35 / step));
  const at = (i: number): number => (line.closed ? c[((i % n) + n) % n]! : c[Math.max(0, Math.min(n - 1, i))]!);
  // The strongest turn within reach (signed): ahead of / after a corner the line swings
  // to its outside (2·0 − s), in it to its inside (2·c − c = c).
  const raw = c.map((v, i) => {
    let strongest = 0;
    for (let k = -reach; k <= reach; k++) {
      const w = at(i + k);
      if (Math.abs(w) > Math.abs(strongest)) strongest = w;
    }
    return 2 * v - strongest;
  });
  return smooth(raw, Math.max(1, Math.round(12 / step)), line.closed).map((v) => Math.max(-1, Math.min(1, v)) * limit);
}

// ── Build ───────────────────────────────────────────────────────────────────────

/** Height of the tarmac's crowned top at `u` meters across (0 off the road). */
function crownAt(spec: TrackSpec, u: number): number {
  const t = Math.abs(u) / (spec.width / 2);
  return t >= 1 ? 0 : spec.crown * (1 - t * t);
}

/** Raise samples so no part of the drivable section is inside the ground, ramped to a gentle grade. */
function clearance(line: Centerline, spec: TrackSpec, ground: Ground | null): number[] {
  const s = line.samples;
  const n = s.length;
  const lift = new Array<number>(n).fill(0);
  if (ground === null || n === 0) return lift;
  const reach = spec.width / 2 + (spec.kerbs === 'none' ? 0 : spec.kerbWidth + 0.1);
  const probes = 6;
  for (let i = 0; i < n; i++) {
    const f = s[i]!;
    let need = 0;
    for (let k = -probes; k <= probes; k++) {
      const u = (k / probes) * reach;
      const y = crownAt(spec, u);
      const x = f.point[0] + f.right[0] * u + f.up[0] * y;
      const py = f.point[1] + f.right[1] * u + f.up[1] * y;
      const z = f.point[2] + f.right[2] * u + f.up[2] * y;
      need = Math.max(need, ground(x, z) + 0.02 - py);
    }
    lift[i] = need;
  }
  // Spread each raise into a ramp (1 in 16 at most): dilation only ever adds clearance.
  const step = line.length / (line.closed ? n : Math.max(1, n - 1));
  const maxDelta = step / 16;
  for (let sweep = 0; sweep < (line.closed ? 2 : 1); sweep++) {
    for (let i = 1; i <= n; i++) {
      if (!line.closed && i === n) break;
      const j = i % n;
      lift[j] = Math.max(lift[j]!, lift[i - 1]! - maxDelta);
    }
    for (let i = n - 2; i >= -1; i--) {
      if (!line.closed && i < 0) break;
      const j = (i + n) % n;
      lift[j] = Math.max(lift[j]!, lift[(i + 1) % n]! - maxDelta);
    }
  }
  return lift;
}

/** Build the whole track (see the file comment). */
export function buildTrack(line: Centerline, spec: TrackSpec, ground: Ground | null): TrackGeometry {
  const parts: TrackPart[] = [];
  const add = (name: string, surface: Surface, material: TrackMaterial, collide: boolean, shadows = true): void => {
    if (surface.indices.length > 0) parts.push({ name, surface, material, collide: collide && spec.collide, shadows });
  };
  const flatMaterial = (color: Rgba4, roughness: number, metallic = 0, unlit = false): TrackMaterial => ({ color, texture: null, tile: 1, roughness, metallic, unlit });
  const L = line.length;
  const hw = spec.width / 2;
  const kappa = curvature(line);
  const corners = findCorners(line, kappa, spec.kerbRadius, spec.kerbExtend);
  const lift = clearance(line, spec, ground);
  const lifted: Centerline = {
    closed: line.closed,
    length: L,
    samples: line.samples.map((s, i) => ({ ...s, point: [s.point[0], s.point[1] + lift[i]!, s.point[2]] })),
  };
  const sweep = (p: Profile, start: number, end: number, opts: { stripe?: number; colors?: readonly Rgba4[]; caps?: boolean; uv?: number } = {}): Surface =>
    sweepLayer(lifted, {
      profile: p, width: 1, height: 1, offset: [0, 0], uvLength: opts.uv ?? 1, uvWidth: opts.uv ?? 1, start, end, caps: opts.caps ?? false,
      stripe: opts.stripe, colors: opts.colors ?? [[1, 1, 1, 1]],
    });
  const sweepSpans = (p: Profile, a: number, b: number, opts: Parameters<typeof sweep>[3] = {}): Surface[] =>
    spans(lifted, a, b).map(([s, e]) => sweep(p, s, e, opts));

  // Tarmac: a crowned top with short skirts down each edge (no daylight under the ribbon).
  const skirt = 0.4;
  const crownPts: (readonly [number, number])[] = [[hw, -skirt], [hw, 0]];
  for (let k = 1; k < 8; k++) {
    const u = hw - (2 * hw * k) / 8;
    crownPts.push([u, crownAt(spec, u)]);
  }
  crownPts.push([-hw, 0], [-hw, -skirt]);
  add('track:tarmac', sweep(profile({ points: crownPts, closed: false, smooth: false }), 0, L), spec.surface, true);

  if (spec.edgeLines !== null) {
    const { width, inset, color } = spec.edgeLines;
    const a = hw - inset;
    const b = hw - inset - width;
    const right: Outline = { points: [[a, crownAt(spec, a) + 0.01], [b, crownAt(spec, b) + 0.01]], closed: false, smooth: false };
    add('track:edge_lines', sweep(profile(right, mirrored(right)), 0, L), flatMaterial(color, 0.55), false, false);
  }

  // Kerbs: a low block with a chamfered inboard lip, striped by distance.
  const kerbRanges: { start: number; end: number; side: 1 | -1 }[] = [];
  if (spec.kerbs !== 'none') {
    const kw = spec.kerbWidth;
    const kh = spec.kerbHeight;
    const right: Outline = { points: [[hw, -0.05], [hw + kw + 0.1, -0.05], [hw + kw, kh], [hw + 0.15, kh]], closed: true, smooth: false };
    const ranges: { start: number; end: number; side: 1 | -1 }[] = [];
    if (spec.kerbs === 'full') ranges.push({ start: 0, end: L, side: 1 }, { start: 0, end: L, side: -1 });
    else {
      for (const c of corners) {
        ranges.push({ start: c.start, end: c.end, side: c.side });
        if (spec.kerbs === 'corners') ranges.push({ start: c.start, end: c.end, side: c.side === 1 ? -1 : 1 });
      }
    }
    // Wrapped into [0, length] and merged per side, so overlapping corners never double a kerb.
    for (const side of [1, -1] as const) {
      const pieces = ranges.filter((r) => r.side === side).flatMap((r) => spans(lifted, r.start, r.end)).sort((a, b) => a[0] - b[0]);
      for (const [s, e] of pieces) {
        const last = kerbRanges[kerbRanges.length - 1];
        if (last !== undefined && last.side === side && s <= last.end) last.end = Math.max(last.end, e);
        else kerbRanges.push({ start: s, end: e, side });
      }
    }
    const surfaces = kerbRanges.map((r) => sweep(profile(sided(right, r.side)), r.start, r.end, { stripe: spec.kerbStripe, colors: spec.kerbColors, caps: true }));
    add('track:kerbs', merge(surfaces), flatMaterial([1, 1, 1, 1], 0.5), true);
  }

  // Run-off: from the road edge (under the kerbs) out to the ground, pinned to it. It collides:
  // where the road is banked or lifted its edge rides above the graded ground, and a car that
  // runs wide must land on the verge it sees, not drop through it to the terrain underneath.
  const shoulder = hw + (spec.kerbs === 'none' ? 0 : spec.kerbWidth) + (spec.runoff === 'none' ? 0 : spec.runoffWidth);
  if (spec.runoff !== 'none') {
    const color = spec.runoffColor ?? RUNOFF_COLORS[spec.runoff];
    add('track:runoff', verge(lifted, spec, shoulder - hw, color, ground), flatMaterial([1, 1, 1, 1], spec.runoff === 'tarmac' ? 0.75 : 0.95), true, false);
  }

  const barrierX = barrierOffset(spec);
  const groundAt = (p: V3): number => (ground === null ? p[1] : ground(p[0], p[2]));
  const solid = new Painter();
  const props = new Painter();

  // Barrier.
  if (spec.barrier !== 'none') {
    const h = spec.barrierHeight;
    if (spec.barrier === 'armco') {
      const x = barrierX;
      // A W-beam: flat back, two ridges facing the track.
      const right: Outline = {
        points: [[x, h - 0.34], [x + 0.05, h - 0.34], [x + 0.05, h], [x, h], [x - 0.08, h - 0.085], [x - 0.02, h - 0.17], [x - 0.08, h - 0.255]],
        closed: true, smooth: false,
      };
      const color = spec.barrierColors[0] ?? ARMCO;
      add('track:barrier', sweep(profile(right, mirrored(right)), 0, L), flatMaterial(color, 0.35, 0.6), spec.barrierCollide);
      for (let d = 0; d < L - (line.closed ? spec.postEvery * 0.5 : -1e-6); d += spec.postEvery) {
        const f = sampleAt(lifted, d);
        const r = flat(f.right);
        const t = flat(f.tangent);
        for (const side of [1, -1] as const) {
          const base = along(f.point, f.right, side * (x + 0.13));
          const bottom = Math.min(base[1], groundAt(base)) - 0.15;
          const top = base[1] + h - 0.02;
          solid.box([base[0], (bottom + top) / 2, base[2]], r, UP, t, 0.06, (top - bottom) / 2, 0.06, POST);
        }
      }
    } else {
      const x = barrierX;
      const right: Outline = {
        points: [[x - 0.3, -0.4], [x + 0.3, -0.4], [x + 0.3, 0.08], [x + 0.1, 0.3], [x + 0.08, h], [x - 0.08, h], [x - 0.1, 0.3], [x - 0.3, 0.08]],
        closed: true, smooth: false,
      };
      const colors = spec.barrierColors.length > 0 ? spec.barrierColors : [CONCRETE];
      add('track:barrier', sweep(profile(right, mirrored(right)), 0, L, colors.length > 1 ? { stripe: 3, colors } : { colors }), flatMaterial([1, 1, 1, 1], 0.85), spec.barrierCollide);
    }
  }

  // Tyre walls: stacks on the outside of each corner, around its apex.
  if (spec.tyreWalls && corners.length > 0 && spec.barrier !== 'none') {
    const tyre = latheMesh({ profile: [[0.17, 0], [0.32, 0], [0.32, 0.24], [0.17, 0.24]], segments: 8, sweep: 360, caps: false, hard: false, tile: 1 });
    const colors = spec.tyreColors.length > 0 ? spec.tyreColors : [BLACK];
    let stack = 0;
    for (const c of corners) {
      if (c.radius > spec.kerbRadius * 0.6) continue;
      const side = c.side === 1 ? -1 : 1;
      const half = Math.min(25, (c.end - c.start) / 2);
      for (let d = c.apex - half; d <= c.apex + half; d += 0.68, stack++) {
        const f = sampleAt(lifted, d);
        const base = along(f.point, f.right, side * (barrierX - 0.45));
        const y = Math.min(base[1], groundAt(base)) - 0.04;
        for (let level = 0; level < 3; level++) {
          solid.place(tyre, [base[0], y + level * 0.24, base[2]], 0, 1, colors[(stack + level) % colors.length]!);
        }
      }
    }
  }

  // Stands and spectators.
  let spectators = 0;
  if (spec.crowd.length > 0 && spec.crowdMax > 0) {
    const sides: (1 | -1)[] = spec.crowdSide === 'both' ? [1, -1] : spec.crowdSide === 'right' ? [1] : [-1];
    const rows = spec.crowdRows;
    const gap = spec.crowdRowGap;
    const rise = spec.crowdRowRise;
    const x0 = barrierX + spec.crowdSetback;
    const standSurfaces: Surface[] = [];
    const body = latheMesh({ profile: [[0.15, 0], [0.19, 0.32], [0.21, 0.66], [0.15, 0.84], [0.06, 0.9]], segments: 6, sweep: 360, caps: true, hard: false, tile: 1 });
    const head = latheMesh({ profile: [[0, 0.91], [0.09, 0.95], [0.115, 1.03], [0.09, 1.11], [0, 1.14]], segments: 6, sweep: 360, caps: false, hard: false, tile: 1 });
    const crowd = new Painter();
    const palette = spec.crowdColors.length > 0 ? spec.crowdColors : CROWD_PALETTE;
    spec.crowd.forEach(([fa, fb], section) => {
      let a = fa * L;
      let b = fb * L;
      if (b < a) {
        if (!line.closed) return;
        b += L;
      }
      if (spec.stands && rise > 0) {
        for (const side of sides) {
          const outlines: Outline[] = [];
          for (let k = 0; k < rows; k++) {
            const xa = x0 + k * gap;
            const xb = x0 + rows * gap;
            const top = (k + 1) * rise;
            outlines.push(sided({ points: [[xa, -3], [xb, -3], [xb, top], [xa, top]], closed: true, smooth: false }, side));
          }
          standSurfaces.push(...sweepSpans(profile(...outlines), a, b, { caps: true }));
        }
      }
      // Spectators: a jittered row every 1 / density meters, front row first.
      const step = 1 / spec.crowdDensity;
      for (const side of sides) {
        for (let k = 0; k < rows; k++) {
          for (let d = a + step * 0.5; d < b; d += step) {
            if (spectators >= spec.crowdMax) return;
            const r = (salt: number): number => hash01(spec.seed, section, side, k, Math.round(d * 16), salt);
            const f = sampleAt(lifted, d + (r(1) - 0.5) * step * 0.6);
            const x = side * (x0 + (k + 0.5) * gap + (r(2) - 0.5) * gap * 0.3);
            let base = along(f.point, f.right, x);
            if (spec.stands && rise > 0) base = along(base, f.up, (k + 1) * rise);
            else base = [base[0], groundAt(base) + (k * rise), base[2]];
            const toward = flat(f.right);
            const yaw = Math.atan2(-toward[0] * side, -toward[2] * side) + (r(3) - 0.5) * 0.6;
            const scale = 0.9 + r(4) * 0.2;
            const shirt = palette[Math.floor(r(5) * palette.length) % palette.length]!;
            crowd.place(body, base, yaw, scale, shirt);
            crowd.place(head, base, yaw, scale, SKIN[Math.floor(r(6) * SKIN.length) % SKIN.length]!);
            if (r(7) < 0.28) {
              // Arms up: two thin boxes from the shoulders.
              const fwd: V3 = [Math.sin(yaw), 0, Math.cos(yaw)];
              const side3: V3 = [Math.cos(yaw), 0, -Math.sin(yaw)];
              for (const s of [1, -1]) {
                const c = along(along(base, side3, s * 0.24 * scale), UP, 1.02 * scale);
                const tilt = normalize([side3[0] * s * 0.3, 1, side3[2] * s * 0.3]);
                const across = normalize(cross(tilt, fwd));
                crowd.box(c, across, tilt, fwd, 0.04 * scale, 0.26 * scale, 0.04 * scale, shirt);
              }
            }
            spectators++;
          }
        }
      }
    });
    if (standSurfaces.length > 0) add('track:stands', merge(standSurfaces), flatMaterial(spec.standColor, 0.9), true);
    add('track:crowd', crowd.build(), flatMaterial([1, 1, 1, 1], 0.88), false);
  }

  // Start gantry and the chequered line under it.
  const start = line.closed ? ((spec.start % L) + L) % L : Math.min(spec.start, L);
  if (spec.finishLine) {
    const cells = Math.max(2, Math.round(spec.width / 1.2));
    const cell = spec.width / cells;
    const rowsAlong = [-1, 0, 1];
    const lineP = new Painter();
    for (const row of rowsAlong) {
      const d0 = start + (row - 0.5) * 0.6;
      const d1 = d0 + 0.6;
      const f0 = sampleAt(lifted, d0);
      const f1 = sampleAt(lifted, d1);
      for (let c = 0; c < cells; c++) {
        const ua = -hw + c * cell;
        const ub = ua + cell;
        const at = (f: Sample, u: number): V3 => along(along(f.point, f.right, u), f.up, crownAt(spec, u) + 0.014);
        lineP.quad(at(f0, ua), at(f0, ub), at(f1, ub), at(f1, ua), f0.up, (c + row + 3) % 2 === 0 ? WHITE : BLACK);
      }
    }
    add('track:finish_line', lineP.build(), flatMaterial([1, 1, 1, 1], 0.6), false, false);
  }
  if (spec.gantry) {
    const f = sampleAt(lifted, start);
    const r = flat(f.right);
    const t = flat(f.tangent);
    const span = barrierX + 1.1;
    const H = 7.2;
    const deck = f.point[1];
    for (const side of [1, -1]) {
      const p = along(f.point, r, side * span);
      const bottom = Math.min(p[1], groundAt(p)) - 0.3;
      solid.box([p[0], (bottom + deck + H) / 2, p[2]], r, UP, t, 0.4, (deck + H - bottom) / 2, 0.4, STEEL);
      solid.box([p[0], bottom + 0.5, p[2]], r, UP, t, 0.75, 0.8, 0.75, CONCRETE);
    }
    const beam: V3 = [f.point[0], deck + H - 0.7, f.point[2]];
    solid.box(beam, r, UP, t, span + 0.4, 0.7, 0.5, STEEL);
    for (const face of [1, -1]) {
      props.box(along(beam, t, face * 0.55), r, UP, t, span - 0.6, 0.55, 0.05, spec.gantryColor);
      props.box(along(along(beam, t, face * 0.61), UP, -0.05), r, UP, t, span - 1.6, 0.09, 0.02, WHITE);
    }
    // Five start lights hanging under the beam on the approach side.
    const lamps = new Painter();
    for (let i = 0; i < 5; i++) {
      const c = along(along(along(beam, r, (i - 2) * 0.8), UP, -1.05), t, -0.35);
      props.box(along(c, t, 0.12), r, UP, t, 0.34, 0.34, 0.1, BLACK);
      lamps.box(c, r, UP, t, 0.22, 0.22, 0.05, LAMP);
    }
    add('track:lamps', lamps.build(), flatMaterial([1, 1, 1, 1], 0.4, 0, true), false, false);
  }

  // Trackside boards, alternating sides, clear of the start.
  if (spec.signsEvery > 0) {
    const colors = spec.signColors.length > 0 ? spec.signColors : SIGN_PALETTE;
    let k = 0;
    for (let d = spec.signsEvery * 0.5; d < L; d += spec.signsEvery, k++) {
      const fromStart = line.closed ? Math.min(Math.abs(d - start), L - Math.abs(d - start)) : Math.abs(d - start);
      if (spec.gantry && fromStart < 30) continue;
      const side = k % 2 === 0 ? 1 : -1;
      const f = sampleAt(lifted, d);
      const r = flat(f.right);
      const t = flat(f.tangent);
      const p = along(f.point, r, side * (barrierX + 1.4));
      const y = groundAt(p);
      for (const leg of [1, -1]) props.box([p[0] + t[0] * leg * 1.5, y + 0.55, p[2] + t[2] * leg * 1.5], r, UP, t, 0.05, 0.6, 0.05, POST);
      const panel: V3 = [p[0], y + 1.6, p[2]];
      props.box(panel, r, UP, t, 0.05, 0.55, 1.9, colors[k % colors.length]!);
      props.box(along(panel, r, -side * 0.06), r, UP, t, 0.02, 0.14, 1.5, WHITE);
    }
  }

  add('track:props_solid', solid.build(), flatMaterial([1, 1, 1, 1], 0.6, 0.2), spec.barrierCollide);
  add('track:props', props.build(), flatMaterial([1, 1, 1, 1], 0.55), false);

  const racing = racingOffsets(line, kappa, Math.max(0, hw - 1.5));
  return { parts, corners, kerbs: kerbRanges, racing, lift, spectators };
}

/** The run-off strip, both sides: inner edge under the road edge, middle and outer pinned to the ground. */
function verge(line: Centerline, spec: TrackSpec, width: number, color: Rgba4, ground: Ground | null): Surface {
  const s = line.samples;
  const rings: Sample[] = line.closed ? [...s, { ...s[0]!, distance: line.length }] : [...s];
  const mesh = new MeshBuilder();
  const colors: number[] = [];
  const hw = spec.width / 2;
  const jitter = spec.runoff === 'tarmac' ? 0.03 : 0.08;
  for (const side of [1, -1] as const) {
    const base = mesh.vertexCount;
    rings.forEach((f, i) => {
      const edge = along(along(f.point, f.right, side * hw), f.up, -0.03);
      const h = flat(f.right);
      for (let k = 0; k < 3; k++) {
        const w = (width * k) / 2;
        const p = along(edge, h, side * w);
        let y = p[1];
        if (k > 0) {
          const g = ground === null ? edge[1] - 0.04 * k : ground(p[0], p[2]) + 0.04;
          y = Math.max(edge[1] - 3, Math.min(edge[1] + 3, k === 1 ? Math.max(g, edge[1] - 0.02 - w * 0.03) : g));
        }
        mesh.vertex([p[0], y, p[2]], [0, 1, 0], (side * w) / 2, f.distance / 2);
        const v = 1 + (hash01(spec.seed, i, k, side) - 0.5) * 2 * jitter;
        colors.push(Math.min(1, color[0] * v), Math.min(1, color[1] * v), Math.min(1, color[2] * v), color[3]);
      }
    });
    for (let i = 0; i + 1 < rings.length; i++) {
      for (let k = 0; k < 2; k++) {
        const a = base + i * 3 + k;
        const b = a + 1;
        const c = a + 3;
        const d = c + 1;
        // Face up whichever side this is.
        const pa = [mesh.positions[a * 3]!, mesh.positions[a * 3 + 1]!, mesh.positions[a * 3 + 2]!] as const;
        const pb = [mesh.positions[b * 3]!, mesh.positions[b * 3 + 1]!, mesh.positions[b * 3 + 2]!] as const;
        const pc = [mesh.positions[c * 3]!, mesh.positions[c * 3 + 1]!, mesh.positions[c * 3 + 2]!] as const;
        if (cross(sub(pb, pa), sub(pc, pa))[1] >= 0) mesh.indices.push(a, b, d, a, d, c);
        else mesh.indices.push(a, d, b, a, c, d);
      }
    }
  }
  // Smooth normals from the faces.
  const normals = new Float64Array(mesh.positions.length);
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const [i0, i1, i2] = [mesh.indices[t]!, mesh.indices[t + 1]!, mesh.indices[t + 2]!];
    const p = (i: number): V3 => [mesh.positions[i * 3]!, mesh.positions[i * 3 + 1]!, mesh.positions[i * 3 + 2]!];
    const n = cross(sub(p(i1), p(i0)), sub(p(i2), p(i0)));
    for (const i of [i0, i1, i2]) for (let k = 0; k < 3; k++) normals[i * 3 + k] = normals[i * 3 + k]! + n[k]!;
  }
  for (let i = 0; i < mesh.vertexCount; i++) {
    const n = normalize([normals[i * 3]!, normals[i * 3 + 1]!, normals[i * 3 + 2]!]);
    const ok = n[1] > 0 ? n : [0, 1, 0];
    mesh.normals[i * 3] = ok[0]!;
    mesh.normals[i * 3 + 1] = ok[1]!;
    mesh.normals[i * 3 + 2] = ok[2]!;
  }
  return mesh.build(colors);
}
