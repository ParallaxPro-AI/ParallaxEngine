/**
 * Chunk geometry: everything of the city inside one square chunk (streets, sidewalks,
 * markings, blocks, buildings, landmarks, signal poles, built-in streetlights) as surfaces
 * by material — `matte` (painted, concrete, trim), `glass`, `metal`, `lit` (unlit glow: lit
 * windows and lamps, drawn at night only) and the textured `asphalt` (street surfaces),
 * `paving` (sidewalks, lots, plazas), `brick` and `plaster` (masonry walls; their vertex
 * colours tint the photograph) — at a level of detail:
 *
 *   0  near: recessed windows with reveals and sills, curtain-wall mullions, storefronts with
 *      awnings, doors (open ones into a furnished-ready ground floor), parapets, cornices,
 *      rooftop plant, lane markings, crosswalks, signal poles, lamps.
 *   1  middle: flat facades with window bands, roofs, streets and blocks without markings.
 *   2  far: massing boxes in a blended facade colour, gable roofs, streets and blocks.
 *
 * Collision (`chunkCollision`) is the same at every level: street surfaces and bridge
 * decks, raised blocks with their curbs, building prisms (an enterable ground floor is a
 * shell with a door gap), stadium stands. Pure functions of the plan: the job runner builds
 * chunks off the main thread with the same code.
 */

import type { Building, CityLayout, Quad, RoadEdge, Rgb, XZ } from './layout.js';
import { bilinear, edgeHeight, insetQuad, quadCenter, shrinkQuad } from './layout.js';
import type { Approach, LaneGraph } from './lanes.js';
import { crossDistance, stopDistance } from './lanes.js';
import { MeshBuilder, SolidBuilder } from './mesh.js';
import type { CitySurface, V3 } from './mesh.js';
import { hash, Rng } from './noise.js';

export type Lod = 0 | 1 | 2;
export const PART_NAMES = ['matte', 'glass', 'metal', 'lit', 'asphalt', 'paving', 'brick', 'plaster'] as const;
export type PartName = typeof PART_NAMES[number];
/** Meters per texture repeat of the textured parts (their UVs are world-projected). */
export const PART_TILES: Readonly<Partial<Record<PartName, number>>> = { asphalt: 8, paving: 4, brick: 2.4, plaster: 3 };

export interface ChunkContent {
  readonly key: string;
  readonly cx: number;
  readonly cz: number;
  readonly edges: number[];
  readonly nodes: number[];
  readonly cells: number[];
  readonly buildings: number[];
  readonly landmarks: number[];
  readonly props: number[];
  readonly approaches: number[];
  /** x0, z0, x1, z1 of the chunk square. */
  readonly bounds: readonly [number, number, number, number];
}

export interface ChunkIndex {
  readonly size: number;
  readonly chunks: ReadonlyMap<string, ChunkContent>;
}

export interface ChunkGeometry {
  readonly key: string;
  readonly lod: Lod;
  readonly parts: Readonly<Record<PartName, CitySurface | null>>;
}

export const chunkKey = (cx: number, cz: number): string => `${cx},${cz}`;

/** Which chunk holds what: edges by midpoint, nodes by position, blocks and buildings by center, props by position. */
export function indexChunks(layout: CityLayout, graph: LaneGraph, size: number): ChunkIndex {
  const chunks = new Map<string, ChunkContent>();
  const at = (x: number, z: number): ChunkContent => {
    const cx = Math.floor(x / size);
    const cz = Math.floor(z / size);
    const key = chunkKey(cx, cz);
    let c = chunks.get(key);
    if (c === undefined) {
      c = { key, cx, cz, edges: [], nodes: [], cells: [], buildings: [], landmarks: [], props: [], approaches: [], bounds: [cx * size, cz * size, (cx + 1) * size, (cz + 1) * size] };
      chunks.set(key, c);
    }
    return c;
  };
  for (const e of layout.edges) {
    const a = layout.nodes[e.a]!;
    const b = layout.nodes[e.b]!;
    at((a.x + b.x) / 2, (a.z + b.z) / 2).edges.push(e.id);
  }
  for (const n of layout.nodes) if (n.edges.length > 0) at(n.x, n.z).nodes.push(n.id);
  for (const c of layout.cells) {
    const p = quadCenter(c.corners);
    at(p[0], p[1]).cells.push(c.id);
  }
  for (const b of layout.buildings) {
    const p = quadCenter(b.footprint);
    at(p[0], p[1]).buildings.push(b.id);
  }
  layout.landmarks.forEach((l, i) => {
    if (l.kind === 'stadium' && l.cells.length > 0) at(l.at[0], l.at[1]).landmarks.push(i);
  });
  for (const p of layout.props) at(p.x, p.z).props.push(p.id);
  for (const a of graph.approaches) {
    const n = layout.nodes[a.node]!;
    if (n.signal) at(n.x, n.z).approaches.push(a.id);
  }
  return { size, chunks };
}

// ── Colours (sRGB) ──────────────────────────────────────────────────────────────

const ASPHALT: Rgb = [0.16, 0.16, 0.17];
const SIDEWALK: Rgb = [0.6, 0.59, 0.56];
const CURB: Rgb = [0.72, 0.71, 0.68];
const WHITE: Rgb = [0.88, 0.88, 0.85];
const YELLOW: Rgb = [0.86, 0.68, 0.18];
const GRASS: Rgb = [0.27, 0.41, 0.19];
const YARD: Rgb = [0.32, 0.46, 0.22];
const PAVING: Rgb = [0.66, 0.63, 0.58];
const PAVING_DARK: Rgb = [0.56, 0.53, 0.49];
const YARD_CONCRETE: Rgb = [0.42, 0.42, 0.41];
const POLE: Rgb = [0.22, 0.23, 0.24];
const SIGNAL_BOX: Rgb = [0.13, 0.13, 0.12];
const LAMP_GLOW: Rgb = [1, 0.86, 0.6];
const WINDOW_GLOW: readonly Rgb[] = [[1, 0.84, 0.55], [1, 0.92, 0.75], [0.85, 0.9, 1], [1, 0.78, 0.5]];
/** Vertex tints over the photographs (the texture brings the tone; these keep the old look). */
const ASPHALT_TINT: Rgb = [0.62, 0.62, 0.64];
const PAVING_TINT = (c: Rgb): Rgb => mix(c, [1, 1, 1], 0.45);
const AWNINGS: readonly Rgb[] = [[0.62, 0.14, 0.12], [0.12, 0.36, 0.22], [0.14, 0.2, 0.38], [0.75, 0.55, 0.15], [0.3, 0.3, 0.32]];
const WATER: Rgb = [0.25, 0.42, 0.5];
const DOOR: Rgb = [0.18, 0.15, 0.13];

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const shade = (c: Rgb, k: number): Rgb => [Math.min(1, c[0] * k), Math.min(1, c[1] * k), Math.min(1, c[2] * k)];

type Builders = Readonly<Record<PartName, MeshBuilder>>;

export interface ChunkOptions {
  /** Draw lamps at streetlight sites whose prefab is "" (no streetlight prefab given). */
  readonly builtinLamps: boolean;
  readonly drive: 'right' | 'left';
}

/** Every surface of one chunk at one level of detail. */
export function chunkGeometry(layout: CityLayout, graph: LaneGraph, content: ChunkContent, lod: Lod, options: ChunkOptions): ChunkGeometry {
  const B = Object.fromEntries(PART_NAMES.map((name) => [name, new MeshBuilder(PART_TILES[name] ?? 0)])) as Builders;
  for (const id of content.edges) emitEdge(layout, layout.edges[id]!, lod, B, options);
  for (const id of content.nodes) emitNode(layout, id, lod, B);
  for (const id of content.cells) emitCell(layout, id, lod, B);
  for (const id of content.buildings) emitBuilding(layout.buildings[id]!, lod, B);
  for (const id of content.landmarks) emitStadium(layout, id, lod, B);
  if (lod === 0) {
    for (const id of content.approaches) emitSignalPole(graph.approaches[id]!, B);
    if (options.builtinLamps) {
      for (const id of content.props) {
        const p = layout.props[id]!;
        if (p.role === 'streetlight' && p.prefab === '') emitLamp(p.x, p.y, p.z, p.yaw, B);
      }
    }
  }
  const out = (m: MeshBuilder): CitySurface | null => (m.triangleCount === 0 ? null : m.build());
  return { key: content.key, lod, parts: Object.fromEntries(PART_NAMES.map((name) => [name, out(B[name])])) as Record<PartName, CitySurface | null> };
}

// ── Streets ─────────────────────────────────────────────────────────────────────

function emitEdge(layout: CityLayout, edge: RoadEdge, lod: Lod, B: Builders, options: ChunkOptions): void {
  const A = layout.nodes[edge.a]!;
  const N = layout.nodes[edge.b]!;
  const dx = (N.x - A.x) / edge.length;
  const dz = (N.z - A.z) / edge.length;
  const rx = dz;
  const rz = -dx;
  const hw = edge.halfWidth;
  const tone = 1 + (hash(edge.id, 0x6173) - 0.5) * 0.08;
  const asphalt = shade(ASPHALT, tone);
  if (edge.bridge !== null) {
    emitBridge(layout, edge, lod, B);
  } else {
    B.asphalt.strip(A.x, A.z, N.x, N.z, hw * 2, layout.ground, shade(ASPHALT_TINT, tone));
  }
  if (lod !== 0) return;
  // Markings, between the stop lines.
  const t0 = stopDistance(layout, edge, A);
  const t1 = edge.length - stopDistance(layout, edge, N);
  if (t1 - t0 < 2) return;
  const y = (s: number): number => edgeHeight(layout, edge, s) + 0.012;
  const line = (offset: number, width: number, color: Rgb, dash: number | null, s0 = t0, s1 = t1): void => {
    if (dash === null) {
      segmentStrip(B.matte, A.x, A.z, dx, dz, rx, rz, offset, s0, s1, width, y, color, edge.bridge !== null);
      return;
    }
    for (let s = s0; s < s1; s += dash * 3) segmentStrip(B.matte, A.x, A.z, dx, dz, rx, rz, offset, s, Math.min(s1, s + dash), width, y, color, edge.bridge !== null);
  };
  const lw = layout.laneWidth;
  const median = edge.major && edge.lanes >= 2 ? 0.6 : 0;
  if (edge.major) {
    line(median / 2 + 0.05, 0.12, YELLOW, null);
    line(-(median / 2 + 0.05), 0.12, YELLOW, null);
  } else {
    line(0, 0.12, YELLOW, 2.5);
  }
  for (let i = 1; i < edge.lanes; i++) {
    const o = median / 2 + i * lw;
    line(o, 0.12, WHITE, 3);
    line(-o, 0.12, WHITE, 3);
  }
  const carriage = median / 2 + edge.lanes * lw;
  if (edge.parking) {
    line(carriage, 0.12, WHITE, null);
    line(-carriage, 0.12, WHITE, null);
  }
  // Stop lines across the incoming half at each controlled end, crosswalks beyond them.
  const side = options.drive === 'right' ? 1 : -1;
  for (const [node, sStop, dir] of [[A, t0, -1], [N, t1, 1]] as const) {
    if (node.edges.length < 3) continue;
    // Travel toward `node` runs along +d at N (dir 1) and −d at A (dir −1): incoming lanes are right of travel.
    const o0 = median / 2 * side * dir;
    const o1 = carriage * side * dir;
    segmentStrip(B.matte, A.x, A.z, dx, dz, rx, rz, 0, sStop - 0.25, sStop + 0.25, 0, y, WHITE, edge.bridge !== null, Math.min(o0, o1), Math.max(o0, o1));
    const sCross = dir === 1 ? edge.length - crossDistance(layout, edge, node) : crossDistance(layout, edge, node);
    for (let o = -hw + 0.6; o <= hw - 0.6; o += 1.1) {
      segmentStrip(B.matte, A.x, A.z, dx, dz, rx, rz, o, sCross - 1.5, sCross + 1.5, 0.55, y, WHITE, edge.bridge !== null);
    }
  }
}

/** A flat strip along an edge: offset across, s0..s1 along (or across o0..o1 when given). */
function segmentStrip(
  m: MeshBuilder, ax: number, az: number, dx: number, dz: number, rx: number, rz: number, offset: number, s0: number, s1: number, width: number,
  y: (s: number) => number, color: Rgb, sloped: boolean, o0?: number, o1?: number,
): void {
  const lo = o0 ?? offset - width / 2;
  const hi = o1 ?? offset + width / 2;
  const steps = sloped ? Math.max(1, Math.ceil((s1 - s0) / 4)) : 1;
  for (let k = 0; k < steps; k++) {
    const a = s0 + ((s1 - s0) * k) / steps;
    const b = s0 + ((s1 - s0) * (k + 1)) / steps;
    const p = (s: number, o: number): V3 => [ax + dx * s + rx * o, y(s), az + dz * s + rz * o];
    m.quadToward(p(a, lo), p(b, lo), p(b, hi), p(a, hi), [0, 1, 0], color);
  }
}

function emitNode(layout: CityLayout, id: number, lod: Lod, B: Builders): void {
  const node = layout.nodes[id]!;
  if (node.edges.length === 0) return; // a block corner inside an excluded rectangle: no street there
  if (node.edges.some((e) => layout.edges[e]!.bridge !== null) && node.edges.length === 1) return;
  let r = 0;
  for (const e of node.edges) r = Math.max(r, layout.edges[e]!.halfWidth);
  B.asphalt.disc(node.x, node.z, r * 1.12, layout.ground - 0.002, lod === 2 ? 8 : 16, ASPHALT_TINT);
}

function emitBridge(layout: CityLayout, edge: RoadEdge, lod: Lod, B: Builders): void {
  const A = layout.nodes[edge.a]!;
  const N = layout.nodes[edge.b]!;
  const dx = (N.x - A.x) / edge.length;
  const dz = (N.z - A.z) / edge.length;
  const rx = dz;
  const rz = -dx;
  const hw = edge.halfWidth + 0.8;
  const steps = Math.max(4, Math.ceil(edge.length / 6));
  const deck = 1.1;
  const concrete: Rgb = [0.62, 0.61, 0.58];
  for (let k = 0; k < steps; k++) {
    const s0 = (edge.length * k) / steps;
    const s1 = (edge.length * (k + 1)) / steps;
    const y0 = edgeHeight(layout, edge, s0);
    const y1 = edgeHeight(layout, edge, s1);
    const p = (s: number, o: number, y: number): V3 => [A.x + dx * s + rx * o, y, A.z + dz * s + rz * o];
    B.matte.quadToward(p(s0, -hw, y0), p(s1, -hw, y1), p(s1, hw, y1), p(s0, hw, y0), [0, 1, 0], ASPHALT);
    if (y0 > layout.ground + 0.3 || y1 > layout.ground + 0.3) {
      B.matte.quadToward(p(s0, -hw, y0 - deck), p(s1, -hw, y1 - deck), p(s1, hw, y1 - deck), p(s0, hw, y0 - deck), [0, -1, 0], concrete);
      for (const o of [-hw, hw]) {
        B.matte.quadToward(p(s0, o, y0 - deck), p(s1, o, y1 - deck), p(s1, o, y1), p(s0, o, y0), [rx * o, 0, rz * o], concrete);
        // Parapet walls.
        B.matte.quadToward(p(s0, o, y0), p(s1, o, y1), p(s1, o, y1 + 1.05), p(s0, o, y0 + 1.05), [-rx * o, 0, -rz * o], concrete);
        B.matte.quadToward(p(s0, o * 1.02, y0), p(s1, o * 1.02, y1), p(s1, o * 1.02, y1 + 1.05), p(s0, o * 1.02, y0 + 1.05), [rx * o, 0, rz * o], concrete);
        B.matte.quadToward(p(s0, o, y0 + 1.05), p(s1, o, y1 + 1.05), p(s1, o * 1.02, y1 + 1.05), p(s0, o * 1.02, y0 + 1.05), [0, 1, 0], concrete);
      }
    }
  }
  // Piers every ~40 m where the deck is up.
  const piers = Math.floor(edge.length / 40);
  for (let k = 1; k <= piers; k++) {
    const s = (edge.length * k) / (piers + 1);
    const y = edgeHeight(layout, edge, s);
    if (y - layout.ground < 2) continue;
    const cx = A.x + dx * s;
    const cz = A.z + dz * s;
    B.matte.box(cx, cz, rx, rz, hw * 0.75, 1.1, layout.ground - 6, y - deck, concrete);
  }
  if (lod === 0) {
    for (let s = 12; s < edge.length - 12; s += 30) emitLamp(A.x + dx * s + rx * (hw - 0.4), edgeHeight(layout, edge, s), A.z + dz * s + rz * (hw - 0.4), (Math.atan2(-rx, -rz) * 180) / Math.PI, B);
  }
}

// ── Blocks ──────────────────────────────────────────────────────────────────────

function emitCell(layout: CityLayout, id: number, lod: Lod, B: Builders): void {
  const cell = layout.cells[id]!;
  const g = layout.ground;
  const top = g + layout.curb;
  B.paving.top(cell.curb, top, PAVING_TINT(SIDEWALK));
  for (let k = 0; k < 4; k++) {
    const a = cell.curb[k]!;
    const b = cell.curb[(k + 1) % 4]!;
    // The curb faces the street: to the right of a → b (the block is on the left).
    B.matte.wall(a[0], a[1], b[0], b[1], g - 0.05, top, CURB);
    if (lod === 0 && cell.sides[k]! >= 0) {
      const t = [b[0] - a[0], b[1] - a[1]];
      const l = Math.hypot(t[0]!, t[1]!) || 1;
      const lx = (-t[1]! / l) * 0.28;
      const lz = (t[0]! / l) * 0.28;
      B.matte.top([a, b, [b[0] + lx, b[1] + lz], [a[0] + lx, a[1] + lz]], top + 0.003, CURB);
    }
  }
  const lotY = top + 0.012;
  if (cell.kind === 'park') {
    B.matte.top(cell.lot, lotY, GRASS);
    if (lod <= 1) {
      const q = cell.lot;
      const pathY = lotY + 0.01;
      B.matte.strip(q[0][0], q[0][1], q[2][0], q[2][1], 3, pathY, PAVING);
      B.matte.strip(q[1][0], q[1][1], q[3][0], q[3][1], 3, pathY, PAVING);
    }
    return;
  }
  if (cell.kind === 'plaza') {
    if (lod === 0) {
      for (let i = 0; i < 6; i++) {
        for (let j = 0; j < 6; j++) {
          const q: Quad = [bilinear(cell.lot, i / 6, j / 6), bilinear(cell.lot, (i + 1) / 6, j / 6), bilinear(cell.lot, (i + 1) / 6, (j + 1) / 6), bilinear(cell.lot, i / 6, (j + 1) / 6)];
          B.paving.top(q, lotY, PAVING_TINT((i + j) % 2 === 0 ? PAVING : PAVING_DARK));
        }
      }
    } else {
      B.paving.top(cell.lot, lotY, PAVING_TINT(PAVING));
    }
    const c = quadCenter(cell.lot);
    B.matte.cylinder(c[0], c[1], 6.5, 6.5, lotY, lotY + 0.6, lod === 2 ? 8 : 20, [0.7, 0.68, 0.64]);
    if (lod <= 1) {
      B.glass.disc(c[0], c[1], 6.1, lotY + 0.62, 20, WATER);
      B.matte.cylinder(c[0], c[1], 1.2, 0.9, lotY, lotY + 2.2, 12, [0.7, 0.68, 0.64]);
    }
    return;
  }
  if (cell.kind === 'landmark') {
    B.paving.top(cell.lot, lotY, PAVING_TINT(PAVING));
    return;
  }
  const ground = cell.district === 'downtown' ? PAVING : cell.district === 'commercial' ? PAVING_DARK
    : cell.district === 'industrial' ? YARD_CONCRETE : cell.district === 'suburban' ? YARD : mix(YARD, PAVING_DARK, 0.25);
  if (cell.district === 'downtown' || cell.district === 'commercial' || cell.district === 'industrial') B.paving.top(cell.lot, lotY, PAVING_TINT(ground));
  else B.matte.top(cell.lot, lotY, ground);
}

// ── Buildings ───────────────────────────────────────────────────────────────────

interface Face {
  readonly ax: number;
  readonly az: number;
  readonly tx: number;
  readonly tz: number;
  readonly length: number;
}

function faceOf(a: XZ, b: XZ): Face {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  return { ax: a[0], az: a[1], tx: (b[0] - a[0]) / (length || 1), tz: (b[1] - a[1]) / (length || 1), length };
}

/** Floor bands of a tier: [y0, y1, ground?] in absolute heights. */
function floorsOf(b: Building, y0: number, y1: number): [number, number, boolean][] {
  const out: [number, number, boolean][] = [];
  let y = y0;
  if (y0 <= b.base + 1e-6) {
    const g = Math.min(y1, b.base + b.groundFloor);
    out.push([y, g, true]);
    y = g;
  }
  while (y1 - y > 1.2) {
    const next = y1 - (y + b.floorHeight) < b.floorHeight * 0.5 ? y1 : y + b.floorHeight;
    out.push([y, next, false]);
    y = next;
  }
  if (out.length > 0 && y < y1 - 1e-6) out[out.length - 1]![1] = y1;
  return out;
}

const facadeTint = (b: Building): Rgb => (b.facade === 'curtain' ? mix(b.wall, b.glass, 0.72) : b.facade === 'industrial' ? b.wall : mix(b.wall, b.glass, 0.18));

export function emitBuilding(b: Building, lod: Lod, B: Builders): void {
  const rng = new Rng(b.seed, lod);
  b.tiers.forEach((tier, ti) => {
    const q = shrinkQuad(b.footprint, tier.inset);
    const y0 = b.base + tier.y0;
    const y1 = b.base + tier.y1;
    const isTop = ti === b.tiers.length - 1;
    for (let k = 0; k < 4; k++) {
      const face = faceOf(q[k]!, q[(k + 1) % 4]!);
      const front = ti === 0 && k === b.front;
      if (lod === 2) B.matte.wall(face.ax, face.az, face.ax + face.tx * face.length, face.az + face.tz * face.length, y0, y1, shade(facadeTint(b), k % 2 === 0 ? 1 : 0.9));
      else emitFace(b, face, k, y0, y1, front, lod, B, rng);
    }
    if (isTop) emitRoof(b, q, y1, lod, B, rng);
    else B.matte.top(q, y1, b.roofColor);
  });
}

/** The masonry a building's walls are faced in: houses and sheds in plaster, other walls
 *  mostly brick (a curtain wall's frame stays painted). */
function masonryOf(b: Building): 'brick' | 'plaster' | 'matte' {
  if (b.facade === 'curtain') return 'matte';
  if (b.facade === 'house' || b.facade === 'industrial') return 'plaster';
  return hash(b.seed, 0x6272) < 0.65 ? 'brick' : 'plaster';
}

/** A wall colour as the vertex tint over its masonry photograph. */
function masonryTint(kind: 'brick' | 'plaster' | 'matte', c: Rgb): Rgb {
  return kind === 'brick' ? mix(c, [1, 1, 1], 0.55) : kind === 'plaster' ? mix(c, [1, 1, 1], 0.2) : c;
}

function emitFace(b: Building, f: Face, side: number, y0: number, y1: number, front: boolean, lod: Lod, B: Builders, rng: Rng): void {
  const ex = f.ax + f.tx * f.length;
  const ez = f.az + f.tz * f.length;
  const kind = masonryOf(b);
  const W = B[kind];
  const wall = masonryTint(kind, side % 2 === 0 ? b.wall : shade(b.wall, 0.93));
  const paint = side % 2 === 0 ? b.wall : shade(b.wall, 0.93);
  const floors = floorsOf(b, y0, y1);
  const bays = Math.max(1, Math.round(f.length / b.bay));
  const bw = f.length / bays;
  const [ww, wh] = b.window;
  const lit = (floor: number, bay: number): boolean => hash(b.seed, side, floor, bay) < (b.district === 'downtown' ? 0.32 : 0.4);
  const glow = (floor: number, bay: number): Rgb => WINDOW_GLOW[Math.floor(hash(b.seed, floor, bay, 7) * WINDOW_GLOW.length)]!;
  const doorAt = front && b.door !== null ? f.length / 2 : -1;
  const doorW = b.door?.width ?? 0;

  if (lod === 1) {
    W.wall(f.ax, f.az, ex, ez, y0, y1, wall);
    floors.forEach(([fy0, fy1, ground], fi) => {
      const h = fy1 - fy0;
      if (b.facade === 'curtain') {
        B.glass.facePatch(f.ax, f.az, f.tx, f.tz, 0.25, f.length - 0.25, fy0 + 0.35, fy1, 0.03, b.glass);
      } else if (b.facade === 'industrial') {
        B.glass.facePatch(f.ax, f.az, f.tx, f.tz, 0.8, f.length - 0.8, fy1 - 2.4, fy1 - 1.3, 0.03, b.glass);
      } else if (ground && b.facade === 'storefront') {
        B.glass.facePatch(f.ax, f.az, f.tx, f.tz, 0.4, f.length - 0.4, fy0 + 0.4, fy1 - 0.7, 0.03, b.glass);
      } else {
        const wy0 = fy0 + h * (1 - wh) * 0.55;
        B.glass.facePatch(f.ax, f.az, f.tx, f.tz, bw * (1 - ww) / 2, f.length - bw * (1 - ww) / 2, wy0, wy0 + h * wh, 0.03, b.glass);
      }
      // Night: lit runs of three bays.
      for (let k = 0; k < bays; k += 3) {
        if (!lit(fi, k) || (ground && b.facade !== 'storefront')) continue;
        const x0 = k * bw + bw * (1 - ww) / 2;
        const x1 = Math.min(bays, k + 3) * bw - bw * (1 - ww) / 2;
        B.lit.facePatch(f.ax, f.az, f.tx, f.tz, x0, x1, fy0 + h * 0.3, fy0 + h * 0.8, 0.05, glow(fi, k));
      }
    });
    if (front && b.door !== null) B.matte.facePatch(f.ax, f.az, f.tx, f.tz, doorAt - doorW / 2, doorAt + doorW / 2, y0, y0 + Math.min(2.6, b.groundFloor - 0.3), 0.04, DOOR);
    return;
  }

  // LOD 0.
  const reveal = shade(paint, 0.78);
  if (b.facade === 'curtain') {
    // Mullion fins run the tier's full height; the floor ledges are drawn per floor below.
    const from = floors[0]?.[2] === true && !(front && b.enterable) ? floors[0]![1] : y0;
    for (let k = 0; k <= bays; k++) {
      const x = k * bw;
      B.metal.faceBox(f.ax, f.az, f.tx, f.tz, Math.max(0, x - 0.05), Math.min(f.length, x + 0.05), from, y1, 0.14, shade(b.wall, 0.85), 'fin');
    }
  }
  floors.forEach(([fy0, fy1, ground], fi) => {
    const h = fy1 - fy0;
    if (ground && front && b.enterable && b.door !== null) {
      emitShellFront(b, f, fy0, fy1, paint, B);
      return;
    }
    if (b.facade === 'curtain') {
      // Glass between the floor plates; mullion fins and spandrel ledges in the frame colour.
      B.glass.facePatch(f.ax, f.az, f.tx, f.tz, 0, f.length, fy0, fy1, 0, b.glass);
      B.matte.faceBox(f.ax, f.az, f.tx, f.tz, 0, f.length, fy0, fy0 + 0.32, 0.1, b.wall, 'ledge');
      if (ground) {
        for (let k = 0; k <= bays; k++) {
          const x = k * bw;
          B.metal.faceBox(f.ax, f.az, f.tx, f.tz, Math.max(0, x - 0.06), Math.min(f.length, x + 0.06), fy0 + 0.32, fy1, 0.16, shade(b.wall, 0.75), 'fin');
        }
      }
      for (let k = 0; k < bays; k++) if (lit(fi, k) && !ground) B.lit.facePatch(f.ax, f.az, f.tx, f.tz, k * bw + 0.08, (k + 1) * bw - 0.08, fy0 + 0.4, fy1 - 0.1, 0.02, glow(fi, k));
      if (ground && front && b.door !== null) B.matte.facePatch(f.ax, f.az, f.tx, f.tz, doorAt - doorW / 2, doorAt + doorW / 2, fy0, fy0 + 2.6, 0.03, DOOR);
      return;
    }
    if (b.facade === 'industrial') {
      // Roll-up doors along the front, a strip of high windows all round.
      W.wall(f.ax, f.az, ex, ez, fy0, fy1, wall);
      if (front) {
        const doors = Math.max(1, Math.floor(f.length / 12));
        for (let d = 0; d < doors; d++) {
          const cx = ((d + 0.5) * f.length) / doors;
          B.metal.facePatch(f.ax, f.az, f.tx, f.tz, cx - 2.2, cx + 2.2, fy0, fy0 + 4.6, 0.02, [0.5, 0.52, 0.54]);
          for (let y = fy0 + 0.5; y < fy0 + 4.6; y += 0.55) B.metal.faceBox(f.ax, f.az, f.tx, f.tz, cx - 2.2, cx + 2.2, y, y + 0.06, 0.05, [0.62, 0.64, 0.66]);
        }
      }
      for (let k = 0; k < bays; k++) {
        const x0 = k * bw + 0.6;
        const x1 = (k + 1) * bw - 0.6;
        B.matte.recess(f.ax, f.az, f.tx, f.tz, x0, x1, fy1 - 2.4, fy1 - 1.3, 0.15, reveal, B.glass, b.glass);
      }
      // The wall around the strip windows is drawn whole above (the panes sit behind it).
      return;
    }
    if (ground && b.facade === 'storefront') {
      emitStorefront(b, f, fy0, fy1, bays, bw, doorAt, B, rng, fi, lit, glow);
      return;
    }
    // Punched windows (and house windows): wall bands above and below, piers between, recessed panes.
    const wy0 = fy0 + h * (1 - wh) * 0.55;
    const wy1 = wy0 + h * wh;
    W.facePatch(f.ax, f.az, f.tx, f.tz, 0, f.length, fy0, wy0, 0, wall);
    W.facePatch(f.ax, f.az, f.tx, f.tz, 0, f.length, wy1, fy1, 0, wall);
    let x = 0;
    for (let k = 0; k < bays; k++) {
      const c = (k + 0.5) * bw;
      const isDoor = ground && doorAt >= 0 && Math.abs(c - doorAt) < bw / 2 + 1e-6;
      const half = isDoor ? Math.min(doorW / 2 + 0.2, bw / 2 - 0.1) : (bw * ww) / 2;
      const x0 = c - half;
      const x1 = c + half;
      W.facePatch(f.ax, f.az, f.tx, f.tz, x, x0, wy0, wy1, 0, wall);
      if (isDoor) {
        // A door from the floor: wall above it in the window band's place.
        W.facePatch(f.ax, f.az, f.tx, f.tz, x0, x1, fy0, wy0, 0.001, wall);
        const top = Math.min(fy0 + 2.5, wy1);
        B.matte.recess(f.ax, f.az, f.tx, f.tz, x0 + 0.2, x1 - 0.2, fy0, top, 0.2, reveal, B.matte, DOOR);
        W.facePatch(f.ax, f.az, f.tx, f.tz, x0, x0 + 0.2, fy0, top, 0.002, wall);
        W.facePatch(f.ax, f.az, f.tx, f.tz, x1 - 0.2, x1, fy0, top, 0.002, wall);
        if (top < wy1) W.facePatch(f.ax, f.az, f.tx, f.tz, x0, x1, top, wy1, 0.002, wall);
        B.lit.facePatch(f.ax, f.az, f.tx, f.tz, c - 0.15, c + 0.15, top + 0.15, top + 0.4, 0.06, LAMP_GLOW);
      } else {
        B.matte.recess(f.ax, f.az, f.tx, f.tz, x0, x1, wy0, wy1, 0.18, reveal, B.glass, b.glass);
        if (b.facade !== 'house') B.matte.faceBox(f.ax, f.az, f.tx, f.tz, x0 - 0.08, x1 + 0.08, wy0 - 0.1, wy0, 0.09, b.trim, 'sill');
        else B.matte.facePatch(f.ax, f.az, f.tx, f.tz, x0 - 0.1, x1 + 0.1, wy0 - 0.1, wy1 + 0.1, 0.005, b.trim);
        if (lit(fi, k) && !ground) B.lit.facePatch(f.ax, f.az, f.tx, f.tz, x0, x1, wy0, wy1, -0.17, glow(fi, k));
      }
      x = x1;
    }
    W.facePatch(f.ax, f.az, f.tx, f.tz, x, f.length, wy0, wy1, 0, wall);
  });
}

function emitStorefront(
  b: Building, f: Face, fy0: number, fy1: number, bays: number, bw: number, doorAt: number, B: Builders, rng: Rng, fi: number,
  lit: (floor: number, bay: number) => boolean, glow: (floor: number, bay: number) => Rgb,
): void {
  const sign = b.trim;
  const kick = shade(b.wall, 0.7);
  const paneTop = fy1 - 0.9;
  B.matte.facePatch(f.ax, f.az, f.tx, f.tz, 0, f.length, fy0, fy0 + 0.45, 0, kick);
  B.matte.facePatch(f.ax, f.az, f.tx, f.tz, 0, f.length, paneTop, fy1, 0, sign);
  B.matte.faceBox(f.ax, f.az, f.tx, f.tz, 0, f.length, fy1 - 0.25, fy1, 0.18, shade(sign, 0.85));
  for (let k = 0; k <= bays; k++) {
    const x = k * bw;
    B.matte.facePatch(f.ax, f.az, f.tx, f.tz, Math.max(0, x - 0.2), Math.min(f.length, x + 0.2), fy0 + 0.45, paneTop, 0, sign);
  }
  for (let k = 0; k < bays; k++) {
    const x0 = k * bw + 0.2;
    const x1 = (k + 1) * bw - 0.2;
    const c = (k + 0.5) * bw;
    if (doorAt >= 0 && Math.abs(c - doorAt) < bw / 2 + 1e-6) {
      B.matte.recess(f.ax, f.az, f.tx, f.tz, x0, x1, fy0, paneTop, 0.25, kick, B.glass, mix(b.glass, DOOR, 0.6));
      B.matte.facePatch(f.ax, f.az, f.tx, f.tz, x0, x1, fy0, fy0 + 0.45, 0.001, kick);
    } else {
      B.matte.recess(f.ax, f.az, f.tx, f.tz, x0, x1, fy0 + 0.45, paneTop, 0.12, kick, B.glass, mix(b.glass, [0.55, 0.5, 0.4], 0.25));
    }
    if (lit(fi, k)) B.lit.facePatch(f.ax, f.az, f.tx, f.tz, x0, x1, fy0 + 0.5, paneTop - 0.05, -0.11, glow(fi, k));
  }
  if (rng.chance(0.55)) {
    // A sloped awning over the windows.
    const color = AWNINGS[rng.int(0, AWNINGS.length - 1)]!;
    const nx = f.tz;
    const nz = -f.tx;
    const p = (x: number, y: number, o: number): V3 => [f.ax + f.tx * x + nx * o, y, f.az + f.tz * x + nz * o];
    const ya = paneTop + 0.1;
    const yb = ya - 0.55;
    B.matte.quadToward(p(0.3, ya, 0), p(f.length - 0.3, ya, 0), p(f.length - 0.3, yb, 1.3), p(0.3, yb, 1.3), [nx, 1, nz], color);
    B.matte.quadToward(p(0.3, ya, 0), p(f.length - 0.3, ya, 0), p(f.length - 0.3, yb, 1.3), p(0.3, yb, 1.3), [-nx, -1, -nz], shade(color, 0.7));
    B.matte.facePatch(f.ax, f.az, f.tx, f.tz, 0.3, f.length - 0.3, yb - 0.25, yb, 1.3, color);
  }
}

/** An enterable ground floor's street face: wall with a door gap, the room's inside walls, floor and ceiling. */
function emitShellFront(b: Building, f: Face, fy0: number, fy1: number, wall: Rgb, B: Builders): void {
  const door = b.door!;
  const c = f.length / 2;
  const top = Math.min(fy0 + 2.7, fy1 - 0.3);
  B.matte.facePatch(f.ax, f.az, f.tx, f.tz, 0, c - door.width / 2, fy0, fy1, 0, wall);
  B.matte.facePatch(f.ax, f.az, f.tx, f.tz, c + door.width / 2, f.length, fy0, fy1, 0, wall);
  B.matte.facePatch(f.ax, f.az, f.tx, f.tz, c - door.width / 2, c + door.width / 2, top, fy1, 0, wall);
  B.matte.recess(f.ax, f.az, f.tx, f.tz, c - door.width / 2, c + door.width / 2, fy0, top, SHELL, shade(wall, 0.75), null, DOOR);
  B.lit.facePatch(f.ax, f.az, f.tx, f.tz, c - 0.2, c + 0.2, top + 0.15, top + 0.45, 0.06, LAMP_GLOW);
  // The room: inner faces of all four walls, floor, ceiling and a ceiling light.
  const inner = insetQuad(b.footprint, [SHELL, SHELL, SHELL, SHELL]);
  const room: Rgb = [0.82, 0.8, 0.75];
  for (let k = 0; k < 4; k++) {
    const a = inner[k]!;
    const n = inner[(k + 1) % 4]!;
    // Facing into the room: a wall from n back to a faces right of n → a, which is inward.
    if (k === b.front) {
      const t = faceOf(n, a);
      const cc = t.length / 2;
      B.matte.facePatch(t.ax, t.az, t.tx, t.tz, 0, cc - door.width / 2, fy0, fy1, 0, room);
      B.matte.facePatch(t.ax, t.az, t.tx, t.tz, cc + door.width / 2, t.length, fy0, fy1, 0, room);
      B.matte.facePatch(t.ax, t.az, t.tx, t.tz, cc - door.width / 2, cc + door.width / 2, top, fy1, 0, room);
    } else {
      B.matte.wall(n[0], n[1], a[0], a[1], fy0, fy1, room);
    }
  }
  B.matte.top(inner, fy0 + 0.02, [0.5, 0.42, 0.33]);
  B.matte.bottom(inner, fy1 - 0.02, [0.9, 0.9, 0.88]);
  const cc = quadCenter(inner);
  B.lit.disc(cc[0], cc[1], 0.6, fy1 - 0.04, 8, [1, 0.95, 0.85]);
}

const SHELL = 0.25;

function emitRoof(b: Building, q: Quad, y: number, lod: Lod, B: Builders, rng: Rng): void {
  if (b.roof === 'gable') {
    const l01 = Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]);
    const l12 = Math.hypot(q[2][0] - q[1][0], q[2][1] - q[1][1]);
    // The ridge runs along the longer pair of sides.
    const [a, bb, c, d] = l01 >= l12 ? [q[0], q[1], q[2], q[3]] : [q[1], q[2], q[3], q[0]];
    const short = Math.min(l01, l12);
    const rise = Math.max(1.4, Math.min(4.5, short * 0.36));
    const mid = (p: XZ, r: XZ): V3 => [(p[0] + r[0]) / 2, y + rise, (p[1] + r[1]) / 2];
    const r0 = mid(a, d);
    const r1 = mid(bb, c);
    const P = (p: XZ): V3 => [p[0], y, p[1]];
    const cx = quadCenter(q);
    const away = (p: V3): V3 => [p[0] - cx[0], 0.5, p[2] - cx[1]];
    const roof = b.roofColor;
    const s0: V3 = [(a[0] + bb[0]) / 2, y, (a[1] + bb[1]) / 2];
    const s1: V3 = [(c[0] + d[0]) / 2, y, (c[1] + d[1]) / 2];
    B.matte.quadToward(P(a), P(bb), r1, r0, away(s0), roof);
    B.matte.quadToward(P(c), P(d), r0, r1, away(s1), shade(roof, 0.9));
    B.matte.triToward(P(bb), P(c), r1, away([(bb[0] + c[0]) / 2, y, (bb[1] + c[1]) / 2]), b.wall);
    B.matte.triToward(P(d), P(a), r0, away([(d[0] + a[0]) / 2, y, (d[1] + a[1]) / 2]), b.wall);
    if (lod === 0 && b.archetype === 'house') {
      const ch = bilinear(q, 0.75, 0.5);
      B.matte.box(ch[0], ch[1], 1, 0, 0.45, 0.45, y, y + rise + 0.9, [0.45, 0.3, 0.25]);
    }
    return;
  }
  if (b.roof === 'sawtooth') {
    const teeth = Math.max(2, Math.round(Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]) / 7));
    B.matte.top(q, y, b.roofColor);
    for (let t = 0; t < teeth; t++) {
      const v0 = t / teeth;
      const v1 = (t + 1) / teeth;
      const a0 = bilinear(q, 0.02, v0);
      const a1 = bilinear(q, 0.98, v0);
      const b0 = bilinear(q, 0.02, v1);
      const b1 = bilinear(q, 0.98, v1);
      const h = 2.2;
      const up = (p: [number, number]): V3 => [p[0], y + h, p[1]];
      const dn = (p: [number, number]): V3 => [p[0], y, p[1]];
      const towardV: V3 = [b0[0] - a0[0], 0, b0[1] - a0[1]];
      B.glass.quadToward(dn(a0), dn(a1), up(a1), up(a0), [-towardV[0], 0, -towardV[2]], b.glass);
      B.matte.quadToward(up(a0), up(a1), dn(b1), dn(b0), [towardV[0], 1, towardV[2]], b.roofColor);
      if (lod === 0) {
        B.matte.triToward(dn(a0), up(a0), dn(b0), [a0[0] - a1[0], 0, a0[1] - a1[1]], b.wall);
        B.matte.triToward(dn(a1), up(a1), dn(b1), [a1[0] - a0[0], 0, a1[1] - a0[1]], b.wall);
      }
    }
    return;
  }
  B.matte.top(q, y, b.roofColor);
  if (lod !== 0) {
    if (b.roof === 'spire') spireTop(b, q, y, B);
    return;
  }
  // Parapet (and a cornice on traditional facades).
  if (b.facade !== 'curtain' && b.archetype !== 'house') {
    const inner = insetQuad(q, [0.3, 0.3, 0.3, 0.3]);
    for (let k = 0; k < 4; k++) {
      const a = q[k]!;
      const n = q[(k + 1) % 4]!;
      B.matte.wall(a[0], a[1], n[0], n[1], y, y + 0.9, b.wall);
      const ia = inner[k]!;
      const ib = inner[(k + 1) % 4]!;
      B.matte.wall(ib[0], ib[1], ia[0], ia[1], y, y + 0.9, shade(b.wall, 0.8));
      B.matte.top([a, n, ib, ia], y + 0.9, b.trim);
      if (b.facade === 'storefront' || b.facade === 'punched') {
        const f = faceOf(a, n);
        B.matte.faceBox(f.ax, f.az, f.tx, f.tz, 0, f.length, y - 0.45, y - 0.1, 0.22, b.trim);
      }
    }
  } else if (b.facade === 'curtain') {
    const inner = insetQuad(q, [0.25, 0.25, 0.25, 0.25]);
    for (let k = 0; k < 4; k++) {
      const a = q[k]!;
      const n = q[(k + 1) % 4]!;
      B.metal.wall(a[0], a[1], n[0], n[1], y, y + 1.2, shade(b.wall, 0.9));
      const ia = inner[k]!;
      const ib = inner[(k + 1) % 4]!;
      B.metal.wall(ib[0], ib[1], ia[0], ia[1], y, y + 1.2, shade(b.wall, 0.7));
      B.metal.top([a, n, ib, ia], y + 1.2, b.wall);
    }
  }
  if (b.roof === 'spire') {
    spireTop(b, q, y, B);
    return;
  }
  // Rooftop plant: a penthouse on tall buildings, a few units, a water tank on old brick.
  const c = quadCenter(q);
  const t = faceOf(q[0], q[1]);
  const span = Math.min(t.length, Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]));
  if (b.height > 40) {
    const s = shrinkQuad(q, 0.62);
    B.matte.prism(s, y, y + 4.2, shade(b.wall, 0.85), { top: b.roofColor });
  }
  const units = rng.int(1, 3);
  for (let k = 0; k < units; k++) {
    const p = bilinear(q, rng.range(0.25, 0.75), rng.range(0.25, 0.75));
    B.metal.box(p[0], p[1], t.tx, t.tz, rng.range(0.8, 1.6), rng.range(0.6, 1.2), y, y + rng.range(1, 1.8), [0.62, 0.63, 0.64]);
  }
  if (b.district === 'commercial' && b.facade !== 'storefront' && span > 10 && rng.chance(0.35)) {
    const p = bilinear(q, 0.3, 0.7);
    B.matte.cylinder(p[0], p[1], 1.6, 1.6, y + 2.2, y + 5, 10, [0.42, 0.3, 0.22]);
    B.matte.cylinder(p[0], p[1], 1.65, 0.2, y + 5, y + 6, 10, [0.32, 0.24, 0.18]);
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) B.metal.box(p[0] + sx, p[1] + sz, 1, 0, 0.08, 0.08, y, y + 2.2, POLE);
  }
  void c;
}

function spireTop(b: Building, q: Quad, y: number, B: Builders): void {
  const c = quadCenter(q);
  const r = Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]) * 0.18;
  const h = b.height * 0.05;
  B.metal.cylinder(c[0], c[1], r, r * 0.6, y, y + h * 0.4, 8, b.trim);
  B.metal.cylinder(c[0], c[1], r * 0.35, 0.05, y + h * 0.4, y + h + b.height * 0.06, 6, b.trim);
  B.lit.cylinder(c[0], c[1], 0.3, 0.3, y + h + b.height * 0.06 - 1, y + h + b.height * 0.06, 6, [1, 0.25, 0.2]);
}

// ── Landmarks ───────────────────────────────────────────────────────────────────

function emitStadium(layout: CityLayout, index: number, lod: Lod, B: Builders): void {
  const l = layout.landmarks[index]!;
  const g = layout.ground + layout.curb + 0.015;
  const [cx, cz] = l.at;
  const ax = l.size[0] / 2 * 0.92;
  const az = l.size[1] / 2 * 0.92;
  const n = lod === 2 ? 16 : 40;
  const H = Math.max(8, l.height);
  const at = (k: number, r: number): [number, number] => [cx + Math.cos((k / n) * Math.PI * 2) * ax * r, cz + Math.sin((k / n) * Math.PI * 2) * az * r];
  const concrete: Rgb = [0.74, 0.73, 0.7];
  const seats: Rgb = [0.55, 0.16, 0.14];
  // Field.
  for (let k = 0; k < n; k++) {
    const a = at(k, 0.56);
    const b = at(k + 1, 0.56);
    B.matte.tri([cx, g + 0.02, cz], [b[0], g + 0.02, b[1]], [a[0], g + 0.02, a[1]], k % 2 === 0 ? GRASS : shade(GRASS, 1.12));
  }
  for (let k = 0; k < n; k++) {
    const a0 = at(k, 0.6);
    const b0 = at(k + 1, 0.6);
    const a1 = at(k, 1);
    const b1 = at(k + 1, 1);
    const P = (p: [number, number], y: number): V3 => [p[0], y, p[1]];
    // Stands: from 2.5 m over the field edge up to the rim.
    B.matte.quadToward(P(a0, g + 2.5), P(b0, g + 2.5), P(b1, g + H), P(a1, g + H), [cx - a1[0], 1, cz - a1[1]], seats);
    // Inner wall below the stands, outer facade.
    B.matte.wall(b0[0], b0[1], a0[0], a0[1], g, g + 2.5, concrete);
    B.matte.wall(a1[0], a1[1], b1[0], b1[1], layout.ground, g + H + 1.5, k % 4 === 0 ? shade(concrete, 0.82) : concrete);
    B.matte.quadToward(P(a1, g + H), P(b1, g + H), P(b1, g + H + 1.5), P(a1, g + H + 1.5), [cx - a1[0], 0, cz - a1[1]], shade(concrete, 0.9));
    if (lod <= 1) {
      // A canopy ring over the upper stands.
      const ac = at(k, 0.8);
      const bc = at(k + 1, 0.8);
      B.metal.quadToward(P(ac, g + H + 3), P(bc, g + H + 3), P(b1, g + H + 1.5), P(a1, g + H + 1.5), [0, 1, 0], [0.82, 0.83, 0.85]);
      B.metal.quadToward(P(ac, g + H + 3), P(bc, g + H + 3), P(b1, g + H + 1.5), P(a1, g + H + 1.5), [0, -1, 0], [0.5, 0.5, 0.52]);
    }
  }
  if (lod === 0) {
    for (const k of [n / 8, (3 * n) / 8, (5 * n) / 8, (7 * n) / 8]) {
      const p = at(k, 1.04);
      B.metal.cylinder(p[0], p[1], 0.5, 0.35, layout.ground, g + H + 14, 8, POLE);
      B.metal.box(p[0], p[1], 1, 0, 2.2, 0.4, g + H + 13, g + H + 15.5, [0.3, 0.3, 0.32]);
      B.lit.box(p[0], p[1], 1, 0, 2.1, 0.45, g + H + 13.2, g + H + 15.3, [1, 0.98, 0.9]);
    }
  }
}

// ── Street fixtures ─────────────────────────────────────────────────────────────

/** A built-in streetlight: pole, arm out over the street, lamp head (glow at night). */
function emitLamp(x: number, y: number, z: number, yaw: number, B: Builders): void {
  const fx = Math.sin((yaw * Math.PI) / 180);
  const fz = Math.cos((yaw * Math.PI) / 180);
  B.metal.cylinder(x, z, 0.11, 0.08, y, y + 7.6, 6, POLE);
  B.metal.box(x + fx * 0.9, z + fz * 0.9, fx, fz, 0.95, 0.05, y + 7.45, y + 7.6, POLE);
  B.metal.box(x + fx * 1.75, z + fz * 1.75, fx, fz, 0.32, 0.16, y + 7.3, y + 7.55, POLE);
  B.lit.box(x + fx * 1.75, z + fz * 1.75, fx, fz, 0.28, 0.13, y + 7.27, y + 7.3, LAMP_GLOW);
}

/** Where an approach's three lamps hang: head center (world), facing −dir (toward incoming traffic). */
export function signalHead(approach: Approach): { x: number; y: number; z: number; fx: number; fz: number } {
  // From the curb pole the mast arm reaches back over the incoming lanes, toward the centerline.
  const ax = approach.center[0] - approach.curb[0];
  const az = approach.center[1] - approach.curb[1];
  const l = Math.hypot(ax, az) || 1;
  const arm = Math.min(l, approach.reach * 0.6 + 0.5);
  return { x: approach.curb[0] + (ax / l) * arm, y: approach.y + 5.2, z: approach.curb[1] + (az / l) * arm, fx: -approach.dir[0], fz: -approach.dir[1] };
}

function emitSignalPole(approach: Approach, B: Builders): void {
  const [px, pz] = approach.curb;
  const y = approach.y + 0.15;
  const head = signalHead(approach);
  B.metal.cylinder(px, pz, 0.14, 0.11, y, y + 6, 8, POLE);
  const ax = head.x - px;
  const az = head.z - pz;
  const l = Math.hypot(ax, az) || 1;
  B.metal.box(px + ax / 2, pz + az / 2, ax / l, az / l, l / 2 + 0.2, 0.06, y + 5.75, y + 5.9, POLE);
  B.metal.box(head.x, head.z, head.fz, -head.fx, 0.2, 0.18, head.y - 0.55, head.y + 0.55, SIGNAL_BOX);
}

/** Lamps for the given approach states (the dynamic signals mesh). */
export function signalLamps(approaches: readonly { readonly approach: Approach; readonly state: 'green' | 'yellow' | 'red' }[]): CitySurface | null {
  const m = new MeshBuilder();
  for (const { approach, state } of approaches) {
    const h = signalHead(approach);
    const slot = state === 'red' ? 0.36 : state === 'yellow' ? 0 : -0.36;
    const color: Rgb = state === 'red' ? [1, 0.12, 0.08] : state === 'yellow' ? [1, 0.7, 0.1] : [0.15, 1, 0.45];
    const cx = h.x + h.fx * 0.2;
    const cz = h.z + h.fz * 0.2;
    // A small square facing the traffic.
    const rx = h.fz;
    const rz = -h.fx;
    const s = 0.13;
    const y = h.y + slot;
    m.quadToward([cx - rx * s, y - s, cz - rz * s], [cx + rx * s, y - s, cz + rz * s], [cx + rx * s, y + s, cz + rz * s], [cx - rx * s, y + s, cz - rz * s], [h.fx, 0, h.fz], color);
  }
  return m.triangleCount === 0 ? null : m.build();
}

/** The far skyline ring: plain boxes, no collision. */
export function skylineGeometry(layout: CityLayout): CitySurface | null {
  if (layout.skyline.length === 0) return null;
  const m = new MeshBuilder();
  for (const s of layout.skyline) {
    const a = (s.yaw * Math.PI) / 180;
    m.box(s.x, s.z, Math.cos(a), Math.sin(a), s.w / 2, s.d / 2, layout.ground - 2, layout.ground + s.h, s.color, shade(s.color, 0.8));
  }
  return m.build();
}

// ── Collision ───────────────────────────────────────────────────────────────────

/** The chunk's solid triangles, world space (identical at every level of detail). */
export function chunkCollision(layout: CityLayout, content: ChunkContent): { vertices: Float32Array; indices: Uint32Array } {
  const S = new SolidBuilder();
  const g = layout.ground;
  for (const id of content.edges) {
    const e = layout.edges[id]!;
    const A = layout.nodes[e.a]!;
    const N = layout.nodes[e.b]!;
    const dx = (N.x - A.x) / e.length;
    const dz = (N.z - A.z) / e.length;
    const hw = e.halfWidth + (e.bridge !== null ? 0.8 : 0);
    const steps = e.bridge === null ? 1 : Math.max(4, Math.ceil(e.length / 6));
    for (let k = 0; k < steps; k++) {
      const s0 = (e.length * k) / steps;
      const s1 = (e.length * (k + 1)) / steps;
      const y0 = edgeHeight(layout, e, s0);
      const y1 = edgeHeight(layout, e, s1);
      const p = (s: number, o: number, y: number): V3 => [A.x + dx * s + dz * o, y, A.z + dz * s - dx * o];
      S.quad(p(s0, -hw, y0), p(s1, -hw, y1), p(s1, hw, y1), p(s0, hw, y0));
      if (e.bridge !== null && (y0 > g + 0.5 || y1 > g + 0.5)) {
        for (const o of [-hw, hw]) S.quad(p(s0, o, y0), p(s1, o, y1), p(s1, o, y1 + 1.05), p(s0, o, y0 + 1.05));
      }
    }
  }
  for (const id of content.nodes) {
    const node = layout.nodes[id]!;
    let r = 0;
    for (const e of node.edges) r = Math.max(r, layout.edges[e]!.halfWidth);
    const sides = 12;
    for (let k = 0; k < sides; k++) {
      const a0 = (k / sides) * Math.PI * 2;
      const a1 = ((k + 1) / sides) * Math.PI * 2;
      S.tri([node.x, g, node.z], [node.x + Math.cos(a1) * r * 1.12, g, node.z + Math.sin(a1) * r * 1.12], [node.x + Math.cos(a0) * r * 1.12, g, node.z + Math.sin(a0) * r * 1.12]);
    }
  }
  for (const id of content.cells) {
    const c = layout.cells[id]!;
    S.prism(c.curb, g - 0.05, g + layout.curb);
  }
  for (const id of content.buildings) {
    const b = layout.buildings[id]!;
    b.tiers.forEach((t, ti) => {
      const q = shrinkQuad(b.footprint, t.inset);
      const y0 = b.base + t.y0;
      const y1 = b.base + t.y1;
      if (ti === 0 && b.enterable && b.door !== null) {
        const top = b.base + b.groundFloor;
        // The shell: walls with a door gap, the ceiling slab; the floors above stand on it.
        for (let k = 0; k < 4; k++) {
          const a = q[k]!;
          const n = q[(k + 1) % 4]!;
          if (k !== b.front) {
            S.wall(a[0], a[1], n[0], n[1], y0, top);
            continue;
          }
          const f = faceOf(a, n);
          const c = f.length / 2;
          const w = b.door.width / 2;
          S.wall(f.ax, f.az, f.ax + f.tx * (c - w), f.az + f.tz * (c - w), y0, top);
          S.wall(f.ax + f.tx * (c + w), f.az + f.tz * (c + w), n[0], n[1], y0, top);
          S.wall(f.ax + f.tx * (c - w), f.az + f.tz * (c - w), f.ax + f.tx * (c + w), f.az + f.tz * (c + w), Math.min(y0 + 2.7, top - 0.3), top);
        }
        S.top(q, top);
        if (y1 > top + 0.01) S.prism(q, top, y1);
        return;
      }
      S.prism(q, y0, y1);
    });
  }
  for (const id of content.landmarks) {
    const l = layout.landmarks[id]!;
    const [cx, cz] = l.at;
    const ax = l.size[0] / 2 * 0.92;
    const az = l.size[1] / 2 * 0.92;
    const n = 24;
    const H = Math.max(8, l.height);
    const top = g + layout.curb;
    const at = (k: number, r: number): [number, number] => [cx + Math.cos((k / n) * Math.PI * 2) * ax * r, cz + Math.sin((k / n) * Math.PI * 2) * az * r];
    for (let k = 0; k < n; k++) {
      const a0 = at(k, 0.6);
      const b0 = at(k + 1, 0.6);
      const a1 = at(k, 1);
      const b1 = at(k + 1, 1);
      S.quad([a0[0], top + 2.5, a0[1]], [b0[0], top + 2.5, b0[1]], [b1[0], top + H, b1[1]], [a1[0], top + H, a1[1]]);
      S.wall(b0[0], b0[1], a0[0], a0[1], top, top + 2.5);
      S.wall(a1[0], a1[1], b1[0], b1[1], g, top + H + 1.5);
    }
  }
  return S.build();
}
