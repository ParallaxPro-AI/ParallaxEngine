/**
 * CDLOD tile selection (continuous distance-dependent level of detail, after Strugar
 * 2009): walk the tile quadtree from its roots; a tile is drawn at its own level unless the
 * next finer level's range reaches it, in which case its four children are walked instead.
 * The result is rings of levels around the cameras — finest nearest — that partition the
 * ground with no gaps or overlaps, and each tile's morph window (the last stretch of its
 * level's range) over which a surface blends it into its parent level.
 *
 * Streaming: a finer tile that isn't baked yet is not waited for; its parent is drawn
 * whole in its place (never part parent, part children), so the ground never has holes.
 *
 * Several cameras (split screen): a tile splits if any camera's range reaches it and is
 * kept if any camera's frustum sees it.
 */

import type { Mat4 } from '../../../core/index.js';

/** Plane n·p + d >= 0 inside. */
export interface Plane {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly d: number;
}

/** The six frustum planes of a column-major view-projection with clip z in 0..1. */
export function frustumPlanes(m: Mat4): Plane[] {
  const row = (r: number): [number, number, number, number] => [m[r]!, m[4 + r]!, m[8 + r]!, m[12 + r]!];
  const [r0, r1, r2, r3] = [row(0), row(1), row(2), row(3)];
  const combos: [number, number, number, number][] = [
    [r3[0] + r0[0], r3[1] + r0[1], r3[2] + r0[2], r3[3] + r0[3]],
    [r3[0] - r0[0], r3[1] - r0[1], r3[2] - r0[2], r3[3] - r0[3]],
    [r3[0] + r1[0], r3[1] + r1[1], r3[2] + r1[2], r3[3] + r1[3]],
    [r3[0] - r1[0], r3[1] - r1[1], r3[2] - r1[2], r3[3] - r1[3]],
    [r2[0], r2[1], r2[2], r2[3]],
    [r3[0] - r2[0], r3[1] - r2[1], r3[2] - r2[2], r3[3] - r2[3]],
  ];
  return combos.map(([a, b, c, d]) => {
    const l = Math.hypot(a, b, c) || 1;
    return { nx: a / l, ny: b / l, nz: c / l, d: d / l };
  });
}

/** Whether an axis-aligned box is at least partly inside the planes. */
export function boxInPlanes(planes: readonly Plane[], minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): boolean {
  for (const p of planes) {
    const x = p.nx >= 0 ? maxX : minX;
    const y = p.ny >= 0 ? maxY : minY;
    const z = p.nz >= 0 ? maxZ : minZ;
    if (p.nx * x + p.ny * y + p.nz * z + p.d < 0) return false;
  }
  return true;
}

/** Morph window of tiles that never morph (finite, so shaders divide safely). */
export const NO_MORPH = 1e9;

export interface TileSource<T> {
  readonly levels: number;
  readonly originX: number;
  readonly originZ: number;
  /** Size of a level-0 tile, meters (each level doubles it). */
  readonly leafSize: number;
  /** Extent of the ground: tiles wholly outside it are skipped. */
  readonly width: number;
  readonly depth: number;
  /** Height bounds for culling a tile that isn't baked yet. */
  readonly minHeight: number;
  readonly maxHeight: number;
  /** The tile when baked (and asks for it when not). */
  get(level: number, ix: number, iz: number): T | null;
  bounds(tile: T): { readonly minHeight: number; readonly maxHeight: number };
}

export interface Selected<T> {
  readonly tile: T;
  readonly level: number;
  readonly ix: number;
  readonly iz: number;
  readonly morphStart: number;
  readonly morphEnd: number;
}

export interface SelectOptions {
  /** Camera positions (one per view). */
  readonly cameras: readonly (readonly [number, number, number])[];
  /** Each view's frustum (any one seeing a tile keeps it). */
  readonly frusta: readonly (readonly Plane[])[];
  /** Range of level L = rangeScale · tile size at level L (≥ 2 keeps rings at most one level apart). */
  readonly rangeScale: number;
  /** Fraction of each range over which tiles morph into their parent level. */
  readonly morphFraction: number;
}

/** Distance from a point to a box (0 inside). */
function boxDistance(c: readonly [number, number, number], minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): number {
  const dx = c[0] < minX ? minX - c[0] : c[0] > maxX ? c[0] - maxX : 0;
  const dy = c[1] < minY ? minY - c[1] : c[1] > maxY ? c[1] - maxY : 0;
  const dz = c[2] < minZ ? minZ - c[2] : c[2] > maxZ ? c[2] - maxZ : 0;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function selectTiles<T>(source: TileSource<T>, options: SelectOptions): Selected<T>[] {
  const out: Selected<T>[] = [];
  const top = source.levels - 1;
  const rootSize = source.leafSize * 2 ** top;
  const rootsX = Math.max(1, Math.ceil(source.width / rootSize - 1e-9));
  const rootsZ = Math.max(1, Math.ceil(source.depth / rootSize - 1e-9));
  const range = (level: number): number => options.rangeScale * source.leafSize * 2 ** level;

  const visible = (minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): boolean =>
    options.frusta.length === 0 || options.frusta.some((planes) => boxInPlanes(planes, minX, minY, minZ, maxX, maxY, maxZ));

  /** Selected tiles for a node, or null when something it needs isn't baked (the caller draws itself instead). */
  const walk = (level: number, ix: number, iz: number, into: Selected<T>[]): boolean => {
    const size = source.leafSize * 2 ** level;
    const minX = source.originX + ix * size;
    const minZ = source.originZ + iz * size;
    if (minX >= source.originX + source.width || minZ >= source.originZ + source.depth) return true;
    const maxX = minX + size;
    const maxZ = minZ + size;
    const tile = source.get(level, ix, iz);
    const b = tile === null ? { minHeight: source.minHeight, maxHeight: source.maxHeight } : source.bounds(tile);
    if (!visible(minX, b.minHeight, minZ, maxX, b.maxHeight, maxZ)) return true;
    let split = false;
    if (level > 0) {
      const finer = range(level - 1);
      for (const c of options.cameras) {
        if (boxDistance(c, minX, b.minHeight, minZ, maxX, b.maxHeight, maxZ) < finer) {
          split = true;
          break;
        }
      }
    }
    if (split) {
      const children: Selected<T>[] = [];
      let complete = true;
      // Every child is asked for (so all four stream in together), even after one is missing.
      for (let k = 0; k < 4; k++) if (!walk(level - 1, ix * 2 + (k & 1), iz * 2 + (k >> 1), children)) complete = false;
      if (complete) {
        into.push(...children);
        return true;
      }
    }
    if (tile === null) return false;
    // The top level has no parent to morph into: its window starts past any view.
    const end = level === top ? NO_MORPH : range(level);
    into.push({ tile, level, ix, iz, morphStart: level === top ? NO_MORPH : end * (1 - options.morphFraction), morphEnd: end });
    return true;
  };

  for (let iz = 0; iz < rootsZ; iz++) for (let ix = 0; ix < rootsX; ix++) walk(top, ix, iz, out);
  return out;
}
