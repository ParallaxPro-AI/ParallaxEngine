/**
 * Questions game code asks the city (`ctx.city`): which street, lane, block, building or
 * district is here; a driving route between two points; where a sidewalk is. Plain data
 * out (the api layer wraps it in SDK values). All world space, on the ground plane.
 */

import type { CityModel } from './index.js';
import type { Building, RoadEdge } from './layout.js';
import { districtOf, edgeHeight, inQuad, quadCenter } from './layout.js';
import type { Lane } from './lanes.js';
import { pathAt, pathProject } from './lanes.js';

export interface RoadQuery {
  readonly edge: RoadEdge;
  /** Nearest centerline point. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Unit direction a → b (x, z). */
  readonly dx: number;
  readonly dz: number;
  /** Meters from the query point to the centerline. */
  readonly distance: number;
}

function onEdge(model: CityModel, edge: RoadEdge, x: number, z: number): RoadQuery {
  const A = model.layout.nodes[edge.a]!;
  const B = model.layout.nodes[edge.b]!;
  const dx = (B.x - A.x) / edge.length;
  const dz = (B.z - A.z) / edge.length;
  const s = Math.max(0, Math.min(edge.length, (x - A.x) * dx + (z - A.z) * dz));
  const px = A.x + dx * s;
  const pz = A.z + dz * s;
  return { edge, x: px, y: edgeHeight(model.layout, edge, s), z: pz, dx, dz, distance: Math.hypot(x - px, z - pz) };
}

export function nearestRoad(model: CityModel, x: number, z: number): RoadQuery | null {
  let best: RoadQuery | null = null;
  for (const edge of model.layout.edges) {
    const q = onEdge(model, edge, x, z);
    if (best === null || q.distance < best.distance) best = q;
  }
  return best;
}

/** The street whose carriageway (curb to curb) covers the point, or null. */
export function roadAt(model: CityModel, x: number, z: number): RoadQuery | null {
  const q = nearestRoad(model, x, z);
  if (q === null) return null;
  // Junction areas belong to the widest street meeting there.
  return q.distance <= q.edge.halfWidth ? q : null;
}

export interface LaneQuery {
  readonly lane: Lane;
  readonly s: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly tx: number;
  readonly tz: number;
  readonly distance: number;
}

/** The nearest lane, preferring ones heading within 90 degrees of `heading` (yaw degrees) when given. */
export function nearestLane(model: CityModel, x: number, z: number, heading: number | null): LaneQuery | null {
  let best: LaneQuery | null = null;
  let bestScore = Infinity;
  const hx = heading === null ? 0 : Math.sin((heading * Math.PI) / 180);
  const hz = heading === null ? 0 : Math.cos((heading * Math.PI) / 180);
  for (const lane of model.graph.lanes) {
    const hit = pathProject(lane.path, x, z);
    const p = pathAt(lane.path, hit.s);
    const distance = Math.hypot(p.x - x, p.z - z);
    const against = heading !== null && p.tx * hx + p.tz * hz < 0 ? 1000 : 0;
    const score = distance + against;
    if (score < bestScore) {
      bestScore = score;
      best = { lane, s: hit.s, x: p.x, y: p.y, z: p.z, tx: p.tx, tz: p.tz, distance };
    }
  }
  return best;
}

export function buildingAt(model: CityModel, x: number, z: number): Building | null {
  const size = model.index.size;
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      const content = model.index.chunks.get(`${Math.floor(x / size) + i},${Math.floor(z / size) + j}`);
      for (const id of content?.buildings ?? []) {
        const b = model.layout.buildings[id]!;
        if (inQuad(b.footprint, x, z)) return b;
      }
    }
  }
  return null;
}

export function buildingsNear(model: CityModel, x: number, z: number, radius: number): Building[] {
  const size = model.index.size;
  const r = Math.ceil(radius / size) + 1;
  const out: { b: Building; d: number }[] = [];
  for (let i = -r; i <= r; i++) {
    for (let j = -r; j <= r; j++) {
      const content = model.index.chunks.get(`${Math.floor(x / size) + i},${Math.floor(z / size) + j}`);
      for (const id of content?.buildings ?? []) {
        const b = model.layout.buildings[id]!;
        const c = quadCenter(b.footprint);
        const d = Math.hypot(c[0] - x, c[1] - z);
        if (d <= radius) out.push({ b, d });
      }
    }
  }
  return out.sort((a, b) => a.d - b.d || a.b.id - b.b.id).map((o) => o.b);
}

export function districtAt(model: CityModel, x: number, z: number): { name: string; kind: string; downtown: number } {
  const d = districtOf(model.spec, x, z);
  return { name: d.name, kind: d.kind, downtown: d.p };
}

/** A driving route along street centerlines (A* over junctions), from near `a` to near `b`; [] when either is off the network. */
export function route(model: CityModel, ax: number, az: number, bx: number, bz: number): [number, number, number][] {
  const start = nearestRoad(model, ax, az);
  const end = nearestRoad(model, bx, bz);
  if (start === null || end === null) return [];
  const nodes = model.layout.nodes;
  const edges = model.layout.edges;
  if (start.edge.id === end.edge.id) return [[start.x, start.y, start.z], [end.x, end.y, end.z]];
  const goalNodes = new Map<number, number>();
  for (const n of [end.edge.a, end.edge.b]) goalNodes.set(n, Math.hypot(nodes[n]!.x - end.x, nodes[n]!.z - end.z));
  const g = new Map<number, number>();
  const came = new Map<number, number>();
  const open: { n: number; f: number }[] = [];
  const h = (n: number): number => Math.hypot(nodes[n]!.x - end.x, nodes[n]!.z - end.z);
  for (const n of [start.edge.a, start.edge.b]) {
    const cost = Math.hypot(nodes[n]!.x - start.x, nodes[n]!.z - start.z);
    g.set(n, cost);
    open.push({ n, f: cost + h(n) });
  }
  let reached = -1;
  let bestTotal = Infinity;
  while (open.length > 0) {
    open.sort((p, q) => p.f - q.f || p.n - q.n);
    const { n, f } = open.shift()!;
    if (f >= bestTotal) break;
    const tail = goalNodes.get(n);
    if (tail !== undefined && g.get(n)! + tail < bestTotal) {
      bestTotal = g.get(n)! + tail;
      reached = n;
    }
    for (const e of nodes[n]!.edges) {
      const edge = edges[e]!;
      const o = edge.a === n ? edge.b : edge.a;
      const cost = g.get(n)! + edge.length;
      if (cost < (g.get(o) ?? Infinity)) {
        g.set(o, cost);
        came.set(o, n);
        open.push({ n: o, f: cost + h(o) });
      }
    }
  }
  if (reached < 0) return [];
  const chain: number[] = [reached];
  while (came.has(chain[0]!)) chain.unshift(came.get(chain[0]!)!);
  const out: [number, number, number][] = [[start.x, start.y, start.z]];
  for (const n of chain) out.push([nodes[n]!.x, nodes[n]!.y, nodes[n]!.z]);
  out.push([end.x, end.y, end.z]);
  return out;
}

/** The nearest point on the sidewalk walking lines to (x, z), or null when none is within `radius`. */
export function sidewalkNear(model: CityModel, x: number, z: number, radius: number): [number, number, number] | null {
  let best: [number, number, number] | null = null;
  let bestD = radius;
  const y = model.layout.ground + model.layout.curb;
  for (const e of model.walk.edges) {
    if (e.crossing !== null) continue;
    const A = model.walk.nodes[e.a]!;
    const B = model.walk.nodes[e.b]!;
    const dx = B.x - A.x;
    const dz = B.z - A.z;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - A.x) * dx + (z - A.z) * dz) / l2)) : 0;
    const px = A.x + dx * t;
    const pz = A.z + dz * t;
    const d = Math.hypot(px - x, pz - z);
    if (d <= bestD) {
      bestD = d;
      best = [px, y, pz];
    }
  }
  return best;
}
