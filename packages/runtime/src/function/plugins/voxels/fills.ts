/**
 * Authored boxes laid over the generated world (the scene block's `"fills"`, spec.ts): each
 * fill sets every cell of an axis-aligned box of cells to one block, or to air (`null`), in
 * list order, so a later fill wins where two overlap. They are part of the generated world,
 * not edits: a save holds only what the player changed afterwards, and an edit back to a
 * filled block removes the edit. Like the landscape, a pure function of the cell, so a chunk
 * filled whole and a single cell asked alone agree.
 */

import { AIR } from './blocks.js';
import type { ChunkGenerator } from './store.js';

/** One box of cells, corners inclusive (min ≤ max on every axis). */
export interface VoxelFill {
  /** Block index; 0 (AIR) carves. */
  readonly block: number;
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

export class FilledWorld implements ChunkGenerator {
  readonly #base: ChunkGenerator | undefined;
  readonly #fills: readonly VoxelFill[];
  readonly #yMin: number;
  readonly #yMax: number;

  constructor(base: ChunkGenerator | undefined, fills: readonly VoxelFill[], yMin: number, yMax: number) {
    this.#base = base;
    this.#fills = fills;
    this.#yMin = yMin;
    this.#yMax = yMax;
  }

  blockAt(x: number, y: number, z: number): number {
    if (y < this.#yMin || y >= this.#yMax) return AIR;
    for (let i = this.#fills.length - 1; i >= 0; i--) {
      const f = this.#fills[i]!;
      if (x >= f.min[0] && x <= f.max[0] && y >= f.min[1] && y <= f.max[1] && z >= f.min[2] && z <= f.max[2]) return f.block;
    }
    return this.#base === undefined ? AIR : this.#base.blockAt(x, y, z);
  }

  fill(x0: number, y0: number, z0: number, size: number, out: Uint16Array): void {
    if (this.#base !== undefined) this.#base.fill(x0, y0, z0, size, out);
    else out.fill(AIR);
    const yLo = Math.max(y0, this.#yMin);
    const yHi = Math.min(y0 + size - 1, this.#yMax - 1);
    for (const f of this.#fills) {
      const ax = Math.max(f.min[0], x0);
      const bx = Math.min(f.max[0], x0 + size - 1);
      const ay = Math.max(f.min[1], yLo);
      const by = Math.min(f.max[1], yHi);
      const az = Math.max(f.min[2], z0);
      const bz = Math.min(f.max[2], z0 + size - 1);
      if (ax > bx || ay > by || az > bz) continue;
      for (let y = ay; y <= by; y++) {
        for (let z = az; z <= bz; z++) {
          const row = ((y - y0) * size + (z - z0)) * size - x0;
          for (let x = ax; x <= bx; x++) out[row + x] = f.block;
        }
      }
    }
  }
}
