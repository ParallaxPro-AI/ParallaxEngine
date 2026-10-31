/**
 * Procedural rocks, after the platform engine's rock mesher: an icosphere whose every
 * vertex is pushed out along its own direction to a rock-shaped surface, so the mesh is
 * closed, welded and its vertex count known up front.
 *
 * The surface is star-shaped about the origin: an ellipsoid cut by a handful of hashed
 * planes (the flat fractured faces a real boulder has; a slab gets near-horizontal cuts,
 * so it reads as bedded stone), roughened by two octaves of value noise, with its bottom
 * flattened and sunk a little into the ground. Normals are averaged over the welded faces
 * (smooth across weathered faces, split along fracture creases); vertex colors
 * carry crevice darkening (vertices sitting inside their neighbours' average), a broad
 * mottling, patchy moss and pale lichen flecks on up-facing stone, and dirt splashed up the
 * base. About a quarter of the stone is buried. A fine noise octave chips the near mesh
 * into sub-facets; the material adds a world-projected (triplanar) grain texture, since a
 * rock has no uvs.
 *
 * Detail 0: 4 subdivisions (5120 triangles); detail 1: 2 (320).
 */

import { hash2 } from '../../../core/index.js';
import { add, clamp, cross, dot, MeshBuilder, normalize, scale, Stream, sub } from './foliage_gen.js';
import type { Vec3 } from './foliage_gen.js';

export interface RockSpec {
  /** Half-extents at scale 1. */
  readonly size: Vec3;
  /** Plane cuts and how deep they bite (0..1 of the radius). */
  readonly cuts: number;
  readonly depth: number;
  /** 0: cuts face any way; 1: cuts are near-horizontal (bedded slabs). */
  readonly bedded: number;
  readonly rough: number;
}

export const ROCK_SPECS: Readonly<Record<string, RockSpec>> = {
  'rock:boulder': { size: [0.95, 0.8, 0.9], cuts: 12, depth: 0.3, bedded: 0, rough: 0.07 },
  'rock:slab': { size: [1.25, 0.38, 1.0], cuts: 10, depth: 0.26, bedded: 0.8, rough: 0.05 },
};

const PHI = (1 + Math.sqrt(5)) / 2;
/** cos of the angle past which a corner keeps its face's normal (about 15°: half a fracture edge's dihedral). */
const CREASE = 0.965;

/** A unit icosphere: welded vertices and triangles. */
export function icosphere(subdivisions: number): { readonly dirs: Vec3[]; readonly tris: number[] } {
  const dirs: Vec3[] = [
    [-1, PHI, 0], [1, PHI, 0], [-1, -PHI, 0], [1, -PHI, 0], [0, -1, PHI], [0, 1, PHI],
    [0, -1, -PHI], [0, 1, -PHI], [PHI, 0, -1], [PHI, 0, 1], [-PHI, 0, -1], [-PHI, 0, 1],
  ].map((v) => normalize(v));
  let tris = [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
    3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1];
  for (let level = 0; level < subdivisions; level++) {
    const mid = new Map<number, number>();
    const midpoint = (a: number, b: number): number => {
      const key = a < b ? a * 100003 + b : b * 100003 + a;
      let m = mid.get(key);
      if (m === undefined) {
        m = dirs.length;
        dirs.push(normalize(add(dirs[a]!, dirs[b]!)));
        mid.set(key, m);
      }
      return m;
    };
    const next: number[] = [];
    for (let i = 0; i < tris.length; i += 3) {
      const a = tris[i]!;
      const b = tris[i + 1]!;
      const c = tris[i + 2]!;
      const ab = midpoint(a, b);
      const bc = midpoint(b, c);
      const ca = midpoint(c, a);
      next.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
    }
    tris = next;
  }
  return { dirs, tris };
}

/** Value noise on the unit sphere's 3-D lattice, 0..1. */
function noise3(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const f = (t: number): number => t * t * (3 - 2 * t);
  const fx = f(x - ix);
  const fy = f(y - iy);
  const fz = f(z - iz);
  const h = (a: number, b: number, c: number): number => hash2(a + Math.imul(c, 7919), b, seed);
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
  const x00 = lerp(h(ix, iy, iz), h(ix + 1, iy, iz), fx);
  const x10 = lerp(h(ix, iy + 1, iz), h(ix + 1, iy + 1, iz), fx);
  const x01 = lerp(h(ix, iy, iz + 1), h(ix + 1, iy, iz + 1), fx);
  const x11 = lerp(h(ix, iy + 1, iz + 1), h(ix + 1, iy + 1, iz + 1), fx);
  return lerp(lerp(x00, x10, fy), lerp(x01, x11, fy), fz);
}

export function meshRock(spec: RockSpec, seed: number, detail: 0 | 1): MeshBuilder {
  const { dirs, tris } = icosphere(detail === 0 ? 4 : 2);
  const st = new Stream(seed, 0x524f434b);
  const [sx, sy, sz] = spec.size.map((v) => v * (0.85 + 0.3 * st.next())) as Vec3;
  const cuts: { n: Vec3; d: number }[] = [];
  for (let i = 0; i < spec.cuts; i++) {
    const a = st.next() * Math.PI * 2;
    const tilt = spec.bedded > 0 && i % 2 === 0 ? (1 - spec.bedded) * st.next() * 1.2 : 0.25 + st.next() * 1.2;
    const up = i % 4 === 3 ? -1 : 1;
    const n = normalize([Math.sin(tilt) * Math.cos(a), Math.cos(tilt) * up, Math.sin(tilt) * Math.sin(a)]);
    cuts.push({ n, d: 1 - spec.depth * (0.4 + 0.6 * st.next()) });
  }
  // Radius along each direction: the ellipsoid, then the nearest plane cut, then noise.
  const pos: Vec3[] = dirs.map((u) => {
    const e: Vec3 = [u[0] * sx, u[1] * sy, u[2] * sz];
    // Cuts live in the ellipsoid's unit space, where this ray is just `u`.
    let r = 1;
    for (const c of cuts) {
      const k = dot(u, c.n);
      if (k > 1e-3) r = Math.min(r, c.d / k);
    }
    r = Math.max(r, 0.55);
    const n1 = noise3(u[0] * 2.2 + 11, u[1] * 2.2, u[2] * 2.2, seed) - 0.5;
    const n2 = noise3(u[0] * 6 + 3, u[1] * 6, u[2] * 6, seed + 1) - 0.5;
    // A fine octave (sub-facets and chips) the near mesh resolves; the mid mesh averages it out.
    const n3 = noise3(u[0] * 13 + 5, u[1] * 13, u[2] * 13, seed + 2) - 0.5;
    r *= 1 + spec.rough * (n1 * 1.6 + n2 * 0.6 + n3 * 0.45);
    const p = scale(e, r);
    // Flatten the base and bury about a quarter of the stone, so it sits in the ground on a slope too.
    if (p[1] < -sy * 0.35) p[1] = -sy * 0.35 + (p[1] + sy * 0.35) * 0.15;
    p[1] += sy * 0.08;
    return p;
  });
  // Welded smooth normals.
  const normals: Vec3[] = pos.map(() => [0, 0, 0]);
  const neighbours: Set<number>[] = pos.map(() => new Set());
  for (let i = 0; i < tris.length; i += 3) {
    const a = tris[i]!;
    const b = tris[i + 1]!;
    const c = tris[i + 2]!;
    const f = cross(sub(pos[b]!, pos[a]!), sub(pos[c]!, pos[a]!));
    for (const v of [a, b, c]) normals[v] = add(normals[v]!, f);
    neighbours[a]!.add(b).add(c);
    neighbours[b]!.add(a).add(c);
    neighbours[c]!.add(a).add(b);
  }
  // Per-vertex shade, then per-face vertices: a corner whose face turns more than CREASE
  // off the smooth normal takes the face's normal, so fracture edges stay crisp while the
  // weathered faces stay smooth.
  const colors: Vec3[] = pos.map((p, i) => {
    const n = normalize(normals[i]!, dirs[i]!);
    // Crevice: how far the vertex sits inside the average of its neighbours, along its normal.
    let avg: Vec3 = [0, 0, 0];
    for (const j of neighbours[i]!) avg = add(avg, pos[j]!);
    avg = scale(avg, 1 / Math.max(1, neighbours[i]!.size));
    const cave = clamp(dot(sub(avg, p), n) * 9, 0, 1);
    const mottle = 0.86 + 0.24 * noise3(p[0] * 1.7, p[1] * 1.7, p[2] * 1.7, seed + 7);
    const fleck = 0.94 + 0.12 * hash2(i, 3, seed);
    const ground = clamp((p[1] + 0.05) / (sy * 0.5), 0, 1);
    const k = mottle * fleck * (1 - 0.45 * cave) * (0.7 + 0.3 * ground);
    // Moss on up-facing stone (patchy), pale lichen flecks, and dirt splashed up the base.
    const top = clamp((n[1] - 0.45) * 2.5, 0, 1);
    const moss = top * clamp(noise3(p[0] * 1.6, 7, p[2] * 1.6, seed + 9) * 2.2 - 0.75, 0, 1);
    const lichen = top * (hash2(i, 5, seed) > 0.93 ? 1 : 0) * (1 - moss);
    const dirt = clamp(1 - (p[1] + 0.02) / Math.max(0.12, sy * 0.35), 0, 1) * 0.85;
    const base: Vec3 = [k, k, k];
    const mixTo = (c: Vec3, t: Vec3, a: number): Vec3 => [c[0] + (t[0] - c[0]) * a, c[1] + (t[1] - c[1]) * a, c[2] + (t[2] - c[2]) * a];
    let c = mixTo(base, [k * 0.55, k * 0.78, k * 0.36], moss * 0.85);
    c = mixTo(c, [k * 1.25, k * 1.22, k * 1.1], lichen * 0.6);
    return mixTo(c, [k * 0.8, k * 0.66, k * 0.5], dirt);
  });
  const smooth = normals.map((n, i) => normalize(n, dirs[i]!));
  const m = new MeshBuilder();
  for (let i = 0; i < tris.length; i += 3) {
    const ids = [tris[i]!, tris[i + 1]!, tris[i + 2]!];
    const face = normalize(cross(sub(pos[ids[1]!]!, pos[ids[0]!]!), sub(pos[ids[2]!]!, pos[ids[0]!]!)), smooth[ids[0]!]!);
    const v = ids.map((j) => m.vertex(pos[j]!, dot(face, smooth[j]!) < CREASE ? face : smooth[j]!, 0, 0, colors[j]!));
    m.triangle(v[0]!, v[1]!, v[2]!);
  }
  return m;
}
