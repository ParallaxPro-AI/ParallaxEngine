/**
 * Smooth voxel worlds (`"mode": "smooth"`): a density lattice meshed into a smooth,
 * watertight surface, dug and filled anywhere with brushes.
 *
 * Lattice. Every integer point (x, y, z) holds a density 0..255 and a material (a block
 * index); the point is solid when density >= 128 (`ISO`). The store keeps both in its
 * chunks as one packed value, `material << 8 | density` (so smooth worlds take block
 * indices up to 255). Generated density is a signed distance in disguise: 128 + 64 · s,
 * where s is meters inside the surface (the terrain relief above the point, or the
 * distance into rock from a cave), clamped to 0..255 — a gradient of 64 per meter, so
 * the surface sits where the generator says to a few centimeters and normals are smooth.
 *
 * Meshing. Each lattice cube is split into six tetrahedra around its main diagonal
 * (Kuhn), the same way in every cube, and each tetrahedron emits the iso-surface through
 * it (one or two triangles). That is the marching-cubes family without its 256-case table
 * and its ambiguous cases: the surface is closed and manifold wherever the world is,
 * across chunk borders too (neighbouring chunks compute the same crossing points from the
 * same lattice). Vertices are welded per lattice edge; normals are the negated density
 * gradient (central differences, interpolated along the edge); triangles face out of the
 * solid; each vertex's block is the material of its edge's solid end. The chunk mesher
 * reads lattice points −1 … size + 1 of the chunk, so it takes the same neighbourhood as
 * the greedy mesher (the `voxels.march` job).
 *
 * Brushes change density smoothly: `dig` lowers points towards a sphere of air, `fill`
 * raises them towards a sphere of solid (new solid takes the brush's material). Both
 * scale by `strength` (0..1, 1 = the full sphere at once) and return how much of each
 * material changed, in solid lattice points (≈ m³).
 */

import type { VoxelSurface } from '../../services/index.js';
import type { ChunkGeometry, ChunkNeighbourhood } from './mesh.js';
import { padded } from './mesh.js';

export const ISO = 128;
/** Density units per meter of signed distance. */
export const DENSITY_PER_METER = 64;

export const pack = (material: number, density: number): number => (material << 8) | density;
export const densityOf = (value: number): number => value & 0xff;
export const materialOf = (value: number): number => value >> 8;

export function densityFromDistance(meters: number): number {
  return Math.max(0, Math.min(255, Math.round(ISO + meters * DENSITY_PER_METER)));
}

/** Corners of a cube by bit (x = 1, y = 2, z = 4) and the six Kuhn tetrahedra from corner 0 to 7. */
const TETS: readonly (readonly [number, number, number, number])[] = (() => {
  const out: [number, number, number, number][] = [];
  for (const [a, b] of [[1, 2], [1, 4], [2, 1], [2, 4], [4, 1], [4, 2]] as const) {
    out.push([0, a, a | b, 7]);
  }
  return out;
})();

/** March one chunk of a smooth world (the `voxels.march` job). */
export function marchChunk(input: ChunkNeighbourhood): ChunkGeometry {
  const n = input.size;
  // Lattice points -1 … n + 1 of the chunk on each axis.
  const low = 1;
  const p = n + 3;
  const data = padded(input, low, 2);
  const at = (x: number, y: number, z: number): number => ((y + low) * p + (z + low)) * p + (x + low);
  const density = (i: number): number => data[i]! & 0xff;
  const ox = input.cx * n;
  const oy = input.cy * n;
  const oz = input.cz * n;

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const blocks: number[] = [];
  const indices: number[] = [];
  const welded = new Map<number, number>();
  const stride = p * p * p;

  const gradient = (x: number, y: number, z: number): [number, number, number] => {
    // Central differences, clamped to the padded range at its edges.
    const gx = density(at(Math.min(x + 1, n + 1), y, z)) - density(at(Math.max(x - 1, -1), y, z));
    const gy = density(at(x, Math.min(y + 1, n + 1), z)) - density(at(x, Math.max(y - 1, -1), z));
    const gz = density(at(x, y, Math.min(z + 1, n + 1))) - density(at(x, y, Math.max(z - 1, -1)));
    return [gx, gy, gz];
  };

  /** The vertex where the surface crosses the lattice edge between local points a and b. */
  const vertex = (a: readonly [number, number, number], b: readonly [number, number, number]): number => {
    const ia = at(a[0], a[1], a[2]);
    const ib = at(b[0], b[1], b[2]);
    const key = ia < ib ? ia * stride + ib : ib * stride + ia;
    const known = welded.get(key);
    if (known !== undefined) return known;
    const da = density(ia);
    const db = density(ib);
    const t = da === db ? 0.5 : (ISO - da) / (db - da);
    const x = a[0] + (b[0] - a[0]) * t;
    const y = a[1] + (b[1] - a[1]) * t;
    const z = a[2] + (b[2] - a[2]) * t;
    const ga = gradient(a[0], a[1], a[2]);
    const gb = gradient(b[0], b[1], b[2]);
    let nx = -(ga[0] + (gb[0] - ga[0]) * t);
    let ny = -(ga[1] + (gb[1] - ga[1]) * t);
    let nz = -(ga[2] + (gb[2] - ga[2]) * t);
    const l = Math.hypot(nx, ny, nz);
    if (l > 0) {
      nx /= l;
      ny /= l;
      nz /= l;
    } else {
      // Flat density along this edge: the edge direction from solid to air.
      const s = da >= ISO ? 1 : -1;
      const ex = (b[0] - a[0]) * s;
      const ey = (b[1] - a[1]) * s;
      const ez = (b[2] - a[2]) * s;
      const el = Math.hypot(ex, ey, ez);
      nx = ex / el;
      ny = ey / el;
      nz = ez / el;
    }
    const index = positions.length / 3;
    positions.push(ox + x, oy + y, oz + z);
    normals.push(nx, ny, nz);
    uvs.push(ox + x, oz + z);
    blocks.push(data[da >= ISO ? ia : ib]! >> 8);
    welded.set(key, index);
    return index;
  };

  const corner = new Array<[number, number, number]>(8);
  const inside = new Array<boolean>(8);
  for (let y = 0; y < n; y++) {
    const wy = oy + y;
    // Cubes whose top is at or below the world floor, or bottom at or above its ceiling, hold nothing.
    if (wy + 1 < input.yMin || wy >= input.yMax) continue;
    for (let z = 0; z < n; z++) {
      for (let x = 0; x < n; x++) {
        let count = 0;
        for (let c = 0; c < 8; c++) {
          const pt: [number, number, number] = [x + (c & 1), y + ((c >> 1) & 1), z + ((c >> 2) & 1)];
          corner[c] = pt;
          inside[c] = density(at(pt[0], pt[1], pt[2])) >= ISO;
          if (inside[c]) count++;
        }
        if (count === 0 || count === 8) continue;
        for (const tet of TETS) emitTet(tet, corner, inside, vertex, positions, indices);
      }
    }
  }

  const surface: VoxelSurface = {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    blocks: new Uint16Array(blocks),
    indices: new Uint32Array(indices),
  };
  const empty: VoxelSurface = {
    positions: new Float32Array(0), normals: new Float32Array(0), uvs: new Float32Array(0), blocks: new Uint16Array(0), indices: new Uint32Array(0),
  };
  return { opaque: surface, transparent: empty, collision: { vertices: surface.positions, indices: surface.indices } };
}

function emitTet(
  tet: readonly [number, number, number, number], corner: readonly [number, number, number][], inside: readonly boolean[],
  vertex: (a: readonly [number, number, number], b: readonly [number, number, number]) => number, positions: readonly number[], indices: number[],
): void {
  const ins: number[] = [];
  const outs: number[] = [];
  for (const c of tet) (inside[c] ? ins : outs).push(c);
  if (ins.length === 0 || outs.length === 0) return;
  const v = (a: number, b: number): number => vertex(corner[a]!, corner[b]!);
  // Mean of the solid corners and of the air corners: triangles face from the first to the second.
  const mean = (list: readonly number[]): [number, number, number] => {
    const m: [number, number, number] = [0, 0, 0];
    for (const c of list) for (let k = 0; k < 3; k++) m[k]! += corner[c]![k]!;
    return [m[0] / list.length, m[1] / list.length, m[2] / list.length];
  };
  const solid = mean(ins);
  const air = mean(outs);
  const out: [number, number, number] = [air[0] - solid[0], air[1] - solid[1], air[2] - solid[2]];
  const tri = (a: number, b: number, c: number): void => {
    if (a === b || b === c || a === c) return;
    const pa = [positions[a * 3]!, positions[a * 3 + 1]!, positions[a * 3 + 2]!];
    const ab = [positions[b * 3]! - pa[0]!, positions[b * 3 + 1]! - pa[1]!, positions[b * 3 + 2]! - pa[2]!];
    const ac = [positions[c * 3]! - pa[0]!, positions[c * 3 + 1]! - pa[1]!, positions[c * 3 + 2]! - pa[2]!];
    const nx = ab[1]! * ac[2]! - ab[2]! * ac[1]!;
    const ny = ab[2]! * ac[0]! - ab[0]! * ac[2]!;
    const nz = ab[0]! * ac[1]! - ab[1]! * ac[0]!;
    if (nx * out[0] + ny * out[1] + nz * out[2] >= 0) indices.push(a, b, c);
    else indices.push(a, c, b);
  };
  if (ins.length === 1 || outs.length === 1) {
    const [lone, others] = ins.length === 1 ? [ins[0]!, outs] : [outs[0]!, ins];
    tri(v(lone, others[0]!), v(lone, others[1]!), v(lone, others[2]!));
    return;
  }
  // Two and two: a quad through the four crossing edges, in cyclic order.
  const [a, b] = ins as [number, number];
  const [c, d] = outs as [number, number];
  const q0 = v(a, c);
  const q1 = v(a, d);
  const q2 = v(b, d);
  const q3 = v(b, c);
  tri(q0, q1, q2);
  tri(q0, q2, q3);
}

/** Trilinear density at a world point, 0..255 (`sample(x, y, z)` reads one lattice point). */
export function densityAtPoint(sample: (x: number, y: number, z: number) => number, x: number, y: number, z: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const fx = x - x0;
  const fy = y - y0;
  const fz = z - z0;
  let sum = 0;
  for (let c = 0; c < 8; c++) {
    const dx = c & 1;
    const dy = (c >> 1) & 1;
    const dz = (c >> 2) & 1;
    const w = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
    if (w !== 0) sum += w * sample(x0 + dx, y0 + dy, z0 + dz);
  }
  return sum;
}

/**
 * Lattice points a sphere brush touches and their new values. `dig`: the target is air
 * inside the sphere (density falls to `densityFromDistance(dist - radius)`); `fill`: solid
 * inside (rises to `densityFromDistance(radius - dist)`, taking `material`). The change is
 * scaled by `strength`. Calls `write(x, y, z, packed)` only where the value changes and
 * returns the solid amount (density / 255) removed or added per material.
 */
export function brush(
  read: (x: number, y: number, z: number) => number, write: (x: number, y: number, z: number, packed: number) => void,
  center: readonly [number, number, number], radius: number, strength: number, mode: 'dig' | 'fill', material: number,
  yMin: number, yMax: number,
): Map<number, number> {
  const changed = new Map<number, number>();
  const reach = radius + 2;
  const [cx, cy, cz] = center;
  for (let y = Math.max(yMin, Math.floor(cy - reach)); y <= Math.min(yMax - 1, Math.ceil(cy + reach)); y++) {
    for (let z = Math.floor(cz - reach); z <= Math.ceil(cz + reach); z++) {
      for (let x = Math.floor(cx - reach); x <= Math.ceil(cx + reach); x++) {
        const dist = Math.hypot(x - cx, y - cy, z - cz);
        const value = read(x, y, z);
        const d = value & 0xff;
        const m = value >> 8;
        let next: number;
        let nextMaterial = m;
        if (mode === 'dig') {
          const target = densityFromDistance(dist - radius);
          if (target >= d) continue;
          next = Math.round(d + (target - d) * strength);
        } else {
          const target = densityFromDistance(radius - dist);
          if (target <= d) continue;
          next = Math.round(d + (target - d) * strength);
          // New solid, or air the brush thickens, takes the brush's material.
          if (d < ISO) nextMaterial = material;
        }
        if (next === d && nextMaterial === m) continue;
        write(x, y, z, pack(nextMaterial, next));
        const key = mode === 'dig' ? m : nextMaterial;
        changed.set(key, (changed.get(key) ?? 0) + Math.abs(next - d) / 255);
      }
    }
  }
  return changed;
}
