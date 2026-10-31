/**
 * The driving network derived from the plan: lanes along every street (each way, from stop
 * line to stop line), connectors across intersections (straight, left, right; U-turns at
 * dead ends), which connectors cross or merge (conflicts), and signal phases.
 *
 * Lanes. A street with n lanes each way has n lanes on each side of its centerline (offset by
 * half the median on avenues), lane 0 innermost. Right-hand traffic keeps right of the
 * centerline (`drive: "left"` mirrors it). Lanes end `stopDistance` from a node: past the
 * crosswalk at a signalized or stop-controlled junction, almost at the node where a street
 * just bends.
 *
 * Turns. With one lane each way every turn leaves from it; with more, the innermost lane
 * turns left or goes straight, the outermost turns right or goes straight, middle lanes go
 * straight. A left turn arrives in the innermost lane, a right turn in the outermost.
 *
 * Signals. At a signalized node the approaches split into two axes (within 45 degrees of the
 * first approach, and the rest); each axis is green for half the cycle less yellow and
 * all-red. Every node's cycle starts at a seeded offset.
 */

import type { CityLayout, RoadEdge, RoadNode } from './layout.js';
import { edgeHeight } from './layout.js';
import { hash } from './noise.js';
import type { V3 } from './mesh.js';
import type { SignalSpec } from './spec.js';

export type Turn = 'straight' | 'left' | 'right' | 'uturn';
export type SignalState = 'green' | 'yellow' | 'red';

/** A polyline with cumulative distances (world space). */
export interface Path {
  readonly points: readonly V3[];
  readonly distances: readonly number[];
  readonly length: number;
}

export interface Lane {
  readonly id: number;
  readonly edge: number;
  /** Along the edge's a → b. */
  readonly forward: boolean;
  /** 0: innermost (next to the centerline). */
  readonly index: number;
  readonly from: number;
  readonly to: number;
  readonly path: Path;
  /** m/s. */
  readonly speed: number;
  /** Connectors leaving its end. */
  readonly out: number[];
  /** Connectors arriving at its start. */
  readonly in: number[];
  /** The approach its end belongs to (index into `approaches`). */
  approach: number;
}

export interface Connector {
  readonly id: number;
  readonly node: number;
  readonly from: number;
  readonly to: number;
  readonly turn: Turn;
  readonly path: Path;
  readonly conflicts: number[];
}

export interface Approach {
  readonly id: number;
  readonly node: number;
  readonly edge: number;
  readonly lanes: number[];
  /** 0 or 1 at signalized nodes, −1 elsewhere. */
  readonly phase: number;
  /** Where the stop line's curb end is (x, z): a signal pole stands there. */
  readonly curb: readonly [number, number];
  /** The street's centerline at the stop line (x, z). */
  readonly center: readonly [number, number];
  /** Unit direction of travel into the node (x, z). */
  readonly dir: readonly [number, number];
  /** Half the incoming carriageway (m), for the mast arm. */
  readonly reach: number;
  readonly y: number;
}

export interface LaneGraph {
  readonly lanes: readonly Lane[];
  readonly connectors: readonly Connector[];
  readonly approaches: readonly Approach[];
  /** Node id → its signal offset (s), for signalized nodes. */
  readonly signals: ReadonlyMap<number, { readonly offset: number; readonly phases: number }>;
  /** How each node is controlled: signals, an all-way stop, or nothing (a bend, a dead end). */
  readonly control: ReadonlyMap<number, 'signal' | 'stop' | 'none'>;
}

export function pathOf(points: readonly V3[]): Path {
  const distances = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    distances.push(distances[i - 1]! + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  }
  return { points, distances, length: distances[distances.length - 1]! };
}

/** The point and unit tangent at distance s (clamped). */
export function pathAt(path: Path, s: number): { x: number; y: number; z: number; tx: number; ty: number; tz: number } {
  const d = Math.max(0, Math.min(path.length, s));
  let i = 1;
  while (i < path.points.length - 1 && path.distances[i]! < d) i++;
  const a = path.points[i - 1]!;
  const b = path.points[i]!;
  const seg = path.distances[i]! - path.distances[i - 1]!;
  const t = seg > 0 ? (d - path.distances[i - 1]!) / seg : 0;
  const l = seg > 0 ? seg : 1;
  return {
    x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, z: a[2] + (b[2] - a[2]) * t,
    tx: (b[0] - a[0]) / l, ty: (b[1] - a[1]) / l, tz: (b[2] - a[2]) / l,
  };
}

/** Distance along the path of the point nearest (x, z), searched near `hint`. */
export function pathProject(path: Path, x: number, z: number): { s: number; lateral: number } {
  let best = { s: 0, d: Infinity, lateral: 0 };
  for (let i = 1; i < path.points.length; i++) {
    const a = path.points[i - 1]!;
    const b = path.points[i]!;
    const dx = b[0] - a[0];
    const dz = b[2] - a[2];
    const l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[2]) * dz) / l2)) : 0;
    const px = a[0] + dx * t;
    const pz = a[2] + dz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < best.d) {
      const l = Math.sqrt(l2) || 1;
      // Right of travel is (dz, -dx): positive lateral is right of the lane.
      best = { s: path.distances[i - 1]! + (path.distances[i]! - path.distances[i - 1]!) * t, d, lateral: ((x - px) * dz - (z - pz) * dx) / l };
    }
  }
  return { s: best.s, lateral: best.lateral };
}

/** Where crossings sit at a node, measured from it along an edge: past the crossing street's curb and half the sidewalk. */
export function crossDistance(layout: CityLayout, edge: RoadEdge, node: RoadNode): number {
  let reach = 0;
  for (const e of node.edges) if (e !== edge.id) reach = Math.max(reach, layout.edges[e]!.halfWidth);
  return reach + layout.sidewalk * 0.5;
}

/** Where lanes end before a node. */
export function stopDistance(layout: CityLayout, edge: RoadEdge, node: RoadNode): number {
  const degree = node.edges.length;
  if (degree >= 3) return crossDistance(layout, edge, node) + layout.sidewalk * 0.5 + 1.8;
  if (degree === 2) return Math.min(edge.length * 0.2, 2 + edge.halfWidth * 0.4);
  return Math.min(edge.length * 0.25, 7);
}

const unit = (x: number, z: number): [number, number] => {
  const l = Math.hypot(x, z) || 1;
  return [x / l, z / l];
};

function bezier(p0: V3, c0: V3, c1: V3, p1: V3, steps: number): V3[] {
  const out: V3[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const w0 = u * u * u;
    const w1 = 3 * u * u * t;
    const w2 = 3 * u * t * t;
    const w3 = t * t * t;
    out.push([
      p0[0] * w0 + c0[0] * w1 + c1[0] * w2 + p1[0] * w3,
      p0[1] * w0 + c0[1] * w1 + c1[1] * w2 + p1[1] * w3,
      p0[2] * w0 + c0[2] * w1 + c1[2] * w2 + p1[2] * w3,
    ]);
  }
  return out;
}

function segmentsCross(a: Path, b: Path): boolean {
  // Interior crossings only: shared endpoints (same start lane, same target) don't count here.
  for (let i = 1; i < a.points.length; i++) {
    const p = a.points[i - 1]!;
    const q = a.points[i]!;
    for (let j = 1; j < b.points.length; j++) {
      const r = b.points[j - 1]!;
      const s = b.points[j]!;
      const d = (q[0] - p[0]) * (s[2] - r[2]) - (q[2] - p[2]) * (s[0] - r[0]);
      if (Math.abs(d) < 1e-9) continue;
      const t = ((r[0] - p[0]) * (s[2] - r[2]) - (r[2] - p[2]) * (s[0] - r[0])) / d;
      const u = ((r[0] - p[0]) * (q[2] - p[2]) - (r[2] - p[2]) * (q[0] - p[0])) / d;
      if (t > 0.02 && t < 0.98 && u > 0.02 && u < 0.98) return true;
    }
  }
  return false;
}

/** Build the lane graph of a plan. Deterministic. */
export function buildLanes(layout: CityLayout, opts: { readonly drive: 'right' | 'left'; readonly speed: number; readonly seed: number; readonly signals: SignalSpec }): LaneGraph {
  const lanes: Lane[] = [];
  const side = opts.drive === 'right' ? 1 : -1;
  /** Lanes of an edge heading into each of its nodes: key `${edge}:${node}`. */
  const into = new Map<string, number[]>();
  const outOf = new Map<string, number[]>();
  for (const edge of layout.edges) {
    const A = layout.nodes[edge.a]!;
    const B = layout.nodes[edge.b]!;
    const [dx, dz] = unit(B.x - A.x, B.z - A.z);
    const median = edge.major && edge.lanes >= 2 ? 0.6 : 0;
    const trimA = stopDistance(layout, edge, A);
    const trimB = stopDistance(layout, edge, B);
    const speed = opts.speed * (edge.major ? 1.25 : 1) * (edge.bridge !== null ? 1.15 : 1);
    for (const forward of [true, false]) {
      for (let i = 0; i < edge.lanes; i++) {
        const offset = (median / 2 + (i + 0.5) * layout.laneWidth) * side;
        // Right of the edge's a → b is (dz, -dx); backward lanes sit on its other side.
        const ox = dz * offset * (forward ? 1 : -1);
        const oz = -dx * offset * (forward ? 1 : -1);
        const s0 = forward ? trimA : edge.length - trimB;
        const s1 = forward ? edge.length - trimB : trimA;
        const n = edge.bridge === null ? 1 : Math.max(2, Math.ceil(Math.abs(s1 - s0) / 6));
        const points: V3[] = [];
        for (let k = 0; k <= n; k++) {
          const s = s0 + ((s1 - s0) * k) / n;
          points.push([A.x + dx * s + ox, edgeHeight(layout, edge, s), A.z + dz * s + oz]);
        }
        const id = lanes.length;
        lanes.push({
          id, edge: edge.id, forward, index: i, from: forward ? edge.a : edge.b, to: forward ? edge.b : edge.a, path: pathOf(points), speed,
          out: [], in: [], approach: -1,
        });
        const end = forward ? edge.b : edge.a;
        const start = forward ? edge.a : edge.b;
        (into.get(`${edge.id}:${end}`) ?? into.set(`${edge.id}:${end}`, []).get(`${edge.id}:${end}`)!).push(id);
        (outOf.get(`${edge.id}:${start}`) ?? outOf.set(`${edge.id}:${start}`, []).get(`${edge.id}:${start}`)!).push(id);
      }
    }
  }

  const connectors: Connector[] = [];
  const approaches: Approach[] = [];
  const signals = new Map<number, { offset: number; phases: number }>();
  const control = new Map<number, 'signal' | 'stop' | 'none'>();
  for (const node of layout.nodes) {
    if (node.edges.length === 0) continue;
    const degree = node.edges.length;
    control.set(node.id, node.signal ? 'signal' : degree >= 3 ? 'stop' : 'none');
    // Incoming approach direction per edge (into the node).
    const dirInto = (e: RoadEdge): [number, number] => {
      const other = layout.nodes[e.a === node.id ? e.b : e.a]!;
      return unit(node.x - other.x, node.z - other.z);
    };
    let axis: [number, number] | null = null;
    const nodeConnectors: number[] = [];
    for (const e of node.edges) {
      const edge = layout.edges[e]!;
      const incoming = into.get(`${e}:${node.id}`) ?? [];
      if (incoming.length === 0) continue;
      const d = dirInto(edge);
      let phase = -1;
      if (node.signal) {
        if (axis === null) axis = d;
        phase = Math.abs(d[0] * axis[0] + d[1] * axis[1]) >= Math.SQRT1_2 ? 0 : 1;
      }
      // The stop line's curb end: right of travel (left with left-hand traffic), half the road out.
      const last = lanes[incoming[0]!]!.path;
      const end = last.points[last.points.length - 1]!;
      const along = stopDistance(layout, edge, node);
      const rx = d[1] * side;
      const rz = -d[0] * side;
      const reach = edge.halfWidth;
      const approach: Approach = {
        id: approaches.length, node: node.id, edge: e, lanes: incoming, phase,
        curb: [node.x - d[0] * along + rx * (reach + 0.5), node.z - d[1] * along + rz * (reach + 0.5)],
        center: [node.x - d[0] * along, node.z - d[1] * along], dir: d, reach, y: end[1],
      };
      approaches.push(approach);
      for (const l of incoming) lanes[l]!.approach = approach.id;

      for (const laneId of incoming) {
        const lane = lanes[laneId]!;
        const p0 = lane.path.points[lane.path.points.length - 1]!;
        for (const o of node.edges) {
          const isSame = o === e;
          if (isSame && degree > 1) continue;
          const oEdge = layout.edges[o]!;
          const outgoing = outOf.get(`${o}:${node.id}`) ?? [];
          if (outgoing.length === 0) continue;
          const dOut = (() => {
            const other = layout.nodes[oEdge.a === node.id ? oEdge.b : oEdge.a]!;
            return unit(other.x - node.x, other.z - node.z);
          })();
          const cross = d[0] * dOut[1] - d[1] * dOut[0];
          const dot = d[0] * dOut[0] + d[1] * dOut[1];
          // Right of d is (d.z, −d.x): a right turn heads that way (cross < 0 in x/z).
          const turn: Turn = isSame ? 'uturn' : degree === 2 || dot > Math.cos((35 * Math.PI) / 180) ? 'straight' : cross < 0 ? 'right' : 'left';
          const n = edge.lanes;
          // The near turn (right with right-hand traffic) leaves from the outermost lane, the far one from the innermost.
          const nearTurn: Turn = opts.drive === 'right' ? 'right' : 'left';
          const allowed = turn === 'straight' || turn === 'uturn' || n === 1 || (turn === nearTurn ? lane.index === n - 1 : lane.index === 0);
          if (!allowed) continue;
          // Straight keeps the lane index (the outermost lane also fans out onto a wider street's extra
          // lanes); the near turn arrives outermost, the far turn innermost.
          const targets = turn === 'straight'
            ? (lane.index === n - 1 ? Array.from({ length: Math.max(1, oEdge.lanes - lane.index) }, (_, i) => Math.min(lane.index + i, oEdge.lanes - 1)) : [Math.min(lane.index, oEdge.lanes - 1)])
            : [turn === 'uturn' ? 0 : turn === nearTurn ? oEdge.lanes - 1 : 0];
          for (const target of targets) {
            const toLane = outgoing.find((l) => lanes[l]!.index === target) ?? outgoing[0]!;
            const p1 = lanes[toLane]!.path.points[0]!;
            const gap = Math.hypot(p1[0] - p0[0], p1[2] - p0[2]);
            const k = turn === 'uturn' ? Math.max(4, gap) : gap * 0.45;
            const c0: V3 = [p0[0] + d[0] * k, p0[1], p0[2] + d[1] * k];
            const c1: V3 = [p1[0] - dOut[0] * k, p1[1], p1[2] - dOut[1] * k];
            const id = connectors.length;
            connectors.push({ id, node: node.id, from: laneId, to: toLane, turn, path: pathOf(bezier(p0, c0, c1, p1, turn === 'straight' ? 4 : 8)), conflicts: [] });
            lane.out.push(id);
            lanes[toLane]!.in.push(id);
            nodeConnectors.push(id);
          }
        }
      }
    }
    if (node.signal) {
      const phases = new Set(approaches.filter((a) => a.node === node.id).map((a) => a.phase)).size;
      signals.set(node.id, { offset: hash(opts.seed, 0x7367, node.id) * opts.signals.cycle, phases: Math.max(1, phases) });
    }
    for (const a of nodeConnectors) {
      for (const b of nodeConnectors) {
        if (a >= b) continue;
        const ca = connectors[a]!;
        const cb = connectors[b]!;
        if (ca.from === cb.from) continue;
        if (ca.to === cb.to || segmentsCross(ca.path, cb.path)) {
          ca.conflicts.push(b);
          cb.conflicts.push(a);
        }
      }
    }
  }
  return { lanes, connectors, approaches, signals, control };
}

/** The light an approach shows at time t (s). Non-signalized approaches are always "green" (stop rules apply instead). */
export function signalState(graph: LaneGraph, approach: Approach, t: number, spec: SignalSpec): SignalState {
  const signal = graph.signals.get(approach.node);
  if (signal === undefined || approach.phase < 0) return 'green';
  const phases = signal.phases;
  if (phases < 2) return 'green';
  const slot = spec.cycle / phases;
  const local = (((t + signal.offset) % spec.cycle) + spec.cycle) % spec.cycle;
  const current = Math.floor(local / slot);
  if (current !== approach.phase) return 'red';
  const within = local - current * slot;
  const green = slot - spec.yellow - spec.allRed;
  return within < green ? 'green' : within < green + spec.yellow ? 'yellow' : 'red';
}

/** Seconds until an approach next turns green (0 while green or yellow; Infinity for unsignalized ones). */
export function untilGreen(graph: LaneGraph, approach: Approach, t: number, spec: SignalSpec): number {
  const signal = graph.signals.get(approach.node);
  if (signal === undefined || approach.phase < 0 || signal.phases < 2) return Infinity;
  if (signalState(graph, approach, t, spec) !== 'red') return 0;
  const slot = spec.cycle / signal.phases;
  const local = (((t + signal.offset) % spec.cycle) + spec.cycle) % spec.cycle;
  return (((approach.phase * slot - local) % spec.cycle) + spec.cycle) % spec.cycle;
}
