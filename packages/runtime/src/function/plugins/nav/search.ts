/**
 * Paths over the layered nav grid: A* over (cell, layer) nodes, 8-connected on each layer
 * (no corner cutting, octile costs, deterministic tie-breaks), with three more kinds of
 * edge:
 *
 *   - steps between layers of neighbouring cells within STEP_HEIGHT (stairs, ramps — the
 *     same rule as walking on one layer, so a ramp up to a bridge deck simply walks);
 *   - automatic ledge links for agents that can jump or drop (`AgentShape.jump`/`drop`):
 *     where the neighbouring cell is not walkable, the cells straight ahead within the
 *     agent's diameter + LEDGE_REACH are scanned for a standable layer lower by at most
 *     `drop` ("drop": off a roof, a balcony), higher by at most `jump` ("jump": onto a
 *     crate, a ledge) or level across a gap ("jump": a chasm, a missing floor), with
 *     nothing higher in between and the arc clear of static geometry;
 *   - authored off-mesh links (links.ts: NavLink components, scene links): one edge each
 *     way they go, between the layers nearest their ends.
 *
 * Then string pulling — each waypoint is the farthest later node still in straight
 * walkable line on the same layers — so agents walk straight across open ground and turn
 * only at corners; links are never pulled across (a waypoint marks where each begins).
 * Searches are bounded (MAX_EXPANSIONS): beyond that a target counts as unreachable rather
 * than stalling the frame.
 */

import { AGENT_HEIGHT, cellKey, MAX_LAYERS, nodeKey, STEP_HEIGHT } from './world.js';
import type { Column, NavField, Point3 } from './world.js';

export const MAX_EXPANSIONS = 60_000;
/** Horizontal reach (m) beyond the agent's diameter an automatic jump or drop link may span. */
export const LEDGE_REACH = 1.5;
/** Extra cost (m) of a jump, drop or climb, so a walk that is not much longer wins. */
export const LINK_PENALTY = 1;
/** How far above or below its point a snapped end may land before nearer layers lose to any (m). */
const VERTICAL_SNAP = AGENT_HEIGHT;
const SQRT2 = Math.SQRT2;
const EPS = 1e-6;

/** How far a path end may snap to the nearest standable cell for an agent of `radius`. */
export function snapDistance(radius: number): number {
  return Math.max(1, 2 * radius);
}

export interface Cell {
  readonly i: number;
  readonly k: number;
}

/** A search node: a cell and one of its layers (an index into `columns(i, k)`). */
export interface Node extends Cell {
  readonly l: number;
}

/** The agent a search is for: its radius and how high it can jump up and drop down (m; 0: never). */
export interface AgentShape {
  readonly radius: number;
  readonly jump: number;
  readonly drop: number;
}

/** A link the path takes from one waypoint to the next. */
export interface LinkStep {
  /** "jump", "drop" (automatic or authored), "climb", "door", "teleport" or "custom". */
  readonly kind: string;
  /** The NavLink entity; -1 for automatic and scene links. */
  readonly entity: number;
}

/** A point on a path: y is null on the implicit ground plane (agents keep their height). */
export interface Waypoint {
  readonly x: number;
  readonly y: number | null;
  readonly z: number;
  /** Set when the way from this waypoint to the next is a link (not a walk). */
  readonly link?: LinkStep;
}

interface Via extends LinkStep {
  /** The authored link's exact ends (automatic links run between cell centers). */
  readonly from: { readonly x: number; readonly z: number } | null;
  readonly to: { readonly x: number; readonly z: number } | null;
}

interface Edge {
  readonly node: Node;
  readonly cost: number;
  readonly via?: Via;
}

interface PullPoint {
  readonly x: number;
  readonly z: number;
  readonly node: Node;
}

const NEIGHBORS: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

class Heap {
  readonly #items: Array<{ key: number; f: number; h: number }> = [];

  get size(): number { return this.#items.length; }

  #less(a: { key: number; f: number; h: number }, b: { key: number; f: number; h: number }): boolean {
    return a.f < b.f || (a.f === b.f && (a.h < b.h || (a.h === b.h && a.key < b.key)));
  }

  push(item: { key: number; f: number; h: number }): void {
    const items = this.#items;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.#less(items[i]!, items[parent]!)) break;
      [items[i], items[parent]] = [items[parent]!, items[i]!];
      i = parent;
    }
  }

  pop(): { key: number; f: number; h: number } {
    const items = this.#items;
    const top = items[0]!;
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let best = i;
        if (l < items.length && this.#less(items[l]!, items[best]!)) best = l;
        if (r < items.length && this.#less(items[r]!, items[best]!)) best = r;
        if (best === i) break;
        [items[i], items[best]] = [items[best]!, items[i]!];
        i = best;
      }
    }
    return top;
  }
}

function unpack(key: number): Node {
  const l = key % MAX_LAYERS;
  const cell = (key - l) / MAX_LAYERS;
  const k = (cell % 0x200000) - 0x100000;
  const i = Math.round((cell - (k + 0x100000)) / 0x200000) - 0x100000;
  return { i, k, l };
}

/** A walking agent of `radius` (no jumps, no drops). */
export function walker(radius: number): AgentShape {
  return { radius, jump: 0, drop: 0 };
}

const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

/** Most nodes one region flood visits before it settles for "too big to tell" (see `connected`). */
export const REGION_LIMIT = 200_000;

/** Walkable regions for one radius at a field version (`connected`). */
interface Regions {
  readonly version: number;
  /** Node key → the flood that reached it. */
  readonly of: Map<number, number>;
  /** Floods that ran out of nodes: whole regions. */
  readonly closed: Set<number>;
  /** Floods found to touch (the same region), union-find. */
  readonly parent: Map<number, number>;
  next: number;
}

/** Searches over a NavField: the live grid on the main thread, or a bake (jobs.ts) anywhere. */
export class Pathfinder {
  readonly grid: NavField;
  /** Authored link edges per radius, at the field version they were resolved. */
  readonly #linkEdges = new Map<number, { readonly version: number; readonly edges: Map<number, Edge[]> }>();
  /** Walker regions per radius. */
  readonly #regions = new Map<number, Regions>();

  constructor(grid: NavField) {
    this.grid = grid;
  }

  cellOf(x: number, z: number): Cell {
    return { i: this.grid.index(x), k: this.grid.index(z) };
  }

  /** The column of a node. */
  column(node: Node): Column {
    return this.grid.columns(node.i, node.k)[node.l]!;
  }

  /** The surface height a path point on `node` has: null on the implicit ground plane. */
  heightOf(node: Node): number | null {
    const column = this.column(node);
    return column.implicit ? null : column.h;
  }

  /** The standable layer of cell (i, k) an agent on `from` can step to (the nearest in height), or -1. */
  #stepLayer(i: number, k: number, from: Column, radius: number): number {
    const columns = this.grid.columns(i, k);
    let best = -1;
    let bestDh = Infinity;
    for (let l = 0; l < columns.length; l++) {
      const c = columns[l]!;
      if (!this.grid.step(from, c) || !this.grid.standable(i, k, l, radius)) continue;
      const dh = Math.abs(c.h - from.h);
      if (dh < bestDh) {
        best = l;
        bestDh = dh;
      }
    }
    return best;
  }

  /**
   * The layer of cell (i, k) an agent of `radius` standing on `from` can step onto (the
   * nearest in height), or with no `from` (off the grid) the standable layer nearest y; null
   * when there is none.
   */
  layerAt(i: number, k: number, from: Column | null, y: number, radius: number): Column | null {
    const columns = this.grid.columns(i, k);
    if (from !== null) {
      const l = this.#stepLayer(i, k, from, radius);
      return l < 0 ? null : columns[l]!;
    }
    let best: Column | null = null;
    for (let l = 0; l < columns.length; l++) {
      const c = columns[l]!;
      if (this.grid.standable(i, k, l, radius) && (best === null || Math.abs(c.h - y) < Math.abs(best.h - y))) best = c;
    }
    return best;
  }

  /** The layer of the adjacent cell (i, k) an agent of `radius` walks to from node a, or -1. */
  #walk(a: Node, from: Column, i: number, k: number, radius: number): number {
    const l = this.#stepLayer(i, k, from, radius);
    if (l < 0) return -1;
    if (i !== a.i && k !== a.k) {
      if (this.#stepLayer(i, a.k, from, radius) < 0 || this.#stepLayer(a.i, k, from, radius) < 0) return -1;
    }
    return l;
  }

  /** An automatic jump or drop link from node a straight along (di, dk), or null (see the header). */
  #ledge(a: Node, from: Column, di: number, dk: number, shape: AgentShape): Edge | null {
    const { radius, jump, drop } = shape;
    const cell = this.grid.cell;
    const steps = Math.ceil((2 * radius + LEDGE_REACH) / cell);
    let between = -Infinity;
    let level = false;
    for (let s = 2; s <= steps; s++) {
      const mid = this.grid.columns(a.i + di * (s - 1), a.k + dk * (s - 1));
      for (const c of mid) {
        between = Math.max(between, c.h);
        if (Math.abs(c.h - from.h) <= STEP_HEIGHT + EPS) level = true;
      }
      // Something in the way taller than any jump: nothing beyond is reachable this way.
      if (between > from.h + Math.max(jump, 0) + STEP_HEIGHT + EPS) return null;
      const i = a.i + di * s;
      const k = a.k + dk * s;
      const columns = this.grid.columns(i, k);
      let found: { l: number; kind: string; dh: number } | null = null;
      let walkable = false;
      for (let l = 0; l < columns.length; l++) {
        const c = columns[l]!;
        if (!this.grid.standable(i, k, l, radius)) continue;
        const dh = c.h - from.h;
        let kind: string | null = null;
        if (dh < -STEP_HEIGHT - EPS) kind = -dh <= drop + EPS ? 'drop' : null;
        else if (dh > STEP_HEIGHT + EPS) kind = dh <= jump + EPS ? 'jump' : null;
        else {
          walkable = true;
          // Level ground across a gap (nothing near this height in between).
          kind = jump > 0 && !level ? 'jump' : null;
        }
        if (kind === null || between > Math.max(from.h, c.h) + STEP_HEIGHT + EPS) continue;
        if (found === null || Math.abs(dh) < Math.abs(found.dh)) found = { l, kind, dh };
      }
      if (found !== null) {
        const to = columns[found.l]!;
        const y = Math.max(from.h, to.h) + AGENT_HEIGHT / 2;
        const ax = this.grid.center(a.i); const az = this.grid.center(a.k);
        const bx = this.grid.center(i); const bz = this.grid.center(k);
        if (!this.grid.passable({ x: ax, y, z: az }, { x: bx, y, z: bz })) return null;
        const run = s * (di !== 0 && dk !== 0 ? SQRT2 : 1);
        return {
          node: { i, k, l: found.l },
          cost: run + (Math.abs(found.dh) + LINK_PENALTY) / cell,
          via: { kind: found.kind, entity: -1, from: null, to: null },
        };
      }
      // The same level goes on here (the gap was only the agent's clearance): no ledge this way.
      if (walkable) return null;
    }
    return null;
  }

  /** Authored link edges for agents of `radius`, keyed by their start node. */
  #links(radius: number): Map<number, Edge[]> {
    const version = this.grid.version;
    const cached = this.#linkEdges.get(radius);
    if (cached !== undefined && cached.version === version) return cached.edges;
    const edges = new Map<number, Edge[]>();
    const snap = snapDistance(radius);
    const add = (from: Node, edge: Edge): void => {
      const key = nodeKey(from.i, from.k, from.l);
      const list = edges.get(key) ?? [];
      list.push(edge);
      edges.set(key, list);
    };
    for (const link of this.grid.links()) {
      const a = this.nearest(link.start.x, link.start.y, link.start.z, radius, snap);
      const b = this.nearest(link.end.x, link.end.y, link.end.z, radius, snap);
      if (a === null || b === null) continue;
      const length = link.kind === 'teleport' ? 0 : Math.hypot(link.end.x - link.start.x, link.end.y - link.start.y, link.end.z - link.start.z);
      const penalty = link.kind === 'door' || link.kind === 'teleport' || link.kind === 'stairs' ? 0 : LINK_PENALTY;
      const cost = (length + link.cost + penalty) / this.grid.cell;
      const start = { x: link.start.x, z: link.start.z };
      const end = { x: link.end.x, z: link.end.z };
      add(a, { node: b, cost, via: { kind: link.kind, entity: link.entity, from: start, to: end } });
      if (link.bidirectional) add(b, { node: a, cost, via: { kind: link.kind, entity: link.entity, from: end, to: start } });
    }
    this.#linkEdges.set(radius, { version, edges });
    return edges;
  }

  /** The node's outgoing edges for this agent. */
  #edges(node: Node, shape: AgentShape, links: Map<number, Edge[]>): Edge[] {
    const from = this.column(node);
    const out: Edge[] = [];
    for (const [di, dk] of NEIGHBORS) {
      const l = this.#walk(node, from, node.i + di, node.k + dk, shape.radius);
      if (l >= 0) {
        out.push({ node: { i: node.i + di, k: node.k + dk, l }, cost: di !== 0 && dk !== 0 ? SQRT2 : 1 });
        continue;
      }
      if (shape.jump > 0 || shape.drop > 0) {
        const ledge = this.#ledge(node, from, di, dk, shape);
        if (ledge !== null) out.push(ledge);
      }
    }
    const authored = links.get(nodeKey(node.i, node.k, node.l));
    if (authored !== undefined) out.push(...authored);
    return out;
  }

  /**
   * The standable node nearest (x, y, z) within `range` meters (rings outward): in each
   * cell the layer nearest y. A layer within VERTICAL_SNAP of y wins over any farther one
   * (a point on the second floor snaps to the second floor, not the ground below it); when
   * there is none within range, any standable layer does. Null when nothing is standable.
   */
  nearest(x: number, y: number, z: number, radius: number, range: number): Node | null {
    const c = this.cellOf(x, z);
    const rings = Math.ceil(range / this.grid.cell);
    for (const strict of [true, false]) {
      for (let ring = 0; ring <= rings; ring++) {
        let best: Node | null = null;
        let bestScore = Infinity;
        for (let di = -ring; di <= ring; di++) {
          for (let dk = -ring; dk <= ring; dk++) {
            if (Math.max(Math.abs(di), Math.abs(dk)) !== ring) continue;
            const i = c.i + di;
            const k = c.k + dk;
            const flat = ring === 0 ? 0 : Math.hypot(this.grid.center(i) - x, this.grid.center(k) - z);
            if (flat > range) continue;
            const columns = this.grid.columns(i, k);
            for (let l = 0; l < columns.length; l++) {
              if (!this.grid.standable(i, k, l, radius)) continue;
              const column = columns[l]!;
              const dy = column.implicit ? 0 : Math.abs(column.h - y);
              if (strict && dy > VERTICAL_SNAP) continue;
              const score = Math.hypot(flat, dy);
              if (score < bestScore) {
                best = { i, k, l };
                bestScore = score;
              }
            }
          }
        }
        if (best !== null) return best;
      }
    }
    return null;
  }

  /**
   * Nodes from start to goal (both included) with the link each step takes (undefined for a
   * walk), or null when unreachable within `limit` expansions.
   */
  search(start: Node, goal: Node, shape: AgentShape, limit = MAX_EXPANSIONS): { nodes: Node[]; via: Array<Via | undefined> } | null {
    const startKey = nodeKey(start.i, start.k, start.l);
    const goalKey = nodeKey(goal.i, goal.k, goal.l);
    if (startKey === goalKey) return { nodes: [start], via: [undefined] };
    const links = this.#links(shape.radius);
    const heuristic = (c: Cell): number => {
      const dx = Math.abs(c.i - goal.i);
      const dz = Math.abs(c.k - goal.k);
      return Math.max(dx, dz) + (SQRT2 - 1) * Math.min(dx, dz);
    };
    const g = new Map<number, number>([[startKey, 0]]);
    const came = new Map<number, number>();
    const vias = new Map<number, Via>();
    const closed = new Set<number>();
    const open = new Heap();
    open.push({ key: startKey, f: heuristic(start), h: heuristic(start) });
    let expansions = 0;
    while (open.size > 0) {
      const { key } = open.pop();
      if (closed.has(key)) continue;
      if (key === goalKey) {
        const nodes: Node[] = [];
        const via: Array<Via | undefined> = [];
        for (let at: number | undefined = key; at !== undefined; at = came.get(at)) {
          nodes.push(unpack(at));
          via.push(vias.get(at));
        }
        return { nodes: nodes.reverse(), via: via.reverse() };
      }
      closed.add(key);
      if (++expansions > limit) return null;
      const node = unpack(key);
      const base = g.get(key)!;
      for (const edge of this.#edges(node, shape, links)) {
        const nextKey = nodeKey(edge.node.i, edge.node.k, edge.node.l);
        if (closed.has(nextKey)) continue;
        const cost = base + edge.cost;
        if (cost >= (g.get(nextKey) ?? Infinity)) continue;
        g.set(nextKey, cost);
        came.set(nextKey, key);
        if (edge.via === undefined) vias.delete(nextKey);
        else vias.set(nextKey, edge.via);
        const h = heuristic(edge.node);
        open.push({ key: nextKey, f: cost + h, h });
      }
    }
    return null;
  }

  /**
   * Whether a walker can get from `a` to `b`, by walkable regions: every node a flood from
   * a node reaches (walk steps and two-way links, both symmetric) is labelled, once per
   * field version. True when they share a region, false when either's region is whole
   * (its flood ran out) and doesn't hold the other — an island (the top of a wall, a crate)
   * or the far side of a closed wall, told without a search that floods everything in
   * reach. Null when it can't say: a region bigger than `limit` nodes, an agent that jumps
   * or drops (ledge links are one-way), or one-way authored links.
   */
  connected(a: Node, b: Node, shape: AgentShape, limit = REGION_LIMIT): boolean | null {
    if (shape.jump > 0 || shape.drop > 0) return null;
    if (this.grid.links().some((l) => !l.bidirectional)) return null;
    const version = this.grid.version;
    let r = this.#regions.get(shape.radius);
    if (r === undefined || r.version !== version) {
      r = { version, of: new Map(), closed: new Set(), parent: new Map(), next: 0 };
      this.#regions.set(shape.radius, r);
    }
    const ra = this.#find(r, this.#region(a, shape, r, limit));
    const rb = this.#find(r, this.#region(b, shape, r, limit));
    if (ra === rb) return true;
    return r.closed.has(ra) || r.closed.has(rb) ? false : null;
  }

  #find(r: Regions, id: number): number {
    let root = id;
    while (r.parent.get(root) !== undefined) root = r.parent.get(root)!;
    if (root !== id) r.parent.set(id, root);
    return root;
  }

  /** The flood label of a node, flooding its region first if no flood reached it yet. */
  #region(node: Node, shape: AgentShape, r: Regions, limit: number): number {
    const start = nodeKey(node.i, node.k, node.l);
    const known = r.of.get(start);
    if (known !== undefined) return known;
    const id = r.next++;
    const links = this.#links(shape.radius);
    r.of.set(start, id);
    const queue = [start];
    let visited = 0;
    let whole = true;
    while (queue.length > 0) {
      if (++visited > limit) {
        whole = false;
        break;
      }
      // Four neighbours are enough: a diagonal step needs both of its sides walkable (#walk).
      const node = unpack(queue.pop()!);
      const from = this.column(node);
      const next: Node[] = [];
      for (const [di, dk] of SIDES) {
        const l = this.#stepLayer(node.i + di, node.k + dk, from, shape.radius);
        if (l >= 0) next.push({ i: node.i + di, k: node.k + dk, l });
      }
      for (const edge of links.get(nodeKey(node.i, node.k, node.l)) ?? []) next.push(edge.node);
      for (const n of next) {
        const key = nodeKey(n.i, n.k, n.l);
        const other = r.of.get(key);
        if (other === undefined) {
          r.of.set(key, id);
          queue.push(key);
        } else if (other !== id) {
          // An earlier flood that stopped short (a whole one would have reached this node's
          // start): the same region, which nobody has now seen whole.
          const a = this.#find(r, other);
          const b = this.#find(r, id);
          if (a !== b) r.parent.set(a, b);
          whole = false;
        }
      }
    }
    if (whole) r.closed.add(id);
    return id;
  }

  /** Nodes from start to goal (both included), or null when unreachable within `limit` expansions. */
  cells(start: Node, goal: Node, shape: AgentShape, limit = MAX_EXPANSIONS): Node[] | null {
    return this.search(start, goal, shape, limit)?.nodes ?? null;
  }

  /** Whether a straight walk from a (on its node's layer) to b stays on standable, steppable layers and ends on b's. */
  straight(a: PullPoint, b: PullPoint, radius: number): boolean {
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    const samples = Math.max(1, Math.ceil(length / (this.grid.cell * 0.5)));
    let previous: Node = a.node;
    if (!this.grid.standable(previous.i, previous.k, previous.l, radius)) return false;
    let previousColumn = this.column(previous);
    for (let s = 1; s <= samples; s++) {
      const t = s / samples;
      const cell = this.cellOf(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
      if (cell.i === previous.i && cell.k === previous.k) continue;
      if (Math.abs(cell.i - previous.i) > 1 || Math.abs(cell.k - previous.k) > 1) return false;
      const l = this.#walk(previous, previousColumn, cell.i, cell.k, radius);
      if (l < 0) return false;
      previous = { i: cell.i, k: cell.k, l };
      previousColumn = this.column(previous);
    }
    return previous.i === b.node.i && previous.k === b.node.k && previous.l === b.node.l;
  }

  #pull(points: readonly PullPoint[], radius: number): PullPoint[] {
    const pulled = [points[0]!];
    let anchor = 0;
    while (anchor < points.length - 1) {
      let next = anchor + 1;
      for (let j = anchor + 2; j < points.length; j++) {
        if (this.straight(points[anchor]!, points[j]!, radius)) next = j;
        else break;
      }
      pulled.push(points[next]!);
      anchor = next;
    }
    return pulled;
  }

  /**
   * A string-pulled path from start to goal: the start, corners, link ends, the goal. Both
   * ends snap to the nearest standable node within `snap` meters (nearest in height too);
   * null when there is none or no route. The goal point is kept when it is in its snapped
   * cell, else that cell's center.
   */
  route(start: Point3, goal: Point3, shape: AgentShape, snap: number, limit = MAX_EXPANSIONS): Waypoint[] | null {
    const from = this.nearest(start.x, start.y, start.z, shape.radius, snap);
    const to = this.nearest(goal.x, goal.y, goal.z, shape.radius, snap);
    if (from === null || to === null) return null;
    const found = this.search(from, to, shape, limit);
    if (found === null) return null;
    const { nodes, via } = found;
    const at = (p: Point3, node: Node): { x: number; z: number } => {
      const c = this.cellOf(p.x, p.z);
      return c.i === node.i && c.k === node.k ? { x: p.x, z: p.z } : { x: this.grid.center(node.i), z: this.grid.center(node.k) };
    };
    const points: PullPoint[] = nodes.map((node) => ({ x: this.grid.center(node.i), z: this.grid.center(node.k), node }));
    points[0] = { ...at(start, from), node: from };
    points[points.length - 1] = { ...at(goal, to), node: to };
    // Runs of walking between links; each run is pulled on its own.
    const out: Waypoint[] = [];
    let run: PullPoint[] = [points[0]!];
    const flush = (link: LinkStep | undefined): void => {
      const pulled = this.#pull(run, shape.radius);
      pulled.forEach((p, n) => {
        const y = this.heightOf(p.node);
        const last = n === pulled.length - 1;
        out.push(last && link !== undefined ? { x: p.x, y, z: p.z, link: { kind: link.kind, entity: link.entity } } : { x: p.x, y, z: p.z });
      });
    };
    for (let j = 1; j < points.length; j++) {
      const step = via[j];
      if (step === undefined) {
        run.push(points[j]!);
        continue;
      }
      const last = run[run.length - 1]!;
      if (step.from !== null && (step.from.x !== last.x || step.from.z !== last.z)) run.push({ ...step.from, node: points[j - 1]!.node });
      flush(step);
      // An authored link lands on its exact end, then walks on from the node's point.
      run = step.to === null ? [] : [{ ...step.to, node: points[j]!.node }];
      const p = points[j]!;
      if (run.length === 0 || run[0]!.x !== p.x || run[0]!.z !== p.z) run.push(p);
    }
    flush(undefined);
    return out;
  }
}
