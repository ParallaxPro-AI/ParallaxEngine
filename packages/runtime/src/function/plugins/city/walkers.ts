/**
 * Pedestrians on the sidewalk graph: the walking line along every sidewalk (mid-sidewalk,
 * welded where blocks meet) plus a crosswalk across each street at every junction of three
 * or more streets. Walkers are the game's prefabs carrying `city_walker`:
 *
 *   - spawned on a random sidewalk between `spawn_min` and `radius` of a streaming source,
 *     kept at `count` within `radius`, removed past radius·1.25;
 *   - they keep a little right of the line (each its own offset), turn at random at corners
 *     (crossing a street a third of the time), and wait at the curb until the crossing is
 *     safe: a red light for the street they cross, else no car close on it; cars wait for
 *     anyone on a crosswalk;
 *   - an alarm (`ctx.city.alarm(point, radius)`: gunfire, a crash) sends walkers in reach
 *     running away from it, along the sidewalks, for its duration;
 *   - a walker with a `nav_agent` walks through the nav plugin (avoiding others and
 *     obstacles) from waypoint to waypoint; any other moves kinematically on the line.
 *
 * Setting `city_walker.active = False` hands a walker to game code (a fight, a cutscene); the
 * city leaves it alone except for removing it once far away (unless `keep`).
 */

import { Quat, SeededRandom, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import type { Fields, Kernel } from '../../kernel/index.js';
import type { NavService } from '../../services/index.js';
import type { CityLayout, XZ } from './layout.js';
import type { LaneGraph } from './lanes.js';
import { untilGreen } from './lanes.js';
import type { CitySpec } from './spec.js';
import { nearest } from './traffic.js';

export const CITY_WALKER = 'city_walker';

export interface WalkNode {
  readonly id: number;
  readonly x: number;
  readonly z: number;
  readonly edges: number[];
}

export interface WalkEdge {
  readonly id: number;
  readonly a: number;
  readonly b: number;
  readonly length: number;
  /** A crosswalk across road `edge` at road `node`; null for a sidewalk. */
  readonly crossing: { readonly node: number; readonly edge: number } | null;
}

export interface WalkGraph {
  readonly nodes: readonly WalkNode[];
  readonly edges: readonly WalkEdge[];
}

/** The sidewalk graph of a plan. Deterministic. */
export function buildWalkGraph(layout: CityLayout): WalkGraph {
  const nodes: WalkNode[] = [];
  const edges: WalkEdge[] = [];
  const grid = new Map<string, number[]>();
  const WELD = 1.2;
  const nodeAt = (p: XZ): number => {
    const gx = Math.floor(p[0] / WELD);
    const gz = Math.floor(p[1] / WELD);
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        for (const id of grid.get(`${gx + i},${gz + j}`) ?? []) {
          const n = nodes[id]!;
          if (Math.hypot(n.x - p[0], n.z - p[1]) < WELD) return id;
        }
      }
    }
    const id = nodes.length;
    nodes.push({ id, x: p[0], z: p[1], edges: [] });
    const key = `${gx},${gz}`;
    (grid.get(key) ?? grid.set(key, []).get(key)!).push(id);
    return id;
  };
  const seen = new Set<string>();
  const link = (a: number, b: number, crossing: WalkEdge['crossing']): void => {
    if (a === b) return;
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (seen.has(key)) return;
    seen.add(key);
    const A = nodes[a]!;
    const B = nodes[b]!;
    const id = edges.length;
    edges.push({ id, a, b, length: Math.hypot(B.x - A.x, B.z - A.z), crossing });
    A.edges.push(id);
    B.edges.push(id);
  };
  for (const cell of layout.cells) {
    for (let k = 0; k < 4; k++) {
      if (cell.sides[k]! < 0) continue;
      link(nodeAt(cell.walk[k]!), nodeAt(cell.walk[(k + 1) % 4]!), null);
    }
  }
  for (const node of layout.nodes) {
    if (node.edges.length < 3) continue;
    for (const e of node.edges) {
      const edge = layout.edges[e]!;
      if (edge.cells.length !== 2 || edge.bridge !== null) continue;
      const corners = edge.cells.map((c) => {
        const cell = layout.cells[c]!;
        const k = cell.sides.indexOf(e);
        const a = cell.walk[k]!;
        const b = cell.walk[(k + 1) % 4]!;
        return Math.hypot(a[0] - node.x, a[1] - node.z) <= Math.hypot(b[0] - node.x, b[1] - node.z) ? a : b;
      });
      const [p, q] = corners as [XZ, XZ];
      if (Math.hypot(p[0] - q[0], p[1] - q[1]) > 50) continue;
      link(nodeAt(p), nodeAt(q), { node: node.id, edge: e });
    }
  }
  return { nodes, edges };
}

export interface WalkerHost {
  readonly kernel: Kernel;
  readonly spec: CitySpec;
  readonly layout: CityLayout;
  readonly graph: LaneGraph;
  readonly walk: WalkGraph;
  readonly rng: SeededRandom;
  time(): number;
  sources(): readonly Vec3[];
  /** Cars on the junction's connectors from or to `edge`, or approaching it on `edge`. */
  trafficOn(node: number, edge: number): boolean;
  nav(): NavService | undefined;
}

const CROSS_RAMP = 1.2;

export class Walkers {
  readonly #h: WalkerHost;
  readonly #sidewalks: number[];
  readonly #total: number;
  /** `${node}:${edge}` of crosswalks someone is on this step. */
  readonly busy = new Set<string>();

  constructor(host: WalkerHost) {
    this.#h = host;
    this.#sidewalks = host.walk.edges.filter((e) => e.crossing === null && e.length > 2).map((e) => e.id);
    this.#total = this.#sidewalks.reduce((a, e) => a + host.walk.edges[e]!.length, 0);
  }

  /**
   * Whether a walker may step off the curb to cross `edge` at `node` (taking `seconds`): at a
   * signal, only while the street's light stays red long enough to get across ("don't walk"
   * starts flashing before the cars' green); anywhere, only with no car close.
   */
  #mayCross(node: number, edge: number, seconds: number): boolean {
    const h = this.#h;
    const g = h.graph;
    if (g.control.get(node) === 'signal') {
      const approach = g.approaches.find((a) => a.node === node && a.edge === edge);
      if (approach !== undefined) {
        const left = untilGreen(g, approach, h.time(), h.spec.traffic.signals);
        if (left !== Infinity && left < seconds + 1.5) return false;
      }
    }
    return !h.trafficOn(node, edge);
  }

  #crossTime(edge: WalkEdge, f: Fields): number {
    return edge.length / Math.max(0.3, f['speed'] as number);
  }

  /** Point and heading on an edge at s, with the walker's lateral offset (to the right of travel). */
  pointOn(edge: WalkEdge, forward: boolean, s: number, offset: number): { x: number; y: number; z: number; yaw: number } {
    const nodes = this.#h.walk.nodes;
    const A = nodes[forward ? edge.a : edge.b]!;
    const B = nodes[forward ? edge.b : edge.a]!;
    const t = edge.length > 0 ? Math.max(0, Math.min(1, s / edge.length)) : 0;
    const dx = (B.x - A.x) / (edge.length || 1);
    const dz = (B.z - A.z) / (edge.length || 1);
    const layout = this.#h.layout;
    let y = layout.ground + layout.curb;
    if (edge.crossing !== null) {
      const fromEnd = Math.min(s, edge.length - s);
      y = layout.ground + layout.curb * Math.max(0, 1 - fromEnd / CROSS_RAMP);
    }
    return { x: A.x + (B.x - A.x) * t + dz * offset, y, z: A.z + (B.z - A.z) * t - dx * offset, yaw: (Math.atan2(dx, dz) * 180) / Math.PI };
  }

  /** The next edge from the end node of the walker's edge. */
  #choose(f: Fields): void {
    const h = this.#h;
    const e = h.walk.edges[f['edge'] as number]!;
    const at = (f['forward'] as boolean) ? e.b : e.a;
    const node = h.walk.nodes[at]!;
    const options = node.edges.filter((id) => id !== e.id);
    if (options.length === 0) {
      f['forward'] = !(f['forward'] as boolean);
      f['s'] = 0;
      return;
    }
    let next: number;
    const flee = (f['flee'] as number) > 0;
    const danger = f['danger'] as Vec3 | null;
    if (flee && danger !== null) {
      // Away from the danger: the option whose far end is farthest from it (no crossings into it).
      next = options.reduce((best, id) => {
        const far = (edgeId: number): number => {
          const w = h.walk.edges[edgeId]!;
          const end = h.walk.nodes[w.a === at ? w.b : w.a]!;
          return Math.hypot(end.x - danger.x, end.z - danger.z);
        };
        return far(id) > far(best) ? id : best;
      }, options[0]!);
    } else {
      const weights = options.map((id) => (h.walk.edges[id]!.crossing === null ? 2 : 1));
      let r = h.rng.next() * weights.reduce((a, b) => a + b, 0);
      next = options[options.length - 1]!;
      for (let i = 0; i < options.length; i++) {
        r -= weights[i]!;
        if (r <= 0) {
          next = options[i]!;
          break;
        }
      }
    }
    const w = h.walk.edges[next]!;
    f['edge'] = next;
    f['forward'] = w.a === at;
    f['s'] = 0;
    f['sent'] = false;
  }

  step(dt: number): void {
    const h = this.#h;
    const k = h.kernel;
    this.busy.clear();
    const walkers = k.world.query([CITY_WALKER]);
    for (const [, f] of walkers) {
      if (f!['active'] !== true) continue;
      const e = h.walk.edges[f!['edge'] as number];
      if (e?.crossing !== null && e !== undefined && (f!['s'] as number) > 0.2) this.busy.add(`${e.crossing.node}:${e.crossing.edge}`);
    }
    const nav = h.nav();
    for (const [id, fields] of walkers) {
      const f = fields!;
      if (f['active'] !== true) continue;
      const record = k.world.get(id)!;
      if ((f['flee'] as number) > 0) f['flee'] = Math.max(0, (f['flee'] as number) - dt);
      let edge = h.walk.edges[f['edge'] as number];
      if (edge === undefined) {
        f['active'] = false;
        continue;
      }
      const fleeing = (f['flee'] as number) > 0;
      // Waiting at the curb for a crossing.
      if (edge.crossing !== null && (f['s'] as number) <= 0.01 && !fleeing && !this.#mayCross(edge.crossing.node, edge.crossing.edge, this.#crossTime(edge, f))) {
        f['wait'] = (f['wait'] as number) + dt;
        // Give up after a long wait and walk on along the block instead.
        if ((f['wait'] as number) > 40) {
          f['forward'] = !(f['forward'] as boolean);
          f['s'] = edge.length;
          this.#choose(f);
        }
        if (nav?.hasAgent(id) === true) nav.stopAgent(id);
        continue;
      }
      f['wait'] = 0;
      const speed = (f['speed'] as number) * (fleeing ? 3.2 : 1);
      if (nav !== undefined && nav.hasAgent(id)) {
        this.#navStep(id, f, edge, nav, speed);
        continue;
      }
      let s = (f['s'] as number) + speed * dt;
      for (let guard = 0; guard < 3 && s >= edge.length; guard++) {
        const over = s - edge.length;
        this.#choose(f);
        edge = h.walk.edges[f['edge'] as number]!;
        s = edge.crossing !== null && !fleeing && !this.#mayCross(edge.crossing.node, edge.crossing.edge, this.#crossTime(edge, f)) ? 0 : over;
      }
      f['s'] = s;
      const p = this.pointOn(edge, f['forward'] as boolean, s, f['offset'] as number);
      record.transform.position = new Vec3(p.x, p.y, p.z);
      record.transform.rotation = quatYaw(p.yaw);
    }
  }

  #navStep(id: EntityId, f: Fields, edge: WalkEdge, nav: NavService, speed: number): void {
    const record = this.#h.kernel.world.get(id)!;
    const agent = record.components.get('nav_agent');
    if (agent !== undefined) agent['speed'] = speed;
    const target = this.pointOn(edge, f['forward'] as boolean, edge.length, f['offset'] as number);
    const here = record.transform.worldPosition();
    const close = Math.hypot(here.x - target.x, here.z - target.z) < 1.2;
    if (close || (f['sent'] === true && !nav.agentMoving(id))) {
      this.#choose(f);
      const next = this.#h.walk.edges[f['edge'] as number]!;
      if (next.crossing !== null && (f['flee'] as number) <= 0 && !this.#mayCross(next.crossing.node, next.crossing.edge, this.#crossTime(next, f))) return;
      const goal = this.pointOn(next, f['forward'] as boolean, next.length, f['offset'] as number);
      nav.moveAgent(id, new Vec3(goal.x, goal.y, goal.z), { maxSpeed: speed });
      f['sent'] = true;
      return;
    }
    if (f['sent'] !== true) {
      nav.moveAgent(id, new Vec3(target.x, target.y, target.z), { maxSpeed: speed });
      f['sent'] = true;
    }
  }

  /** Send walkers within `radius` of `point` running from it for `seconds`. Returns how many. */
  alarm(point: Vec3, radius: number, seconds: number): number {
    let n = 0;
    for (const [id, f] of this.#h.kernel.world.query([CITY_WALKER])) {
      if (f!['active'] !== true) continue;
      const p = this.#h.kernel.world.get(id)!.transform.worldPosition();
      if (Math.hypot(p.x - point.x, p.z - point.z) > radius) continue;
      f!['flee'] = seconds;
      f!['danger'] = point;
      // Turn round if heading toward the danger.
      const e = this.#h.walk.edges[f!['edge'] as number]!;
      const ahead = this.pointOn(e, f!['forward'] as boolean, e.length, 0);
      if (Math.hypot(ahead.x - point.x, ahead.z - point.z) < Math.hypot(p.x - point.x, p.z - point.z)) {
        f!['forward'] = !(f!['forward'] as boolean);
        f!['s'] = Math.max(0, e.length - (f!['s'] as number));
        f!['sent'] = false;
      }
      n++;
    }
    return n;
  }

  populate(): void {
    const h = this.#h;
    const spec = h.spec.pedestrians;
    if (spec.count === 0 || this.#sidewalks.length === 0) return;
    const sources = h.sources();
    const k = h.kernel;
    let near = 0;
    for (const [id, f] of k.world.query([CITY_WALKER])) {
      const p = k.world.get(id)!.transform.worldPosition();
      const d = nearest(sources, p.x, p.z);
      if (d > spec.radius * 1.25 && f!['keep'] !== true) {
        k.destroy(id);
        continue;
      }
      if (f!['active'] === true && d <= spec.radius) near++;
    }
    if (near >= spec.count || sources.length === 0) return;
    for (let attempt = 0; attempt < 6; attempt++) {
      let r = h.rng.next() * this.#total;
      let i = 0;
      while (i < this.#sidewalks.length - 1 && r > h.walk.edges[this.#sidewalks[i]!]!.length) r -= h.walk.edges[this.#sidewalks[i++]!]!.length;
      const edge = h.walk.edges[this.#sidewalks[i]!]!;
      const forward = h.rng.next() < 0.5;
      const s = Math.max(0, Math.min(edge.length, r));
      const offset = 0.25 + h.rng.next() * 0.7;
      const p = this.pointOn(edge, forward, s, offset);
      const d = nearest(sources, p.x, p.z);
      if (d < spec.spawnMin || d > spec.radius) continue;
      const prefab = spec.prefabs[Math.floor(h.rng.next() * spec.prefabs.length)]!;
      k.spawn(prefab, { at: [p.x, p.y, p.z], rotation: [0, p.yaw, 0] }, {
        components: {
          [CITY_WALKER]: {
            active: true, edge: edge.id, forward, s, offset, speed: spec.speed * (0.8 + h.rng.next() * 0.4), wait: 0, flee: 0, danger: null, sent: false,
          },
        },
      });
      return;
    }
  }
}

function quatYaw(yaw: number): Quat {
  return Quat.from_euler(new Vec3(0, yaw, 0));
}
