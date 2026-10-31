/**
 * One scene's voxel world: chunks filled on first use from the generator (or air), with
 * the run's edits — a diff against the generated world — laid over them. Edits are kept
 * per chunk; an edit back to the generated block removes the entry, so the diff stays
 * minimal and a save holds only what the player changed. Values are block indices, or in
 * smooth worlds packed `material << 8 | density` (smooth.ts); the block-world queries
 * here (`surfaceHeight`, `raycast`) are for block worlds.
 */

import { fail } from '../../../core/index.js';
import { AIR } from './blocks.js';
import type { BlockTable } from './blocks.js';
import type { VoxelBlockType } from '../../services/index.js';

/** What fills chunks: a pure function of the cell (`Landscape`, or `SmoothLandscape` for packed smooth values). */
export interface ChunkGenerator {
  fill(x0: number, y0: number, z0: number, size: number, out: Uint16Array): void;
  blockAt(x: number, y: number, z: number): number;
}

/** Edits of one scene: chunk key → (local index → block index). */
export type SceneEdits = Map<string, Map<number, number>>;

export interface RayHit {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Unit normal of the face entered (all zero components but one). */
  readonly face: readonly [number, number, number];
  readonly block: number;
  readonly distance: number;
}

export function chunkKey(cx: number, cy: number, cz: number): string {
  return `${cx},${cy},${cz}`;
}

export class VoxelStore {
  readonly size: number;
  readonly yMin: number;
  readonly yMax: number;
  readonly blocks: BlockTable;
  readonly #generator: ChunkGenerator | undefined;
  readonly #edits: SceneEdits;
  readonly #chunks = new Map<string, Uint16Array>();
  readonly #changed: (x: number, y: number, z: number) => void;

  constructor(init: {
    readonly size: number; readonly yMin: number; readonly yMax: number; readonly blocks: BlockTable;
    readonly generator: ChunkGenerator | undefined; readonly edits: SceneEdits; readonly changed: (x: number, y: number, z: number) => void;
  }) {
    this.size = init.size;
    this.yMin = init.yMin;
    this.yMax = init.yMax;
    this.blocks = init.blocks;
    this.#generator = init.generator;
    this.#edits = init.edits;
    this.#changed = init.changed;
  }

  get types(): readonly (VoxelBlockType | undefined)[] { return this.blocks.types; }

  inRange(y: number): boolean {
    return y >= this.yMin && y < this.yMax;
  }

  /** The chunk's blocks, `[(ly * size + lz) * size + lx]`, generated and edited. */
  chunk(cx: number, cy: number, cz: number): Uint16Array {
    const key = chunkKey(cx, cy, cz);
    let data = this.#chunks.get(key);
    if (data === undefined) {
      const n = this.size;
      data = new Uint16Array(n * n * n);
      // Without a generator the world starts as air (zeros).
      this.#generator?.fill(cx * n, cy * n, cz * n, n, data);
      for (const [index, block] of this.#edits.get(key) ?? []) data[index] = block;
      this.#chunks.set(key, data);
    }
    return data;
  }

  blockAt(x: number, y: number, z: number): number {
    if (!this.inRange(y)) return AIR;
    const n = this.size;
    const cx = Math.floor(x / n);
    const cy = Math.floor(y / n);
    const cz = Math.floor(z / n);
    return this.chunk(cx, cy, cz)[((y - cy * n) * n + (z - cz * n)) * n + (x - cx * n)]!;
  }

  generatedAt(x: number, y: number, z: number): number {
    return this.#generator === undefined || !this.inRange(y) ? AIR : this.#generator.blockAt(x, y, z);
  }

  /** Write a block (an edit); `y` must be in range. Returns the previous block. */
  setBlock(x: number, y: number, z: number, block: number): number {
    if (!this.inRange(y)) {
      fail('PP3623', `Block y ${y} is outside this world's y_range [${this.yMin}, ${this.yMax})`, {
        fix: 'Keep edits inside the scene\'s "voxels" y_range, or widen it.',
      });
    }
    const n = this.size;
    const cx = Math.floor(x / n);
    const cy = Math.floor(y / n);
    const cz = Math.floor(z / n);
    const key = chunkKey(cx, cy, cz);
    const index = ((y - cy * n) * n + (z - cz * n)) * n + (x - cx * n);
    const data = this.chunk(cx, cy, cz);
    const old = data[index]!;
    if (old === block) return old;
    data[index] = block;
    let edits = this.#edits.get(key);
    if (block === this.generatedAt(x, y, z)) {
      edits?.delete(index);
      if (edits?.size === 0) this.#edits.delete(key);
    } else {
      if (edits === undefined) this.#edits.set(key, edits = new Map());
      edits.set(index, block);
    }
    this.#changed(x, y, z);
    return old;
  }

  /** One above the highest solid block in the column; `yMin` when it has none. */
  surfaceHeight(x: number, z: number): number {
    for (let y = this.yMax - 1; y >= this.yMin; y--) if (this.blocks.solid(this.blockAt(x, y, z))) return y + 1;
    return this.yMin;
  }

  /**
   * What the block raycast stops at: solid blocks and blocks drawn by a prefab (torches,
   * crops, open doors) — not air, and not non-solid blocks without a prefab (water).
   */
  targetable(block: number): boolean {
    if (block === AIR) return false;
    const type = this.blocks.type(block);
    return type.solid || type.prefab !== null || type.prefabRenders;
  }

  /**
   * Walk the cells along a ray (Amanatides–Woo) up to `maxDistance` meters; the first
   * targetable block wins. A ray starting inside one hits it at distance 0, through the
   * face opposite its main direction.
   */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDistance: number): RayHit | undefined {
    let x = Math.floor(ox);
    let y = Math.floor(oy);
    let z = Math.floor(oz);
    const stepX = Math.sign(dx);
    const stepY = Math.sign(dy);
    const stepZ = Math.sign(dz);
    const next = (cell: number, o: number, d: number, step: number): number => (d === 0 ? Infinity : (cell + (step > 0 ? 1 : 0) - o) / d);
    let tX = next(x, ox, dx, stepX);
    let tY = next(y, oy, dy, stepY);
    let tZ = next(z, oz, dz, stepZ);
    const deltaX = dx === 0 ? Infinity : Math.abs(1 / dx);
    const deltaY = dy === 0 ? Infinity : Math.abs(1 / dy);
    const deltaZ = dz === 0 ? Infinity : Math.abs(1 / dz);

    const first = this.blockAt(x, y, z);
    if (this.targetable(first)) {
      const ax = Math.abs(dx);
      const ay = Math.abs(dy);
      const az = Math.abs(dz);
      const face: [number, number, number] = ax >= ay && ax >= az ? [-stepX, 0, 0] : ay >= az ? [0, -stepY, 0] : [0, 0, -stepZ];
      return { x, y, z, face, block: first, distance: 0 };
    }
    for (;;) {
      let t: number;
      let face: [number, number, number];
      if (tX <= tY && tX <= tZ) {
        t = tX; x += stepX; tX += deltaX; face = [-stepX, 0, 0];
      } else if (tY <= tZ) {
        t = tY; y += stepY; tY += deltaY; face = [0, -stepY, 0];
      } else {
        t = tZ; z += stepZ; tZ += deltaZ; face = [0, 0, -stepZ];
      }
      if (t > maxDistance) return undefined;
      // Leaving the world vertically: nothing more to hit.
      if ((y < this.yMin && stepY <= 0) || (y >= this.yMax && stepY >= 0)) return undefined;
      const block = this.blockAt(x, y, z);
      if (this.targetable(block)) return { x, y, z, face, block, distance: t };
    }
  }

  /** Every edit as world cells, sorted by (x, y, z). */
  edits(): Array<[number, number, number, number]> {
    return exportEdits(this.#edits, this.size);
  }
}

/** A scene's edits as `[x, y, z, block]`, sorted by x, then y, then z. */
export function exportEdits(edits: SceneEdits, size: number): Array<[number, number, number, number]> {
  const out: Array<[number, number, number, number]> = [];
  for (const [key, cells] of edits) {
    const [cx, cy, cz] = key.split(',').map(Number) as [number, number, number];
    for (const [index, block] of cells) {
      const lx = index % size;
      const lz = Math.floor(index / size) % size;
      const ly = Math.floor(index / (size * size));
      out.push([cx * size + lx, cy * size + ly, cz * size + lz, block]);
    }
  }
  return out.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
}

/** Put one world-cell edit into a scene's edit map. */
export function addEdit(edits: SceneEdits, size: number, x: number, y: number, z: number, block: number): void {
  const cx = Math.floor(x / size);
  const cy = Math.floor(y / size);
  const cz = Math.floor(z / size);
  const key = chunkKey(cx, cy, cz);
  let cells = edits.get(key);
  if (cells === undefined) edits.set(key, cells = new Map());
  cells.set(((y - cy * size) * size + (z - cz * size)) * size + (x - cx * size), block);
}
