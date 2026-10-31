/**
 * The city plan: a pure, deterministic function of the spec (and the resolved street
 * level). Plain data only, so a worker can rebuild it from the spec and get the same plan.
 *
 *   spec → warped street grid (avenues every n-th line) → merged blocks, parks, plazas and
 *   landmark sites → per-block curb / sidewalk / lot quads → perimeter lots → building
 *   massing (tiers, roofs, facades, colours, enterable ground floors) → street furniture.
 *
 * Frames. The grid is laid out in its own frame (rotated by `roads.angle` about the area's
 * center), warped by smooth noise (`curviness`), then mapped to world x, z. Every quad
 * below lists its corners so that its inside is on the LEFT going corner to corner (seen
 * from above, +y up, +z forward, yaw = atan2(x, z)).
 */

import { footprintAnchor, footprintHits } from '../../../core/index.js';
import type { Footprint } from '../../../core/index.js';
import type { CitySpec, DistrictKind, LandmarkKind, PropRole } from './spec.js';
import { baseDistrict } from './spec.js';
import { hash, noise2, Rng } from './noise.js';

export type XZ = readonly [number, number];
export type Quad = readonly [XZ, XZ, XZ, XZ];

export interface RoadNode {
  readonly id: number;
  readonly x: number;
  readonly z: number;
  /** Street level at the node (bridges raise their own decks). */
  readonly y: number;
  readonly edges: number[];
  /** Signalized (an avenue meets three or more streets); else an all-way stop. */
  signal: boolean;
}

export interface BridgeProfile {
  /** Deck height above street level (m). */
  readonly height: number;
  /** Meters of ramp at each end. */
  readonly ramp: number;
  readonly name: string;
}

export interface RoadEdge {
  readonly id: number;
  readonly a: number;
  readonly b: number;
  readonly major: boolean;
  /** Lanes each way. */
  readonly lanes: number;
  /** Centerline to curb (m), parking strips included. */
  readonly halfWidth: number;
  /** A parking strip along each curb (2.3 m). */
  readonly parking: boolean;
  readonly length: number;
  readonly bridge: BridgeProfile | null;
  /** The blocks on either side (−1: none). */
  readonly cells: number[];
}

export type CellKind = 'block' | 'park' | 'plaza' | 'landmark';

export interface Cell {
  readonly id: number;
  readonly i: number;
  readonly j: number;
  /** The grid quad between four street centerline nodes. */
  readonly corners: Quad;
  /** Edge id along each side (corner k → k+1), −1 where the street was left out. */
  readonly sides: readonly [number, number, number, number];
  kind: CellKind;
  district: DistrictKind;
  districtName: string;
  /** 0..1: how downtown this block is. */
  readonly proximity: number;
  /** The raised platform's edge (curb line). */
  readonly curb: Quad;
  /** Inside the sidewalks: where lots and buildings go. */
  readonly lot: Quad;
  /** The walking line along each sidewalk (mid-sidewalk). */
  readonly walk: Quad;
  /** The landmark this block hosts (index into `landmarks`), or −1. */
  landmark: number;
}

export type FacadeKind = 'curtain' | 'punched' | 'storefront' | 'house' | 'industrial';
export type RoofKind = 'flat' | 'gable' | 'sawtooth' | 'spire';
export type Archetype = 'tower' | 'podium' | 'block' | 'house' | 'warehouse' | 'spire';

export interface Tier {
  /** 0: the full footprint; 0.3: shrunk 30% toward its center. */
  readonly inset: number;
  readonly y0: number;
  readonly y1: number;
}

export type Rgb = readonly [number, number, number];

export interface Building {
  readonly id: number;
  readonly cell: number;
  readonly district: DistrictKind;
  readonly archetype: Archetype;
  readonly footprint: Quad;
  /** Footprint side facing the street. */
  readonly front: number;
  /** Street level under it. */
  readonly base: number;
  readonly height: number;
  readonly floors: number;
  readonly floorHeight: number;
  /** Ground floor height (shops are taller). */
  readonly groundFloor: number;
  readonly tiers: readonly Tier[];
  readonly roof: RoofKind;
  readonly facade: FacadeKind;
  readonly wall: Rgb;
  readonly glass: Rgb;
  readonly trim: Rgb;
  readonly roofColor: Rgb;
  /** Facade bay width (m). */
  readonly bay: number;
  /** Window width and height as fractions of a bay and a floor. */
  readonly window: readonly [number, number];
  readonly enterable: boolean;
  /** Door center on the front face (world x, z), and the yaw facing out. */
  readonly door: { readonly x: number; readonly z: number; readonly yaw: number; readonly width: number } | null;
  readonly seed: number;
  /** A landmark's name, else ''. */
  readonly name: string;
}

export type PieceRole = PropRole | 'parked' | 'interior';

export interface PropPlacement {
  readonly id: number;
  readonly role: PieceRole;
  readonly prefab: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  /** Building it dresses (interiors), else −1. */
  readonly building: number;
}

export interface LandmarkPlan {
  readonly kind: LandmarkKind;
  readonly name: string;
  readonly at: XZ;
  readonly size: XZ;
  readonly height: number;
  /** Blocks it occupies. */
  readonly cells: number[];
  /** Bridges: their edge id; else −1. */
  edge: number;
}

export interface SkylineMass {
  readonly x: number;
  readonly z: number;
  readonly w: number;
  readonly d: number;
  readonly h: number;
  readonly yaw: number;
  readonly color: Rgb;
}

export interface CityLayout {
  readonly ground: number;
  readonly curb: number;
  readonly sidewalk: number;
  readonly laneWidth: number;
  readonly nodes: readonly RoadNode[];
  readonly edges: readonly RoadEdge[];
  readonly cells: readonly Cell[];
  readonly buildings: readonly Building[];
  readonly props: readonly PropPlacement[];
  readonly landmarks: readonly LandmarkPlan[];
  readonly skyline: readonly SkylineMass[];
  /** World bounds of everything built (x0, z0, x1, z1). */
  readonly bounds: readonly [number, number, number, number];
}

// ── 2D helpers ──────────────────────────────────────────────────────────────────

const sub = (a: XZ, b: XZ): [number, number] => [a[0] - b[0], a[1] - b[1]];
const len = (a: XZ): number => Math.hypot(a[0], a[1]);
const lerp2 = (a: XZ, b: XZ, t: number): [number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
export const dist2 = (a: XZ, b: XZ): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Bilinear point of a quad (u along corner 0 → 1, v along corner 0 → 3). */
export function bilinear(q: Quad, u: number, v: number): [number, number] {
  const [c0, c1, c2, c3] = q;
  return [
    (1 - u) * (1 - v) * c0[0] + u * (1 - v) * c1[0] + u * v * c2[0] + (1 - u) * v * c3[0],
    (1 - u) * (1 - v) * c0[1] + u * (1 - v) * c1[1] + u * v * c2[1] + (1 - u) * v * c3[1],
  ];
}

/** The quad's sides pushed inward (to their left) by `d[k]` meters each, re-intersected. */
export function insetQuad(q: Quad, d: readonly number[]): Quad {
  const lines = q.map((p, k) => {
    const n = q[(k + 1) % 4]!;
    const t = sub(n, p);
    const l = len(t) || 1;
    const left: [number, number] = [-t[1] / l, t[0] / l];
    return { p: [p[0] + left[0] * d[k]!, p[1] + left[1] * d[k]!] as XZ, t: [t[0] / l, t[1] / l] as XZ };
  });
  const out: XZ[] = [];
  for (let k = 0; k < 4; k++) {
    const a = lines[(k + 3) % 4]!;
    const b = lines[k]!;
    const den = a.t[0] * b.t[1] - a.t[1] * b.t[0];
    if (Math.abs(den) < 1e-9) out.push(b.p);
    else {
      const w = sub(b.p, a.p);
      const s = (w[0] * b.t[1] - w[1] * b.t[0]) / den;
      out.push([a.p[0] + a.t[0] * s, a.p[1] + a.t[1] * s]);
    }
  }
  return out as unknown as Quad;
}

export function quadCenter(q: Quad): [number, number] {
  return [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4];
}

/** Twice the signed area (positive: inside on the left, counter-clockwise in x/z). */
function signedArea2(q: Quad): number {
  let a = 0;
  for (let k = 0; k < 4; k++) {
    const p = q[k]!;
    const n = q[(k + 1) % 4]!;
    a += p[0] * n[1] - n[0] * p[1];
  }
  return a;
}

/** Point in a convex quad (either winding). */
export function inQuad(q: Quad, x: number, z: number): boolean {
  let sign = 0;
  for (let k = 0; k < 4; k++) {
    const p = q[k]!;
    const n = q[(k + 1) % 4]!;
    const c = (n[0] - p[0]) * (z - p[1]) - (n[1] - p[1]) * (x - p[0]);
    if (Math.abs(c) < 1e-9) continue;
    const s = c > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

export function shrinkQuad(q: Quad, inset: number): Quad {
  if (inset === 0) return q;
  const c = quadCenter(q);
  return q.map((p) => lerp2(p, c, inset)) as unknown as Quad;
}

/**
 * `q` cut back so it clears every rectangle (grown by `margin`): for each rectangle it hits,
 * the side that needs the least trimming slides toward the opposite side (its street, in
 * `sideEdges`, is dropped). Null when no cut keeps 35% of the block.
 */
function clearOfExcluded(q: Quad, shapes: readonly Footprint[], margin: number, sideEdges: (unknown | undefined)[]): Quad | null {
  let cur = q;
  const area0 = Math.abs(signedArea2(q));
  for (const r of shapes) {
    if (!quadHitsRect(cur, r, margin)) continue;
    let best: { t: number; quad: Quad; side: number } | null = null;
    for (let k = 0; k < 4; k++) {
      const trimmed = (t: number): Quad => {
        const out = cur.map((c) => [c[0], c[1]] as XZ) as unknown as XZ[];
        const a = cur[k]!, b = cur[(k + 1) % 4]!, oppA = cur[(k + 3) % 4]!, oppB = cur[(k + 2) % 4]!;
        out[k] = [a[0] + (oppA[0] - a[0]) * t, a[1] + (oppA[1] - a[1]) * t];
        out[(k + 1) % 4] = [b[0] + (oppB[0] - b[0]) * t, b[1] + (oppB[1] - b[1]) * t];
        return out as unknown as Quad;
      };
      if (quadHitsRect(trimmed(0.65), r, margin)) continue;
      let lo = 0, hi = 0.65;
      for (let n = 0; n < 12; n++) {
        const mid = (lo + hi) / 2;
        if (quadHitsRect(trimmed(mid), r, margin)) lo = mid; else hi = mid;
      }
      if (best === null || hi < best.t) best = { t: hi, quad: trimmed(hi), side: k };
    }
    if (best === null) return null;
    cur = best.quad;
    sideEdges[best.side] = undefined;
  }
  return Math.abs(signedArea2(cur)) >= area0 * 0.35 ? cur : null;
}

/** Points of a footprint grown by `margin` that lie on or in it: a rectangle's corners, a polygon's vertices, a circle's center. */
function footprintCorners(r: Footprint, margin: number): readonly (readonly [number, number])[] {
  if (r.kind === 'rect') {
    const hx = r.hx + margin;
    const hz = r.hz + margin;
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sz]) => [r.x + sx! * hx * r.cos - sz! * hz * r.sin, r.z + sx! * hx * r.sin + sz! * hz * r.cos] as const);
  }
  return r.kind === 'polygon' ? r.points : [footprintAnchor(r)];
}

/** Whether quad `q` overlaps footprint `r` grown by `margin` (corners either way, or a side crossing it). */
function quadHitsRect(q: Quad, r: Footprint, margin: number): boolean {
  for (let k = 0; k < 4; k++) {
    const a = q[k]!;
    const b = q[(k + 1) % 4]!;
    if (rectHits(r, a[0], a[1], b[0], b[1], margin)) return true;
  }
  return footprintCorners(r, margin).some(([x, z]) => inQuad(q, x, z));
}

function rectHits(r: Footprint, x0: number, z0: number, x1: number, z1: number, margin = 0): boolean {
  // Segment (x0,z0)-(x1,z1) vs footprint: sample (blocks are tens of meters; 8 samples are plenty).
  for (let i = 0; i <= 8; i++) {
    const x = x0 + ((x1 - x0) * i) / 8;
    const z = z0 + ((z1 - z0) * i) / 8;
    if (footprintHits(r, x, z, margin)) return true;
  }
  return false;
}

// ── Palettes (sRGB) ─────────────────────────────────────────────────────────────

const GLASS: readonly Rgb[] = [[0.3, 0.43, 0.53], [0.22, 0.32, 0.4], [0.46, 0.52, 0.56], [0.42, 0.36, 0.28], [0.2, 0.33, 0.34], [0.36, 0.4, 0.46]];
const FRAMES: readonly Rgb[] = [[0.78, 0.8, 0.82], [0.2, 0.21, 0.23], [0.55, 0.57, 0.6], [0.66, 0.6, 0.5]];
const CONCRETE: readonly Rgb[] = [[0.74, 0.72, 0.68], [0.62, 0.62, 0.6], [0.8, 0.77, 0.7], [0.52, 0.54, 0.56]];
const COMMERCIAL: readonly Rgb[] = [[0.55, 0.27, 0.2], [0.63, 0.37, 0.27], [0.78, 0.72, 0.62], [0.86, 0.8, 0.68], [0.6, 0.6, 0.6], [0.45, 0.52, 0.48], [0.7, 0.5, 0.36]];
const RESIDENTIAL: readonly Rgb[] = [[0.82, 0.76, 0.66], [0.7, 0.55, 0.45], [0.86, 0.84, 0.8], [0.62, 0.66, 0.7], [0.76, 0.62, 0.5], [0.66, 0.42, 0.34]];
const HOUSES: readonly Rgb[] = [[0.9, 0.88, 0.8], [0.72, 0.8, 0.86], [0.88, 0.8, 0.7], [0.72, 0.78, 0.66], [0.93, 0.92, 0.9], [0.84, 0.74, 0.6]];
const HOUSE_ROOFS: readonly Rgb[] = [[0.36, 0.2, 0.17], [0.3, 0.3, 0.33], [0.46, 0.31, 0.22], [0.24, 0.26, 0.3]];
const INDUSTRIAL: readonly Rgb[] = [[0.6, 0.62, 0.6], [0.5, 0.53, 0.56], [0.7, 0.66, 0.58], [0.46, 0.41, 0.37], [0.55, 0.6, 0.66]];
const WINDOW_DARK: Rgb = [0.18, 0.22, 0.26];

// ── The generator ───────────────────────────────────────────────────────────────

const PARKING = 2.3;

interface Lot {
  readonly cell: number;
  /** Parametric rectangle in the cell's lot quad. */
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
  /** Which side of the lot faces the street (0: v = v0, 1: u = u1, 2: v = v1, 3: u = u0). */
  readonly front: number;
}

/** The plan of a city: same spec and ground, same plan, on any thread. */
export function generateCity(spec: CitySpec, ground: number): CityLayout {
  const seed = spec.seed;
  const [ax0, az0, ax1, az1] = spec.area;
  const cx = (ax0 + ax1) / 2;
  const cz = (az0 + az1) / 2;
  const ang = (spec.roads.angle * Math.PI) / 180;
  const cos = Math.cos(ang);
  const sin = Math.sin(ang);
  const toWorld = (gx: number, gz: number): [number, number] => [cx + gx * cos - gz * sin, cz + gx * sin + gz * cos];
  const toGrid = (x: number, z: number): [number, number] => [(x - cx) * cos + (z - cz) * sin, -(x - cx) * sin + (z - cz) * cos];

  // Grid extents covering the (rotated) area.
  const corners = [toGrid(ax0, az0), toGrid(ax1, az0), toGrid(ax1, az1), toGrid(ax0, az1)];
  const gx0 = Math.min(...corners.map((c) => c[0]));
  const gx1 = Math.max(...corners.map((c) => c[0]));
  const gz0 = Math.min(...corners.map((c) => c[1]));
  const gz1 = Math.max(...corners.map((c) => c[1]));
  const [bx, bz] = spec.roads.block;
  const lines = (lo: number, hi: number, step: number, axis: number): number[] => {
    const out: number[] = [];
    const rng = new Rng(seed, 0x11e5, axis);
    let at = lo;
    while (at <= hi + 1e-6) {
      out.push(at);
      at += step * (1 + (rng.next() - 0.5) * 0.3 * Math.min(1, spec.roads.curviness * 3 + 0.25));
    }
    return out;
  };
  const xs = lines(gx0, gx1, bx, 0);
  const zs = lines(gz0, gz1, bz, 1);
  const [dgx, dgz] = toGrid(spec.downtown[0], spec.downtown[1]);
  const nearestLine = (ls: readonly number[], v: number): number => ls.reduce((best, l, i) => (Math.abs(l - v) < Math.abs(ls[best]! - v) ? i : best), 0);
  const majorX = nearestLine(xs, dgx) % spec.roads.majorEvery;
  const majorZ = nearestLine(zs, dgz) % spec.roads.majorEvery;
  const nx = xs.length;
  const nz = zs.length;
  const warpAmp = spec.roads.curviness * 0.22 * Math.min(bx, bz);
  const warpFreq = 1 / (2.6 * Math.max(bx, bz));

  const inArea = (x: number, z: number): boolean => x >= ax0 - 1e-6 && x <= ax1 + 1e-6 && z >= az0 - 1e-6 && z <= az1 + 1e-6;

  // ── Nodes ──
  const nodeAt: number[] = new Array(nx * nz).fill(-1);
  const nodes: RoadNode[] = [];
  const gridPos = new Map<number, [number, number]>();
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const gx = xs[i]! + noise2(seed + 17, xs[i]! * warpFreq, zs[j]! * warpFreq) * warpAmp;
      const gz = zs[j]! + noise2(seed + 31, xs[i]! * warpFreq + 5.3, zs[j]! * warpFreq - 2.1) * warpAmp;
      const [x, z] = toWorld(gx, gz);
      // A node inside an excluded rectangle stays (a block corner) but gets no street:
      // edges that touch a rectangle are dropped below, and so are blocks that overlap one.
      if (!inArea(x, z)) continue;
      const id = nodes.length;
      nodes.push({ id, x, z, y: ground, edges: [], signal: false });
      nodeAt[j * nx + i] = id;
      gridPos.set(id, [i, j]);
    }
  }

  // ── Landmark sites (reserve blocks, clear the streets inside them) ──
  const landmarks: LandmarkPlan[] = spec.landmarks.map((l) => ({ kind: l.kind, name: l.name, at: l.at, size: l.size, height: l.height, cells: [], edge: -1 }));
  const siteRects = landmarks.map((l) => (l.kind === 'park' || l.kind === 'plaza' || l.kind === 'stadium'
    ? [l.at[0] - l.size[0] / 2, l.at[1] - l.size[1] / 2, l.at[0] + l.size[0] / 2, l.at[1] + l.size[1] / 2] : null));
  const insideSite = (x: number, z: number, margin: number): number =>
    siteRects.findIndex((r) => r !== null && x > r[0]! + margin && x < r[2]! - margin && z > r[1]! + margin && z < r[3]! - margin);

  // ── Edges ──
  const halfWidthOf = (major: boolean, parking: boolean): number => {
    const lanes = major ? spec.roads.majorLanes : spec.roads.minorLanes;
    return lanes * spec.roads.laneWidth + (major && lanes >= 2 ? 0.6 : 0) + (parking ? PARKING : 0);
  };
  const parkingOn = spec.props.parked.length > 0;
  type EdgeDraft = { a: number; b: number; major: boolean; line: 'x' | 'z'; index: number; alive: boolean; bridge: BridgeProfile | null };
  const drafts: EdgeDraft[] = [];
  const edgeKey = new Map<string, number>();
  const addDraft = (a: number, b: number, major: boolean, line: 'x' | 'z', index: number, key: string): void => {
    const A = nodes[a]!;
    const B = nodes[b]!;
    if (spec.exclude.some((r) => rectHits(r, A.x, A.z, B.x, B.z))) return;
    if (insideSite((A.x + B.x) / 2, (A.z + B.z) / 2, 6) >= 0) return;
    edgeKey.set(key, drafts.length);
    drafts.push({ a, b, major, line, index, alive: true, bridge: null });
  };
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = nodeAt[j * nx + i]!;
      if (a < 0) continue;
      const right = i + 1 < nx ? nodeAt[j * nx + i + 1]! : -1;
      const up = j + 1 < nz ? nodeAt[(j + 1) * nx + i]! : -1;
      // An edge along x lies on the grid line z = zs[j]: an avenue when j is a major line.
      if (right >= 0) addDraft(a, right, (j - majorZ) % spec.roads.majorEvery === 0 || j === 0 || j === nz - 1, 'z', j, `h${i},${j}`);
      if (up >= 0) addDraft(a, up, (i - majorX) % spec.roads.majorEvery === 0 || i === 0 || i === nx - 1, 'x', i, `v${i},${j}`);
    }
  }

  // Merge some blocks: leave out minor streets where the network stays connected nearby.
  const adjacency = (): Map<number, number[]> => {
    const m = new Map<number, number[]>();
    drafts.forEach((d, k) => {
      if (!d.alive) return;
      (m.get(d.a) ?? m.set(d.a, []).get(d.a)!).push(k);
      (m.get(d.b) ?? m.set(d.b, []).get(d.b)!).push(k);
    });
    return m;
  };
  const adj = adjacency();
  const degree = (n: number): number => (adj.get(n) ?? []).filter((k) => drafts[k]!.alive).length;
  const reachableWithout = (from: number, to: number, skip: number, limit: number): boolean => {
    const seen = new Set([from]);
    let frontier = [from];
    for (let step = 0; step < limit && frontier.length > 0; step++) {
      const next: number[] = [];
      for (const n of frontier) {
        for (const k of adj.get(n) ?? []) {
          const d = drafts[k]!;
          if (!d.alive || k === skip) continue;
          const o = d.a === n ? d.b : d.a;
          if (o === to) return true;
          if (!seen.has(o)) {
            seen.add(o);
            next.push(o);
          }
        }
      }
      frontier = next;
    }
    return false;
  };
  const mergedCell = new Set<string>();
  const districtAtXZ = (x: number, z: number): { kind: DistrictKind; name: string; p: number } => districtOf(spec, x, z);
  drafts.forEach((d, k) => {
    if (d.major) return;
    const A = nodes[d.a]!;
    const B = nodes[d.b]!;
    const mx = (A.x + B.x) / 2;
    const mz = (A.z + B.z) / 2;
    const zone = districtAtXZ(mx, mz).kind;
    const factor = zone === 'industrial' ? 1.8 : zone === 'downtown' ? 0.5 : zone === 'suburban' ? 1.3 : 1;
    if (hash(seed, 0x6d65, k) >= spec.roads.merge * factor) return;
    // The two blocks this street separates (by grid index), kept to pairs.
    const [i, j] = gridPos.get(d.a)!;
    const pair = d.line === 'z' ? [`${i},${j - 1}`, `${i},${j}`] : [`${i - 1},${j}`, `${i},${j}`];
    if (pair.some((c) => mergedCell.has(c))) return;
    if (degree(d.a) <= 2 || degree(d.b) <= 2) return;
    if (!reachableWithout(d.a, d.b, k, 10)) return;
    d.alive = false;
    for (const c of pair) mergedCell.add(c);
  });

  // Bridges: their own avenue between two ends, snapped to nearby street nodes.
  landmarks.forEach((l, li) => {
    if (l.kind !== 'bridge') return;
    const s = spec.landmarks[li]!;
    const snap = (p: XZ): number => {
      let best = -1;
      let bestD = 30;
      for (const n of nodes) {
        const dd = dist2([n.x, n.z], p);
        if (dd < bestD && (adj.get(n.id)?.length ?? 0) > 0) {
          best = n.id;
          bestD = dd;
        }
      }
      if (best >= 0) return best;
      const id = nodes.length;
      nodes.push({ id, x: p[0], z: p[1], y: ground, edges: [], signal: false });
      return id;
    };
    const a = snap(s.from);
    const b = snap(s.to);
    if (a === b) return;
    const length = dist2([nodes[a]!.x, nodes[a]!.z], [nodes[b]!.x, nodes[b]!.z]);
    l.edge = drafts.length;
    drafts.push({ a, b, major: true, line: 'x', index: -1, alive: true, bridge: { height: s.height, ramp: Math.min(s.height * 9, length * 0.3), name: s.name } });
  });

  // Keep the largest connected network (exclusions can cut off scraps).
  const live = adjacency();
  const component = new Map<number, number>();
  let best = -1;
  let bestSize = 0;
  for (const n of live.keys()) {
    if (component.has(n)) continue;
    const id = n;
    let size = 0;
    const stack = [n];
    component.set(n, id);
    while (stack.length > 0) {
      const m = stack.pop()!;
      size++;
      for (const k of live.get(m) ?? []) {
        const d = drafts[k]!;
        const o = d.a === m ? d.b : d.a;
        if (!component.has(o)) {
          component.set(o, id);
          stack.push(o);
        }
      }
    }
    if (size > bestSize) {
      bestSize = size;
      best = id;
    }
  }
  for (const d of drafts) if (d.alive && component.get(d.a) !== best) d.alive = false;

  // Final edges.
  const edges: RoadEdge[] = [];
  const edgeOfDraft = new Map<number, number>();
  drafts.forEach((d, k) => {
    if (!d.alive) return;
    const A = nodes[d.a]!;
    const B = nodes[d.b]!;
    const id = edges.length;
    const zone = districtAtXZ((A.x + B.x) / 2, (A.z + B.z) / 2).kind;
    const parking = parkingOn && !d.major && d.bridge === null && zone !== 'downtown' && zone !== 'industrial';
    const lanes = d.major ? spec.roads.majorLanes : spec.roads.minorLanes;
    edges.push({
      id, a: d.a, b: d.b, major: d.major, lanes, halfWidth: halfWidthOf(d.major, parking), parking,
      length: dist2([A.x, A.z], [B.x, B.z]), bridge: d.bridge, cells: [],
    });
    edgeOfDraft.set(k, id);
    A.edges.push(id);
    B.edges.push(id);
  });
  for (const l of landmarks) if (l.edge >= 0) l.edge = edgeOfDraft.get(l.edge) ?? -1;
  for (const n of nodes) {
    const majors = n.edges.filter((e) => edges[e]!.major).length;
    n.signal = n.edges.length >= 3 && majors >= 1 && !n.edges.some((e) => edges[e]!.bridge !== null);
  }
  // Intersection clearance: how far from a node lanes stop and blocks begin.
  const edgeAt = (key: string): RoadEdge | undefined => {
    const k = edgeKey.get(key);
    const id = k === undefined ? undefined : edgeOfDraft.get(k);
    return id === undefined ? undefined : edges[id];
  };

  // ── Blocks ──
  const cells: Cell[] = [];
  const sidewalk = spec.roads.sidewalk;
  for (let j = 0; j + 1 < nz; j++) {
    for (let i = 0; i + 1 < nx; i++) {
      const ids = [nodeAt[j * nx + i]!, nodeAt[j * nx + i + 1]!, nodeAt[(j + 1) * nx + i + 1]!, nodeAt[(j + 1) * nx + i]!];
      if (ids.some((n) => n < 0)) continue;
      const grid = ids.map((n) => [nodes[n]!.x, nodes[n]!.z] as XZ) as unknown as Quad;
      const sideEdges = [edgeAt(`h${i},${j}`), edgeAt(`v${i + 1},${j}`), edgeAt(`h${i},${j + 1}`), edgeAt(`v${i},${j}`)];
      // A block reaching into an excluded rectangle is cut back from its side facing it (that
      // side then has no street), so the city builds right up to hand-built places.
      const q = clearOfExcluded(grid, spec.exclude, 4, sideEdges);
      if (q === null) continue;
      const center = quadCenter(q);
      const sides = sideEdges.map((e) => (e === undefined ? -1 : e.id)) as unknown as [number, number, number, number];
      // Corner order is counter-clockwise in grid space; keep the inside on the left in world too.
      if (signedArea2(q) <= 0) continue;
      const hw = sideEdges.map((e) => (e === undefined ? 0 : e.halfWidth));
      const curbQ = insetQuad(q, hw);
      const lotQ = insetQuad(q, hw.map((h, k) => (sideEdges[k] === undefined ? 0 : h + sidewalk)));
      const walkQ = insetQuad(q, hw.map((h, k) => (sideEdges[k] === undefined ? 0 : h + sidewalk * 0.55)));
      if (signedArea2(lotQ) <= 50) continue;
      const district = districtAtXZ(center[0], center[1]);
      const id = cells.length;
      const site = landmarks.findIndex((l, li) => {
        const r = siteRects[li];
        return r !== null && r !== undefined && center[0] > r[0]! && center[0] < r[2]! && center[1] > r[1]! && center[1] < r[3]!;
      });
      const towerSite = landmarks.findIndex((l) => l.kind === 'tower' && inQuad(lotQ, l.at[0], l.at[1]));
      let kind: CellKind = 'block';
      let landmark = -1;
      if (site >= 0) {
        const lk = landmarks[site]!.kind;
        kind = lk === 'park' ? 'park' : lk === 'plaza' ? 'plaza' : 'landmark';
        landmark = site;
        landmarks[site]!.cells.push(id);
      } else if (towerSite >= 0) {
        kind = 'landmark';
        landmark = towerSite;
        landmarks[towerSite]!.cells.push(id);
      } else if (sides.every((s) => s < 0)) {
        kind = 'park';
      } else if (district.kind === 'park') {
        kind = 'park';
      } else {
        const parkChance = spec.parks * (district.kind === 'residential' || district.kind === 'suburban' ? 1.4 : district.kind === 'downtown' ? 0.7 : 0.8);
        if (hash(seed, 0x7061, i, j) < parkChance) kind = district.kind === 'downtown' && hash(seed, 0x706c, i, j) < 0.5 ? 'plaza' : 'park';
      }
      cells.push({
        id, i, j, corners: q, sides, kind, district: district.kind, districtName: district.name, proximity: district.p,
        curb: curbQ, lot: lotQ, walk: walkQ, landmark,
      });
      for (const e of sideEdges) if (e !== undefined) e.cells.push(id);
    }
  }

  // ── Lots and buildings ──
  const buildings: Building[] = [];
  const props: PropPlacement[] = [];
  const curbY = ground + spec.roads.curb;
  const addProp = (role: PieceRole, prefab: string | undefined, x: number, z: number, yaw: number, y = curbY, building = -1): void => {
    if (prefab === undefined) return;
    props.push({ id: props.length, role, prefab, x, y, z, yaw, building });
  };

  for (const cell of cells) {
    if (cell.kind === 'landmark') {
      const l = landmarks[cell.landmark]!;
      if (l.kind === 'tower' && l.cells[0] === cell.id) buildings.push(spireBuilding(spec, cell, l, buildings.length, curbY));
      continue;
    }
    if (cell.kind !== 'block') continue;
    const lots = lotsOf(spec, cell);
    lots.forEach((lot, li) => {
      const b = massBuilding(spec, cell, lot, li, buildings.length, curbY);
      if (b === null) return;
      buildings.push(b);
      if (b.enterable && b.door !== null && spec.props.interior.length > 0) {
        // Dress the ground-floor room: a few interior props along the back half.
        const rng = new Rng(seed, 0x696e, b.id);
        const fp = b.footprint;
        const count = rng.int(2, 4);
        for (let k = 0; k < count; k++) {
          const p = footprintPoint(fp, b.front, 0.2 + 0.6 * (k + 0.5) / count, rng.range(0.55, 0.8));
          addProp('interior', rng.pick(spec.props.interior), p[0], p[1], b.door.yaw + 180, curbY, b.id);
        }
      }
    });
  }

  // ── Street furniture along each curb ──
  for (const cell of cells) {
    for (let k = 0; k < 4; k++) {
      const edgeId = cell.sides[k]!;
      if (edgeId < 0) continue;
      const edge = edges[edgeId]!;
      const a = cell.curb[k]!;
      const b = cell.curb[(k + 1) % 4]!;
      const t = sub(b, a);
      const length = len(t);
      if (length < 14) continue;
      const dir: XZ = [t[0] / length, t[1] / length];
      const inward: XZ = [-dir[1], dir[0]];
      const yawOut = (Math.atan2(-inward[0], -inward[1]) * 180) / Math.PI;
      const yawAlong = (Math.atan2(dir[0], dir[1]) * 180) / Math.PI;
      const at = (s: number, off: number): [number, number] => [a[0] + dir[0] * s + inward[0] * off, a[1] + dir[1] * s + inward[1] * off];
      const rng = new Rng(seed, 0x7072, cell.id, k);
      const roles = spec.props.roles;
      const zone = cell.district;
      const lampStep = edge.major ? 26 : 32;
      const lamps = Math.max(1, Math.floor((length - 12) / lampStep));
      for (let n = 0; n <= lamps; n++) {
        const s = 6 + ((length - 12) * n) / Math.max(1, lamps);
        const p = at(s, 0.55);
        // Without a streetlight prefab the city draws its own lamps here (prefab "").
        addProp('streetlight', roles.streetlight ?? '', p[0], p[1], yawOut);
      }
      const leafy = zone !== 'industrial' && cell.kind === 'block' && (zone !== 'downtown' || edge.major);
      if (leafy && roles.tree !== undefined) {
        const step = zone === 'suburban' ? 14 : 11;
        for (let s = 10; s < length - 10; s += step) {
          const near = Math.abs(((s - 6) % lampStep) - lampStep / 2) < 4;
          if (!near && rng.chance(0.8)) {
            const p = at(s + rng.range(-1, 1), 0.9);
            addProp('tree', roles.tree, p[0], p[1], rng.range(0, 360));
          }
        }
      }
      if (k % 2 === 0 && rng.chance(0.55)) {
        const p = at(length - 5, 0.5);
        addProp('hydrant', roles.hydrant, p[0], p[1], yawOut);
      }
      if ((zone === 'downtown' || zone === 'commercial') && length > 30) {
        if (rng.chance(0.6)) {
          const p = at(rng.range(12, length - 12), sidewalk - 0.7);
          addProp('bench', roles.bench, p[0], p[1], yawOut);
        }
        if (rng.chance(0.7)) {
          const p = at(9 + rng.range(0, 4), 0.6);
          addProp('bin', roles.bin, p[0], p[1], yawAlong);
        }
      }
      if (edge.major && roles.bus_stop !== undefined && length > 50 && hash(seed, 0x6273, edgeId) < 0.28 && (edge.cells[0] === cell.id)) {
        const p = at(length * 0.55, 1.4);
        addProp('bus_stop', roles.bus_stop, p[0], p[1], yawOut);
      }
      if (edge.parking && spec.props.parked.length > 0) {
        // Parked cars face the curb lane's traffic: right-hand traffic runs against this side's direction.
        const yaw = spec.drive === 'right' ? yawAlong + 180 : yawAlong;
        for (let s = 9; s < length - 9; s += 6.4) {
          if (!rng.chance(0.42)) continue;
          const p = at(s, -PARKING / 2);
          addProp('parked', rng.pick(spec.props.parked), p[0], p[1], yaw, ground);
        }
      }
    }
    if (cell.kind === 'park' && spec.props.roles.tree !== undefined) {
      const rng = new Rng(seed, 0x7472, cell.id);
      const count = Math.round((Math.abs(signedArea2(cell.lot)) / 2) / 160);
      for (let n = 0; n < count; n++) {
        const u = rng.range(0.06, 0.94);
        const v = rng.range(0.06, 0.94);
        if (Math.abs(u - v) < 0.07 || Math.abs(u + v - 1) < 0.07) continue; // the diagonal paths
        const p = bilinear(cell.lot, u, v);
        addProp('tree', spec.props.roles.tree, p[0], p[1], rng.range(0, 360));
      }
      if (spec.props.roles.bench !== undefined) {
        for (const t of [0.3, 0.7]) {
          const p = bilinear(cell.lot, t, t + 0.06);
          addProp('bench', spec.props.roles.bench, p[0], p[1], rng.range(0, 360));
        }
      }
    }
  }

  // ── The far skyline ring ──
  const skyline: SkylineMass[] = [];
  if (spec.skyline !== null) {
    const rng = new Rng(seed, 0x736b);
    for (let n = 0; n < spec.skyline.count; n++) {
      const a = rng.range(0, Math.PI * 2);
      const r = rng.range(spec.skyline.radius[0], spec.skyline.radius[1]);
      const h = spec.skyline.height[0] + (spec.skyline.height[1] - spec.skyline.height[0]) * rng.next() ** 1.6;
      const w = rng.range(18, 50);
      skyline.push({
        x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r, w, d: w * rng.range(0.6, 1.4), h, yaw: rng.range(0, 90),
        color: rng.pick(h > 70 ? GLASS : CONCRETE),
      });
    }
  }

  let bx0 = Infinity;
  let bz0 = Infinity;
  let bx1 = -Infinity;
  let bz1 = -Infinity;
  for (const n of nodes) {
    if (n.edges.length === 0) continue;
    bx0 = Math.min(bx0, n.x);
    bz0 = Math.min(bz0, n.z);
    bx1 = Math.max(bx1, n.x);
    bz1 = Math.max(bz1, n.z);
  }
  if (!Number.isFinite(bx0)) [bx0, bz0, bx1, bz1] = spec.area;

  return {
    ground, curb: spec.roads.curb, sidewalk, laneWidth: spec.roads.laneWidth, nodes, edges, cells, buildings, props, landmarks, skyline,
    bounds: [bx0, bz0, bx1, bz1],
  };
}

/** The district at a point: explicit districts first (nearest center within its radius), else by downtown proximity. */
export function districtOf(spec: CitySpec, x: number, z: number): { kind: DistrictKind; name: string; p: number } {
  const [ax0, az0, ax1, az1] = spec.area;
  const reach = 0.38 * Math.min(ax1 - ax0, az1 - az0);
  const d = Math.hypot(x - spec.downtown[0], z - spec.downtown[1]) / reach;
  const jitter = noise2(spec.seed + 101, x / 140, z / 140) * 0.08;
  const p = Math.max(0, Math.min(1, Math.exp(-d * d * spec.buildings.falloff) + jitter));
  let named: { kind: DistrictKind; name: string } | null = null;
  let nearest = Infinity;
  for (const district of spec.districts) {
    const dd = Math.hypot(x - district.at[0], z - district.at[1]);
    if (dd <= district.radius && dd / district.radius < nearest) {
      nearest = dd / district.radius;
      named = { kind: district.kind, name: district.name };
    }
  }
  if (named !== null) return { ...named, p: named.kind === 'downtown' ? Math.max(p, 0.6) : p };
  const base = baseDistrict(spec.style);
  const kind: DistrictKind = spec.style === 'suburb' || spec.style === 'industrial'
    ? (p > 0.7 ? 'commercial' : base)
    : p > 0.55 ? 'downtown' : p > 0.25 ? 'commercial' : base;
  return { kind, name: kind, p };
}

/** A point in a footprint by fractions along its front (`along`) and inward from it (`depth`). */
export function footprintPoint(fp: Quad, front: number, along: number, depth: number): [number, number] {
  const a = fp[front]!;
  const b = fp[(front + 1) % 4]!;
  const c = fp[(front + 2) % 4]!;
  const d = fp[(front + 3) % 4]!;
  const onFront = lerp2(a, b, along);
  const onBack = lerp2(d, c, along);
  return lerp2(onFront, onBack, depth);
}

/** Perimeter lots of a block: strips along each street side, cut into lots by district. */
function lotsOf(spec: CitySpec, cell: Cell): Lot[] {
  const rng = new Rng(spec.seed, 0x6c6f, cell.id);
  const q = cell.lot;
  const lu = (dist2(q[0], q[1]) + dist2(q[3], q[2])) / 2;
  const lv = (dist2(q[0], q[3]) + dist2(q[1], q[2])) / 2;
  const has = cell.sides.map((s) => s >= 0);
  const zone = cell.district;
  const out: Lot[] = [];
  // Downtown and industrial blocks: a few big lots covering the block.
  if (zone === 'downtown' || zone === 'industrial') {
    const split = zone === 'downtown' ? rng.pick([1, 2, 2, 4]) : rng.pick([1, 2, 2, 3]);
    const alongU = lu >= lv;
    const parts = split === 4 ? [[0, 0.5, 0, 0.5], [0.5, 1, 0, 0.5], [0, 0.5, 0.5, 1], [0.5, 1, 0.5, 1]]
      : Array.from({ length: split }, (_, n) => (alongU ? [n / split, (n + 1) / split, 0, 1] : [0, 1, n / split, (n + 1) / split]));
    for (const [u0, u1, v0, v1] of parts) {
      // Front: the street side this lot touches (prefer avenues: the longest street-facing side).
      const touching = [v0 === 0 && has[0], u1 === 1 && has[1], v1 === 1 && has[2], u0 === 0 && has[3]];
      let front = touching.findIndex(Boolean);
      if (front < 0) front = has.findIndex(Boolean);
      if (front < 0) continue;
      out.push({ cell: cell.id, u0: u0!, u1: u1!, v0: v0!, v1: v1!, front });
    }
    return out;
  }
  const depth = zone === 'suburban' ? rng.range(26, 32) : zone === 'commercial' ? rng.range(16, 24) : rng.range(18, 26);
  const width = (): number => (zone === 'suburban' ? rng.range(18, 25) : zone === 'commercial' ? rng.range(9, 20) : rng.range(13, 24));
  const cap = (a: boolean, b: boolean): number => (a && b ? 0.5 : 0.9);
  const dv0 = has[0] ? Math.min(depth / lv, cap(has[0]!, has[2]!)) : 0;
  const dv2 = has[2] ? Math.min(depth / lv, cap(has[0]!, has[2]!)) : 0;
  const du1 = has[1] ? Math.min(depth / lu, cap(has[1]!, has[3]!)) : 0;
  const du3 = has[3] ? Math.min(depth / lu, cap(has[1]!, has[3]!)) : 0;
  const cut = (lo: number, hi: number, meters: number, make: (a: number, b: number) => void): void => {
    let at = lo;
    while (hi - at > 1e-6) {
      const w = width() / meters;
      let next = at + w;
      if (hi - next < (0.6 * 12) / meters) next = hi;
      make(at, Math.min(hi, next));
      at = next;
    }
  };
  if (has[0]) cut(0, 1, lu, (a, b) => out.push({ cell: cell.id, u0: a, u1: b, v0: 0, v1: dv0, front: 0 }));
  if (has[2]) cut(0, 1, lu, (a, b) => out.push({ cell: cell.id, u0: a, u1: b, v0: 1 - dv2, v1: 1, front: 2 }));
  if (has[1]) cut(dv0, 1 - dv2, lv, (a, b) => out.push({ cell: cell.id, u0: 1 - du1, u1: 1, v0: a, v1: b, front: 1 }));
  if (has[3]) cut(dv0, 1 - dv2, lv, (a, b) => out.push({ cell: cell.id, u0: 0, u1: du3, v0: a, v1: b, front: 3 }));
  return out.filter((l) => l.u1 - l.u0 > 1e-3 && l.v1 - l.v0 > 1e-3);
}

/** A lot's building (or null: an empty lot — a gap in the street wall, a yard). */
function massBuilding(spec: CitySpec, cell: Cell, lot: Lot, index: number, id: number, base: number): Building | null {
  const rng = new Rng(spec.seed, 0x6275, cell.id, index);
  const zone = cell.district;
  if (!rng.chance(spec.buildings.density + (zone === 'downtown' ? 0.08 : 0))) return null;
  const q = cell.lot;
  const lu = (dist2(q[0], q[1]) + dist2(q[3], q[2])) / 2;
  const lv = (dist2(q[0], q[3]) + dist2(q[1], q[2])) / 2;
  // Setbacks in meters → parametric, by which way the lot faces.
  const frontSet = zone === 'suburban' ? rng.range(5, 8) : zone === 'residential' ? rng.range(0.5, 3) : zone === 'industrial' ? rng.range(3, 8) : 0;
  const sideGap = zone === 'suburban' ? rng.range(2.5, 4.5) : zone === 'residential' ? rng.range(0, 2.5) : zone === 'industrial' ? rng.range(3, 6) : rng.chance(0.15) ? 1.5 : 0;
  const backSet = zone === 'suburban' ? rng.range(4, 9) : zone === 'industrial' ? rng.range(3, 8) : rng.range(0, 2);
  let { u0, u1, v0, v1 } = lot;
  const du = (m: number): number => m / lu;
  const dv = (m: number): number => m / lv;
  // front side gets frontSet, opposite gets backSet, the two others sideGap / 2.
  const sets = [0, 0, 0, 0];
  sets[lot.front] = frontSet;
  sets[(lot.front + 2) % 4] = backSet;
  sets[(lot.front + 1) % 4] = sideGap / 2;
  sets[(lot.front + 3) % 4] = sideGap / 2;
  v0 += dv(sets[0]!);
  u1 -= du(sets[1]!);
  v1 -= dv(sets[2]!);
  u0 += du(sets[3]!);
  if (zone === 'suburban') {
    // A house, not a lot-filling slab: cap its size and center it on the lot's width.
    const maxW = rng.range(9, 13);
    const maxD = rng.range(8, 12);
    const alongU = lot.front === 0 || lot.front === 2;
    const [wSpan, dSpan] = alongU ? [(u1 - u0) * lu, (v1 - v0) * lv] : [(v1 - v0) * lv, (u1 - u0) * lu];
    const shrinkW = Math.max(0, (wSpan - maxW) / 2);
    const shrinkD = Math.max(0, dSpan - maxD);
    if (alongU) {
      u0 += du(shrinkW);
      u1 -= du(shrinkW);
      if (lot.front === 0) v1 -= dv(shrinkD);
      else v0 += dv(shrinkD);
    } else {
      v0 += dv(shrinkW);
      v1 -= dv(shrinkW);
      if (lot.front === 1) u0 += du(shrinkD);
      else u1 -= du(shrinkD);
    }
  }
  if ((u1 - u0) * lu < 5 || (v1 - v0) * lv < 5) return null;
  const fp: Quad = [bilinear(q, u0, v0), bilinear(q, u1, v0), bilinear(q, u1, v1), bilinear(q, u0, v1)];
  const frontLen = dist2(fp[lot.front]!, fp[(lot.front + 1) % 4]!);
  const depthLen = dist2(fp[(lot.front + 1) % 4]!, fp[(lot.front + 2) % 4]!);

  const [hEdge, hTop] = spec.buildings.height;
  const p = cell.proximity;
  const fh = spec.buildings.floorHeight;
  let height: number;
  let archetype: Archetype;
  let facade: FacadeKind;
  let roof: RoofKind = 'flat';
  let groundFloor = fh;
  let tiers: Tier[];
  let wall: Rgb;
  let glass: Rgb = GLASS[rng.int(0, GLASS.length - 1)]!;
  let trim: Rgb;
  let roofColor: Rgb = [0.42, 0.42, 0.43];
  let bay = rng.range(3, 4.2);
  let window: [number, number] = [rng.range(0.45, 0.7), rng.range(0.45, 0.62)];
  const envelope = hEdge + (hTop - hEdge) * p ** 1.2;
  switch (zone) {
    case 'downtown': {
      height = Math.min(hTop * 1.25, Math.max(28, envelope * (0.45 + 1.1 * rng.next() ** 2)));
      const curtain = rng.chance(0.7);
      facade = curtain ? 'curtain' : 'punched';
      wall = curtain ? FRAMES[rng.int(0, FRAMES.length - 1)]! : CONCRETE[rng.int(0, CONCRETE.length - 1)]!;
      trim = curtain ? wall : [0.85, 0.84, 0.8];
      groundFloor = rng.range(4.5, 6);
      if (curtain) {
        bay = rng.range(1.5, 3);
        window = [0.9, 0.82];
      }
      if (height > 70 && rng.chance(0.4)) {
        archetype = 'podium';
        const podium = groundFloor + fh * rng.int(2, 4);
        const towerInset = rng.range(0.18, 0.3);
        tiers = [{ inset: 0, y0: 0, y1: podium }, { inset: towerInset, y0: podium, y1: height }];
      } else if (height > 60) {
        archetype = 'tower';
        const steps = rng.int(1, 3);
        tiers = [];
        let y = 0;
        for (let s = 0; s <= steps; s++) {
          const top = s === steps ? height : y + (height - y) * rng.range(0.45, 0.7);
          tiers.push({ inset: s * rng.range(0.08, 0.14), y0: y, y1: top });
          y = top;
        }
      } else {
        archetype = 'block';
        tiers = [{ inset: 0, y0: 0, y1: height }];
      }
      break;
    }
    case 'commercial': {
      height = Math.min(Math.max(hTop * 0.4, 9), 46, Math.max(7.5, envelope * rng.range(0.55, 1.25)));
      archetype = 'block';
      facade = rng.chance(0.75) ? 'storefront' : 'punched';
      wall = COMMERCIAL[rng.int(0, COMMERCIAL.length - 1)]!;
      trim = rng.chance(0.5) ? [0.86, 0.84, 0.78] : [Math.max(0, wall[0] - 0.15), Math.max(0, wall[1] - 0.15), Math.max(0, wall[2] - 0.15)];
      groundFloor = facade === 'storefront' ? rng.range(4, 4.8) : fh;
      tiers = [{ inset: 0, y0: 0, y1: height }];
      break;
    }
    case 'residential': {
      height = Math.min(24, Math.max(7, envelope * rng.range(0.5, 1.1)));
      archetype = 'block';
      facade = 'punched';
      wall = RESIDENTIAL[rng.int(0, RESIDENTIAL.length - 1)]!;
      trim = [0.9, 0.89, 0.85];
      window = [rng.range(0.38, 0.55), rng.range(0.5, 0.62)];
      tiers = [{ inset: 0, y0: 0, y1: height }];
      if (height < 11 && rng.chance(0.4)) roof = 'gable';
      break;
    }
    case 'suburban': {
      height = rng.chance(0.55) ? fh * 2 : fh;
      archetype = 'house';
      facade = 'house';
      wall = HOUSES[rng.int(0, HOUSES.length - 1)]!;
      trim = [0.95, 0.95, 0.93];
      roofColor = HOUSE_ROOFS[rng.int(0, HOUSE_ROOFS.length - 1)]!;
      roof = 'gable';
      bay = rng.range(2.8, 3.6);
      window = [0.42, 0.5];
      tiers = [{ inset: 0, y0: 0, y1: height }];
      break;
    }
    case 'park':
      return null;
    case 'industrial':
    default: {
      height = Math.min(16, Math.max(7, rng.range(7, 13)));
      archetype = 'warehouse';
      facade = 'industrial';
      wall = INDUSTRIAL[rng.int(0, INDUSTRIAL.length - 1)]!;
      trim = [0.3, 0.32, 0.34];
      roof = rng.chance(0.35) ? 'sawtooth' : 'flat';
      groundFloor = height;
      bay = rng.range(5, 7);
      window = [0.6, 0.18];
      tiers = [{ inset: 0, y0: 0, y1: height }];
      break;
    }
  }
  if (facade === 'punched' || facade === 'house') glass = WINDOW_DARK;
  const floors = Math.max(1, Math.round((height - groundFloor) / fh) + 1);
  const enterable = (zone === 'commercial' || zone === 'downtown' || zone === 'residential') && frontLen >= 8 && depthLen >= 8
    && rng.chance(spec.buildings.interiors);
  let door: Building['door'] = null;
  {
    const a = fp[lot.front]!;
    const b = fp[(lot.front + 1) % 4]!;
    const t = sub(b, a);
    const l = len(t);
    const mid = lerp2(a, b, 0.5);
    // Out of the building: to the right going a → b (the inside is on the left).
    const out: XZ = [t[1] / l, -t[0] / l];
    door = { x: mid[0], z: mid[1], yaw: (Math.atan2(out[0], out[1]) * 180) / Math.PI, width: zone === 'industrial' ? 4 : 1.8 };
  }
  return {
    id, cell: cell.id, district: zone, archetype, footprint: fp, front: lot.front, base, height, floors, floorHeight: fh, groundFloor, tiers, roof,
    facade, wall, glass, trim, roofColor, bay, window, enterable, door, seed: Math.floor(rng.next() * 1e9), name: '',
  };
}

function spireBuilding(spec: CitySpec, cell: Cell, l: LandmarkPlan, id: number, base: number): Building {
  const rng = new Rng(spec.seed, 0x7370, cell.id);
  const c = quadCenter(cell.lot);
  const fit = Math.min(l.size[0], l.size[1], dist2(cell.lot[0], cell.lot[1]) * 0.8, dist2(cell.lot[1], cell.lot[2]) * 0.8) / 2;
  // An upright square aligned to the block's front side.
  const t = sub(cell.lot[1], cell.lot[0]);
  const tl = len(t);
  const ux: XZ = [t[0] / tl, t[1] / tl];
  const uz: XZ = [-ux[1], ux[0]];
  const pt = (sx: number, sz: number): XZ => [c[0] + ux[0] * sx * fit + uz[0] * sz * fit, c[1] + ux[1] * sx * fit + uz[1] * sz * fit];
  const fp: Quad = [pt(-1, -1), pt(1, -1), pt(1, 1), pt(-1, 1)];
  const h = l.height;
  const tiers: Tier[] = [
    { inset: 0, y0: 0, y1: h * 0.42 }, { inset: 0.12, y0: h * 0.42, y1: h * 0.7 }, { inset: 0.24, y0: h * 0.7, y1: h * 0.88 },
    { inset: 0.36, y0: h * 0.88, y1: h * 0.95 },
  ];
  const front = cell.sides.findIndex((s) => s >= 0);
  const f = front < 0 ? 0 : front;
  const a = fp[f]!;
  const b = fp[(f + 1) % 4]!;
  const mid = lerp2(a, b, 0.5);
  const tt = sub(b, a);
  const tlen = len(tt);
  return {
    id, cell: cell.id, district: 'downtown', archetype: 'spire', footprint: fp, front: f, base, height: h, floors: Math.round(h / 4), floorHeight: 4,
    groundFloor: 6, tiers, roof: 'spire', facade: 'curtain', wall: [0.72, 0.75, 0.78], glass: GLASS[rng.int(0, GLASS.length - 1)]!,
    trim: [0.8, 0.82, 0.85], roofColor: [0.6, 0.62, 0.65], bay: 2, window: [0.9, 0.85], enterable: false,
    door: { x: mid[0], z: mid[1], yaw: (Math.atan2(tt[1] / tlen, -tt[0] / tlen) * 180) / Math.PI, width: 3 }, seed: rng.int(0, 1e9), name: l.name,
  };
}

/** Street level y along an edge at distance s from its `a` end (bridges ramp up to their deck). */
export function edgeHeight(layout: CityLayout, edge: RoadEdge, s: number): number {
  const base = layout.ground;
  if (edge.bridge === null) return base;
  const { height, ramp } = edge.bridge;
  const t = Math.min(s, edge.length - s);
  if (t >= ramp) return base + height;
  const k = Math.max(0, t) / ramp;
  return base + height * k * k * (3 - 2 * k);
}
