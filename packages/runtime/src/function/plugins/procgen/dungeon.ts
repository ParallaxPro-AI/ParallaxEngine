/**
 * Dungeons: mission graph → layout → tiles → geometry, all from one seed.
 *
 * Mission. Rooms form a tree rooted at the entrance, split into `locks + 1` regions in
 * order. Region 0 holds the entrance; every later region is entered through one locked
 * door (lock k between a room of region k - 1 and the first room of region k), and the key
 * to lock k lies in region k - 1, in a room other than its door's room when the region has
 * one. The objective room hangs off the last region. `treasures` leaf rooms off the
 * critical path (entrance → objective) become treasure rooms. `loops` extra unlocked
 * corridors join rooms of the same region (cycles, never across a lock).
 *
 * Layout. Rooms sit on a lattice of square slots (room_size max + 4 tiles wide). Each
 * room takes a free slot beside its parent (seeded direction order); when the parent is
 * boxed in, it moves to the nearest room of the same region (for a locked room, of the
 * region before the lock) with a free side — the mission's regions and locks are kept,
 * only the tree's shape changes. Keys and treasures are placed on the final tree. Every
 * corridor joins two neighbouring slots of one mission edge (or loop), so corridors
 * never meet except inside rooms the mission joins: locks can't be bypassed. Each room
 * is a rectangle of room_size tiles inside its slot covering the slot center.
 *
 * Tiles. Floor tiles are rooms and corridors (`corridor` tiles wide); every void tile
 * touching a floor tile (8-neighbourhood) is wall. A door is the corridor tile where a
 * corridor leaves a room, facing out of the room. Geometry is boxes over merged tile
 * rectangles: floor slabs (top at y = 0), walls `wall_height` tall, and a ceiling slab
 * over the floor when `ceiling`. The tile grid is centered on the entity; tile (i, j)
 * spans x ∈ [x0 + i·tile, …), z ∈ [z0 + j·tile, …).
 */

import { fail, SeededRandom } from '../../../core/index.js';
import { MeshBuilder } from './mesh.js';
import type { V3 } from './mesh.js';
import { rectangles } from './structure.js';

export interface DungeonSpec {
  readonly seed: number;
  readonly rooms: number;
  readonly locks: number;
  readonly treasures: number;
  readonly loops: number;
  /** Room side in tiles, [min, max]. */
  readonly roomSize: readonly [number, number];
  readonly corridor: number;
  /** Meters per tile. */
  readonly tile: number;
  readonly wallHeight: number;
  readonly ceiling: boolean;
}

export type RoomRole = 'entrance' | 'room' | 'key' | 'objective' | 'treasure';

export interface DungeonRoom {
  readonly id: number;
  readonly role: RoomRole;
  readonly region: number;
  readonly parent: number | null;
  /** Lock index whose key lies here (role "key"), else null. */
  readonly key: number | null;
  /** Tile rectangle [i0, j0, i1, j1). */
  readonly rect: readonly [number, number, number, number];
  /** Local floor point at the room's center. */
  readonly center: V3;
  /** On the entrance → objective path. */
  readonly critical: boolean;
}

export interface DungeonDoor {
  /** The corridor tile on the path's center line, just outside the room. */
  readonly tile: readonly [number, number];
  /** Every tile across the corridor there (`corridor` of them): what a locked door closes. */
  readonly span: readonly (readonly [number, number])[];
  readonly position: V3;
  /** Degrees about +y, facing out of `room` into the corridor. */
  readonly yaw: number;
  readonly room: number;
  /** The room at the corridor's other end. */
  readonly to: number;
  /** Lock index, or null for an open doorway. */
  readonly lock: number | null;
}

export interface DungeonLayout {
  readonly rooms: readonly DungeonRoom[];
  readonly doors: readonly DungeonDoor[];
  /** Edges actually built: [a, b, lock | null]. */
  readonly edges: readonly (readonly [number, number, number | null])[];
  readonly width: number;
  readonly depth: number;
  /** Per tile: 0 void, 1 room floor, 2 corridor floor, 3 wall. `[j * width + i]`. */
  readonly tiles: Uint8Array;
  /** Local position of tile (0, 0)'s corner. */
  readonly origin: readonly [number, number];
}

export const VOID = 0;
export const ROOM_FLOOR = 1;
export const CORRIDOR_FLOOR = 2;
export const WALL = 3;

export function dungeonProblem(spec: DungeonSpec): string | undefined {
  const int = (v: number): boolean => Number.isInteger(v);
  if (!int(spec.rooms) || spec.rooms < 3 || spec.rooms > 200) return 'rooms must be a whole number from 3 to 200';
  if (!int(spec.locks) || spec.locks < 0) return 'locks must be a whole number >= 0';
  // Each region needs a room, plus the entrance and the objective.
  if (spec.locks + 3 > spec.rooms) return `${spec.locks} locks need at least ${spec.locks + 3} rooms (one per region, the entrance and the objective)`;
  if (!int(spec.treasures) || spec.treasures < 0) return 'treasures must be a whole number >= 0';
  if (!int(spec.loops) || spec.loops < 0) return 'loops must be a whole number >= 0';
  const [lo, hi] = spec.roomSize;
  if (!int(lo) || !int(hi) || lo < 3 || hi < lo || hi > 64) return 'room_size must be [min, max] whole tiles, 3 <= min <= max <= 64';
  if (!int(spec.corridor) || spec.corridor < 1 || spec.corridor > lo - 2) return `corridor must be a whole number of tiles from 1 to room_size min - 2 (${lo - 2})`;
  if (!(spec.tile > 0)) return 'tile must be greater than 0';
  if (!(spec.wallHeight > 0)) return 'wall_height must be greater than 0';
  return undefined;
}

interface MissionNode {
  id: number;
  region: number;
  parent: number | null;
  /** Lock on the edge from the parent. */
  lock: number | null;
  role: RoomRole;
  key: number | null;
}

/** The mission tree (see the file comment). */
function mission(spec: DungeonSpec, rng: SeededRandom): MissionNode[] {
  const regions = spec.locks + 1;
  // Rooms per region besides the entrance and the objective: at least one each, the rest spread by roll.
  const middle = spec.rooms - 2;
  const counts = new Array<number>(regions).fill(1);
  for (let k = 0; k < middle - regions; k++) counts[rng.int(0, regions - 1)]!++;
  const nodes: MissionNode[] = [{ id: 0, region: 0, parent: null, lock: null, role: 'entrance', key: null }];
  const byRegion: number[][] = [[0]];
  for (let r = 0; r < regions; r++) {
    const members = byRegion[r] ?? (byRegion[r] = []);
    // Region r > 0 starts with its gate room, behind lock r - 1 from a room of region r - 1.
    let first = 0;
    if (r > 0) {
      const from = pick(rng, byRegion[r - 1]!);
      const id = nodes.length;
      nodes.push({ id, region: r, parent: from, lock: r - 1, role: 'room', key: null });
      members.push(id);
      first = 1;
    }
    for (let k = first; k < counts[r]!; k++) {
      const id = nodes.length;
      nodes.push({ id, region: r, parent: pick(rng, members), lock: null, role: 'room', key: null });
      members.push(id);
    }
  }
  // Objective off the last region.
  const last = byRegion[regions - 1]!;
  nodes.push({ id: nodes.length, region: regions - 1, parent: pick(rng, last), lock: null, role: 'objective', key: null });
  return nodes;
}

/** Keys and treasures, on the final tree (layout may have moved parents within their region). */
function assignRoles(spec: DungeonSpec, nodes: MissionNode[], rng: SeededRandom): void {
  // Lock k's key in region k (the region before the lock), preferring a room other than the one the lock hangs off.
  for (let k = 0; k < spec.locks; k++) {
    const gate = nodes.find((n) => n.lock === k)!;
    const region = nodes.filter((n) => n.region === k && n.role !== 'objective');
    const candidates = region.filter((n) => n.id !== gate.parent && n.role === 'room' && n.key === null);
    const pool = candidates.length > 0 ? candidates : region.filter((n) => n.key === null);
    const node = pick(rng, pool);
    node.key = k;
    if (node.role === 'room') node.role = 'key';
  }
  const critical = criticalSet(nodes);
  const leaves = nodes.filter((n) => n.role === 'room' && !critical.has(n.id) && !nodes.some((m) => m.parent === n.id));
  for (let t = 0; t < spec.treasures && leaves.length > 0; t++) {
    const i = rng.int(0, leaves.length - 1);
    leaves[i]!.role = 'treasure';
    leaves.splice(i, 1);
  }
}

function pick<T>(rng: SeededRandom, list: readonly T[]): T {
  return list[rng.int(0, list.length - 1)]!;
}

function criticalSet(nodes: readonly MissionNode[]): Set<number> {
  const out = new Set<number>();
  let at: number | null = nodes.find((n) => n.role === 'objective')?.id ?? null;
  while (at !== null) {
    out.add(at);
    at = nodes[at]!.parent;
  }
  return out;
}

const DIRS: readonly (readonly [number, number])[] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** Generate the layout of a valid spec (check `dungeonProblem` first). Deterministic in the spec. */
export function layoutDungeon(spec: DungeonSpec): DungeonLayout {
  // Attempts reseed deterministically; a boxed-in region (every room of it surrounded) is the only failure.
  for (let attempt = 0; attempt < 16; attempt++) {
    const layout = attemptLayout(spec, new SeededRandom(Math.imul(spec.seed ^ 0x6d756e64, 0x9e3779b1) + attempt * 0x2545f491));
    if (layout !== undefined) return layout;
  }
  return fail('PP3662', `Dungeon (seed ${spec.seed}): no layout fits after 16 attempts`, {
    fix: 'Lower locks or rooms, or change the seed.',
  });
}

function attemptLayout(spec: DungeonSpec, rng: SeededRandom): DungeonLayout | undefined {
  const nodes = mission(spec, rng);
  const slotSize = spec.roomSize[1] + 4;
  // Slot occupancy: "sx,sz" → room id, or -1 for a corridor junction.
  const slots = new Map<string, number>();
  const slotOf: [number, number][] = [];
  const key = (x: number, z: number): string => `${x},${z}`;
  // Each built edge is a slot path from parent to child.
  const paths: { a: number; b: number; lock: number | null; slots: (readonly [number, number])[] }[] = [];
  slots.set(key(0, 0), 0);
  slotOf[0] = [0, 0];
  for (const node of nodes.slice(1)) {
    // A free slot beside the parent; if the parent is boxed in, beside the nearest room
    // (lattice distance, then id) that may also be the parent: same region (for a locked
    // room, the region before it).
    const allowed = node.lock !== null ? node.region - 1 : nodes[node.parent!]!.region;
    const [px, pz] = slotOf[node.parent!]!;
    const parents = nodes
      .filter((n) => n.id < node.id && slotOf[n.id] !== undefined && n.region === allowed && n.role !== 'objective')
      .sort((a, b) => {
        const da = Math.abs(slotOf[a.id]![0] - px) + Math.abs(slotOf[a.id]![1] - pz);
        const db = Math.abs(slotOf[b.id]![0] - px) + Math.abs(slotOf[b.id]![1] - pz);
        return (a.id === node.parent ? -1 : 0) - (b.id === node.parent ? -1 : 0) || da - db || a.id - b.id;
      });
    let placed: { parent: number; slot: [number, number] } | undefined;
    search: for (const parent of parents) {
      const [x, z] = slotOf[parent.id]!;
      for (const [dx, dz] of shuffled(rng, DIRS)) {
        if (!slots.has(key(x + dx, z + dz))) {
          placed = { parent: parent.id, slot: [x + dx, z + dz] };
          break search;
        }
      }
    }
    if (placed === undefined) return undefined;
    node.parent = placed.parent;
    slots.set(key(placed.slot[0], placed.slot[1]), node.id);
    slotOf[node.id] = placed.slot;
    paths.push({ a: placed.parent, b: node.id, lock: node.lock, slots: [slotOf[placed.parent]!, placed.slot] });
  }
  assignRoles(spec, nodes, rng);
  // Loops: same-region rooms in adjacent slots without an edge yet.
  if (spec.loops > 0) {
    const candidates: [number, number][] = [];
    for (const n of nodes) {
      const [x, z] = slotOf[n.id]!;
      for (const [dx, dz] of [[1, 0], [0, 1]] as const) {
        const other = slots.get(key(x + dx, z + dz));
        if (other === undefined || other < 0) continue;
        const m = nodes[other]!;
        if (m.region !== n.region || m.role === 'objective' || n.role === 'objective') continue;
        if (paths.some((p) => (p.a === n.id && p.b === m.id) || (p.a === m.id && p.b === n.id))) continue;
        candidates.push([n.id, m.id]);
      }
    }
    for (let k = 0; k < spec.loops && candidates.length > 0; k++) {
      const [a, b] = candidates.splice(rng.int(0, candidates.length - 1), 1)[0]!;
      paths.push({ a, b, lock: null, slots: [slotOf[a]!, slotOf[b]!] });
    }
  }

  // Room rectangles inside their slots (in slot-local tiles), covering the slot center.
  const [lo, hi] = spec.roomSize;
  const half = Math.floor(slotSize / 2);
  const local = nodes.map((n) => {
    const w = rng.int(lo, hi);
    const d = rng.int(lo, hi);
    // Offsets keep a 2-tile margin in the slot and the center tile inside the room.
    const i0 = rng.int(Math.max(2, half - w + 1), Math.min(slotSize - 2 - w, half));
    const j0 = rng.int(Math.max(2, half - d + 1), Math.min(slotSize - 2 - d, half));
    return { n, w, d, i0, j0 };
  });

  // Tile grid bounds.
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const k of slots.keys()) {
    const [x, z] = k.split(',').map(Number) as [number, number];
    minX = Math.min(minX, x);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxZ = Math.max(maxZ, z);
  }
  const width = (maxX - minX + 1) * slotSize;
  const depth = (maxZ - minZ + 1) * slotSize;
  const tiles = new Uint8Array(width * depth);
  const roomAt = new Int32Array(width * depth).fill(-1);
  const slotOrigin = (s: readonly [number, number]): [number, number] => [(s[0] - minX) * slotSize, (s[1] - minZ) * slotSize];
  const rects: [number, number, number, number][] = [];
  for (const { n, w, d, i0, j0 } of local) {
    const [ox, oz] = slotOrigin(slotOf[n.id]!);
    const rect: [number, number, number, number] = [ox + i0, oz + j0, ox + i0 + w, oz + j0 + d];
    rects[n.id] = rect;
    for (let j = rect[1]; j < rect[3]; j++) {
      for (let i = rect[0]; i < rect[2]; i++) {
        tiles[j * width + i] = ROOM_FLOOR;
        roomAt[j * width + i] = n.id;
      }
    }
  }
  // Corridors: center to center along each path, `corridor` tiles wide.
  const c = spec.corridor;
  const lowSide = Math.floor((c - 1) / 2);
  const carve = (i: number, j: number): void => {
    for (let dj = -lowSide; dj < c - lowSide; dj++) {
      for (let di = -lowSide; di < c - lowSide; di++) {
        const ii = i + di;
        const jj = j + dj;
        if (tiles[jj * width + ii] === VOID) tiles[jj * width + ii] = CORRIDOR_FLOOR;
      }
    }
  };
  const doors: DungeonDoor[] = [];
  const tileOrigin: [number, number] = [(-width * spec.tile) / 2, (-depth * spec.tile) / 2];
  const centerOfTile = (i: number, j: number): V3 => [tileOrigin[0] + (i + 0.5) * spec.tile, 0, tileOrigin[1] + (j + 0.5) * spec.tile];
  for (const path of paths) {
    const centers = path.slots.map((s) => {
      const [ox, oz] = slotOrigin(s);
      return [ox + half, oz + half] as [number, number];
    });
    for (let k = 0; k + 1 < centers.length; k++) {
      const [ai, aj] = centers[k]!;
      const [bi, bj] = centers[k + 1]!;
      const si = Math.sign(bi - ai);
      const sj = Math.sign(bj - aj);
      for (let i = ai, j = aj; ; i += si, j += sj) {
        carve(i, j);
        if (i === bi && j === bj) break;
      }
    }
    // Doors: walking out of each end room along the path, the first corridor tile.
    for (const [room, other, from, toward] of [[path.a, path.b, centers[0]!, centers[1]!], [path.b, path.a, centers[centers.length - 1]!, centers[centers.length - 2]!]] as const) {
      const si = Math.sign(toward[0] - from[0]);
      const sj = Math.sign(toward[1] - from[1]);
      let [i, j] = from;
      while (roomAt[j * width + i] === room) {
        i += si;
        j += sj;
      }
      const yaw = si > 0 ? 90 : si < 0 ? -90 : sj > 0 ? 0 : 180;
      const span: [number, number][] = [];
      for (let k = -lowSide; k < c - lowSide; k++) span.push([i + Math.abs(sj) * k, j + Math.abs(si) * k]);
      // The door's position is the middle of its span (even widths sit between two tiles).
      const mid = (c - 1) / 2 - lowSide;
      const at = centerOfTile(i + Math.abs(sj) * mid, j + Math.abs(si) * mid);
      doors.push({
        tile: [i, j], span, position: at, yaw, room, to: other,
        // The lock sits on the child's side (where the locked region begins).
        lock: path.lock !== null && room === path.b ? path.lock : null,
      });
    }
  }
  // Walls: void tiles touching floor.
  for (let j = 0; j < depth; j++) {
    for (let i = 0; i < width; i++) {
      if (tiles[j * width + i] !== VOID) continue;
      let touches = false;
      for (let dj = -1; dj <= 1 && !touches; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= width || jj >= depth) continue;
          const t = tiles[jj * width + ii]!;
          if (t === ROOM_FLOOR || t === CORRIDOR_FLOOR) {
            touches = true;
            break;
          }
        }
      }
      if (touches) tiles[j * width + i] = WALL;
    }
  }

  const critical = criticalSet(nodes);
  const rooms: DungeonRoom[] = nodes.map((n) => {
    const r = rects[n.id]!;
    return {
      id: n.id, role: n.role, region: n.region, parent: n.parent, key: n.key, rect: r, critical: critical.has(n.id),
      center: [tileOrigin[0] + ((r[0] + r[2]) / 2) * spec.tile, 0, tileOrigin[1] + ((r[1] + r[3]) / 2) * spec.tile],
    };
  });
  return {
    rooms, doors, edges: paths.map((p) => [p.a, p.b, p.lock] as const), width, depth, tiles, origin: tileOrigin,
  };
}

function shuffled<T>(rng: SeededRandom, list: readonly T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * Which rooms a player reaches from the entrance, collecting keys as they go (a locked
 * door opens once its key's room was reached). The tile flood treats locked door tiles as
 * walls until then. Returns the reached room ids in reach order.
 */
export function reachable(layout: DungeonLayout): number[] {
  const { width, depth, tiles } = layout;
  const lockAt = new Map<number, number>();
  for (const d of layout.doors) if (d.lock !== null) for (const [i, j] of d.span) lockAt.set(j * width + i, d.lock);
  const roomAt = new Int32Array(width * depth).fill(-1);
  for (const r of layout.rooms) {
    for (let j = r.rect[1]; j < r.rect[3]; j++) for (let i = r.rect[0]; i < r.rect[2]; i++) roomAt[j * width + i] = r.id;
  }
  const keys = new Set<number>();
  const reached: number[] = [];
  const visited = new Uint8Array(width * depth);
  const entrance = layout.rooms[0]!;
  let frontier: number[] = [entrance.rect[1] * width + entrance.rect[0]];
  const blocked: number[] = [];
  for (;;) {
    while (frontier.length > 0) {
      const at = frontier.pop()!;
      if (visited[at]) continue;
      const lock = lockAt.get(at);
      if (lock !== undefined && !keys.has(lock)) {
        blocked.push(at);
        continue;
      }
      visited[at] = 1;
      const room = roomAt[at]!;
      if (room >= 0 && !reached.includes(room)) {
        reached.push(room);
        const k = layout.rooms[room]!.key;
        if (k !== null) keys.add(k);
      }
      const i = at % width;
      const j = Math.floor(at / width);
      for (const [di, dj] of DIRS) {
        const ii = i + di;
        const jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= width || jj >= depth) continue;
        const next = jj * width + ii;
        const t = tiles[next]!;
        if (!visited[next] && (t === ROOM_FLOOR || t === CORRIDOR_FLOOR)) frontier.push(next);
      }
    }
    const opened = blocked.filter((at) => keys.has(lockAt.get(at)!));
    if (opened.length === 0) return reached;
    frontier = opened;
    const still = blocked.filter((at) => !keys.has(lockAt.get(at)!));
    blocked.length = 0;
    blocked.push(...still);
    for (const at of opened) lockAt.delete(at);
  }
}

export interface DungeonGeometry {
  readonly floor: MeshBuilder;
  readonly walls: MeshBuilder;
  readonly ceiling: MeshBuilder;
}

/** Boxes over merged tile rectangles: floors (top at 0, 0.2 thick), walls, ceiling. */
export function dungeonGeometry(layout: DungeonLayout, spec: DungeonSpec): DungeonGeometry {
  const { width, depth, tiles, origin } = layout;
  const t = spec.tile;
  const slab = 0.2;
  const floor = new MeshBuilder();
  const walls = new MeshBuilder();
  const ceiling = new MeshBuilder();
  const isFloor = (j: number, i: number): boolean => tiles[j * width + i] === ROOM_FLOOR || tiles[j * width + i] === CORRIDOR_FLOOR;
  const X = (i: number): number => origin[0] + i * t;
  const Z = (j: number): number => origin[1] + j * t;
  for (const [j0, i0, j1, i1] of rectangles(depth, width, isFloor)) {
    floor.box([X(i0), -slab, Z(j0)], [X(i1), 0, Z(j1)], t);
    if (spec.ceiling) ceiling.box([X(i0), spec.wallHeight, Z(j0)], [X(i1), spec.wallHeight + slab, Z(j1)], t);
  }
  for (const [j0, i0, j1, i1] of rectangles(depth, width, (j, i) => tiles[j * width + i] === WALL)) {
    walls.box([X(i0), -slab, Z(j0)], [X(i1), spec.wallHeight, Z(j1)], t);
  }
  return { floor, walls, ceiling };
}
