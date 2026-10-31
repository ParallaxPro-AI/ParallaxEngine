/**
 * Greedy meshing of one chunk into the service's `VoxelChunkMesh` surfaces (see
 * function/services/voxels.ts for the face rules, winding and uv convention). The input
 * is plain data — the chunk and its 26 neighbours, the world's y range and the block
 * types — so the same pure function runs inline or as the `voxels.mesh` job. The chunk
 * is copied with a one-block border from its neighbours, so faces on chunk edges are
 * decided exactly like interior ones.
 */

import type { VoxelBlockType, VoxelSurface } from '../../services/index.js';
import { AIR } from './blocks.js';

/**
 * One chunk to mesh and everything meshing reads: structured-cloneable. `around` holds the
 * 27 chunks (dy, dz, dx order from -1 to 1; index 13 is the chunk itself), null where a
 * chunk lies wholly above or below the world. Values are block indices (block worlds) or
 * packed `material << 8 | density` (smooth worlds).
 */
export interface ChunkNeighbourhood {
  readonly size: number;
  readonly yMin: number;
  readonly yMax: number;
  readonly types: readonly (VoxelBlockType | undefined)[];
  readonly around: readonly (Uint16Array | null)[];
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
}

/** What a neighbourhood is copied from (the plugin's store). */
export interface ChunkSource {
  readonly size: number;
  readonly yMin: number;
  readonly yMax: number;
  readonly types: readonly (VoxelBlockType | undefined)[];
  chunk(cx: number, cy: number, cz: number): Uint16Array;
}

export function neighbourhoodOf(source: ChunkSource, cx: number, cy: number, cz: number): ChunkNeighbourhood {
  const n = source.size;
  const around: (Uint16Array | null)[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const y0 = (cy + dy) * n;
        around.push(y0 + n <= source.yMin || y0 >= source.yMax ? null : source.chunk(cx + dx, cy + dy, cz + dz));
      }
    }
  }
  return { size: n, yMin: source.yMin, yMax: source.yMax, types: source.types, around, cx, cy, cz };
}

export interface ChunkGeometry {
  readonly opaque: VoxelSurface;
  readonly transparent: VoxelSurface;
  readonly collision: { readonly vertices: Float32Array; readonly indices: Uint32Array };
}

class SurfaceBuilder {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly uvs: number[] = [];
  readonly blocks: number[] = [];
  readonly indices: number[] = [];

  /** Four corners counter-clockwise seen from the side the normal points to. */
  quad(corners: readonly number[], normal: readonly number[], w: number, h: number, block: number): void {
    const base = this.positions.length / 3;
    this.positions.push(...corners);
    for (let i = 0; i < 4; i++) {
      this.normals.push(normal[0]!, normal[1]!, normal[2]!);
      this.blocks.push(block);
    }
    this.uvs.push(0, 0, w, 0, w, h, 0, h);
    this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  build(): VoxelSurface {
    return {
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      uvs: new Float32Array(this.uvs),
      blocks: new Uint16Array(this.blocks),
      indices: new Uint32Array(this.indices),
    };
  }

  get empty(): boolean { return this.indices.length === 0; }
}

/**
 * The chunk plus a border of `low` blocks below and `high` above on each axis from its
 * neighbours, `[((y + low) * p + (z + low)) * p + (x + low)]` with p = size + low + high.
 * Outside the world's y range everything is 0.
 */
export function padded(input: ChunkNeighbourhood, low = 1, high = 1): Uint16Array {
  const { size: n, cy, around } = input;
  const p = n + low + high;
  const out = new Uint16Array(p * p * p);
  // For padded coordinate q: which neighbour (0, 1, 2) and the coordinate inside it.
  const side = new Int32Array(p);
  const local = new Int32Array(p);
  for (let q = 0; q < p; q++) {
    const v = q - low;
    side[q] = v < 0 ? 0 : v >= n ? 2 : 1;
    local[q] = v < 0 ? v + n : v >= n ? v - n : v;
  }
  let at = 0;
  for (let qy = 0; qy < p; qy++) {
    const wy = cy * n + qy - low;
    const inWorld = wy >= input.yMin && wy < input.yMax;
    for (let qz = 0; qz < p; qz++) {
      const row = (side[qy]! * 3 + side[qz]!) * 3;
      const offset = (local[qy]! * n + local[qz]!) * n;
      for (let qx = 0; qx < p; qx++, at++) {
        const chunk = around[row + side[qx]!]!;
        out[at] = chunk === null || !inWorld ? AIR : chunk[offset + local[qx]!]!;
      }
    }
  }
  return out;
}

/** Whether a chunk holds only air (its own faces and colliders are empty). */
export function chunkIsAir(source: ChunkSource, cx: number, cy: number, cz: number): boolean {
  return source.chunk(cx, cy, cz).every((b) => b === AIR);
}

/** Greedy-mesh a block world's chunk (the `voxels.mesh` job). */
export function meshChunk(input: ChunkNeighbourhood): ChunkGeometry {
  const { size: n, cx, cy, cz } = input;
  const p = n + 2;
  const types = input.types;
  // Per block index: 1 = drawn as faces, 2 = transparent, 4 = solid.
  const flags = new Uint8Array(types.length);
  types.forEach((type, b) => {
    if (type === undefined) return;
    flags[b] = (type.prefabRenders ? 0 : 1) | (type.transparent ? 2 : 0) | (type.solid ? 4 : 0);
  });
  const data = padded(input);

  const opaque = new SurfaceBuilder();
  const empty = (): ChunkGeometry => {
    const none = opaque.build();
    return { opaque: none, transparent: none, collision: { vertices: none.positions, indices: none.indices } };
  };
  // Buried: every block here and around is drawn, opaque and solid, so no face shows.
  if (data.every((b) => flags[b] === 5)) return empty();
  const clear = new SurfaceBuilder();
  const collision = new SurfaceBuilder();
  const origin = [cx * n, cy * n, cz * n];
  const mask = new Int32Array(n * n);
  const solidMask = new Int32Array(n * n);
  // Index strides of x, y, z in the padded array.
  const stride = [1, p * p, p];
  const base = (p + 1) * p + 1;

  for (let a = 0; a < 3; a++) {
    const u = (a + 1) % 3;
    const v = (a + 2) % 3;
    const sa = stride[a]!;
    const su = stride[u]!;
    const sv = stride[v]!;
    for (const s of [1, -1]) {
      const normal = [0, 0, 0];
      normal[a] = s;
      const toOther = s * sa;
      for (let i = 0; i < n; i++) {
        if (!sliceMasks(data, flags, n, base + i * sa, su, sv, toOther, mask, solidMask)) continue;
        const plane = i + (s > 0 ? 1 : 0);
        const emit = (target: SurfaceBuilder, k0: number, j0: number, w: number, h: number, code: number): void => {
          const corners: number[] = [];
          for (const [du, dv] of [[0, 0], [w, 0], [w, h], [0, h]] as const) {
            const c = [0, 0, 0];
            c[a] = origin[a]! + plane;
            c[u] = origin[u]! + k0 + du;
            c[v] = origin[v]! + j0 + dv;
            corners.push(c[0]!, c[1]!, c[2]!);
          }
          if (s < 0) {
            // Reverse the winding: (0, 3, 2, 1) keeps corner 0 and turns the quad over.
            const flipped = [...corners.slice(0, 3), ...corners.slice(9, 12), ...corners.slice(6, 9), ...corners.slice(3, 6)];
            target.quad(flipped, normal, h, w, code);
          } else {
            target.quad(corners, normal, w, h, code);
          }
        };
        greedy(mask, n, (k0, j0, w, h, code) => emit((flags[code]! & 2) !== 0 ? clear : opaque, k0, j0, w, h, code));
        greedy(solidMask, n, (k0, j0, w, h) => emit(collision, k0, j0, w, h, 0));
      }
    }
  }
  const col = collision.build();
  return { opaque: opaque.build(), transparent: clear.build(), collision: { vertices: col.positions, indices: col.indices } };
}

/**
 * One slice's face masks: `mask` gets the block index of each visible face (0: none),
 * `solidMask` 1 where a solid block meets a non-solid one. Returns whether any is set.
 * Flags per block: 1 drawn as faces, 2 transparent, 4 solid.
 */
function sliceMasks(
  data: Uint16Array, flags: Uint8Array, n: number, start: number, su: number, sv: number, toOther: number,
  mask: Int32Array, solidMask: Int32Array,
): boolean {
  let any = false;
  for (let j = 0; j < n; j++) {
    let at = start + j * sv;
    for (let k = 0; k < n; k++, at += su) {
      const b = data[at]!;
      const cell = j * n + k;
      if (b === AIR) { mask[cell] = 0; solidMask[cell] = 0; continue; }
      const other = data[at + toOther]!;
      const fb = flags[b]!;
      const fo = other === AIR ? 0 : flags[other]!;
      // Drawn, and the neighbour is neither a drawn opaque block nor the same transparent block.
      const face = (fb & 1) !== 0 && (fo & 3) !== 1 && !(other === b && (fb & 2) !== 0) ? b : 0;
      const solid = (fb & 4) !== 0 && (fo & 4) === 0 ? 1 : 0;
      mask[cell] = face;
      solidMask[cell] = solid;
      if (face !== 0 || solid !== 0) any = true;
    }
  }
  return any;
}

/** Merge equal non-zero cells of an n × n mask into rectangles (consumes the mask). */
function greedy(mask: Int32Array, n: number, emit: (k: number, j: number, w: number, h: number, code: number) => void): void {
  for (let j = 0; j < n; j++) {
    for (let k = 0; k < n;) {
      const code = mask[j * n + k]!;
      if (code === 0) { k++; continue; }
      let w = 1;
      while (k + w < n && mask[j * n + k + w] === code) w++;
      let h = 1;
      grow: while (j + h < n) {
        for (let x = 0; x < w; x++) if (mask[(j + h) * n + k + x] !== code) break grow;
        h++;
      }
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) mask[(j + y) * n + k + x] = 0;
      emit(k, j, w, h, code);
      k += w;
    }
  }
}
