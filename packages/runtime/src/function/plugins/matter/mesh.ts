/**
 * Solid meshes that can be cut: a closed, counter-clockwise (seen from outside) triangle
 * surface over welded particles, plus per-render-vertex attributes, in the body's local
 * space. Pure arithmetic on typed arrays — no kernel — so it is tested on its own.
 *
 *   particles   unique positions (`rest`): what the soft layer simulates and slices cut
 *   vertices    what is drawn: a particle index each, plus
 *                 cap      -1 on the original skin; 0..1 on a cut face (0 its middle, 1 its rim)
 *                 mottle   a fixed random 0..1 (colour variation, patterns)
 *                 stain    0..1, how far the vertex has darkened (scorching → char)
 *                 paint    rgb + weight of what was painted on (dirt, soot, pigment)
 *   triangles   vertex indices, three per triangle
 *
 * A cut face's vertices are their own (not the skin's), so it shades flat with a sharp
 * edge while sharing the rim particles, so the skin and the face deform together.
 *
 * `build` makes the starting solid from a shape; `slice` splits a mesh by a plane into two
 * closed meshes, each capped with a new face (a fan with two inner rings, so a gradient
 * from rim to middle can be drawn). Every shape `build` makes is convex up to its `bump`,
 * and a convex solid cut by a plane stays convex, so a cut face is one star-shaped polygon.
 */

export const SOLID_SHAPES = ['box', 'sphere', 'cylinder', 'capsule'] as const;
export type SolidShape = (typeof SOLID_SHAPES)[number];

export interface SolidMesh {
  /** Particle rest positions, x y z each. */
  readonly rest: Float64Array;
  /** Vertex → particle. */
  readonly vp: Uint32Array;
  readonly cap: Float32Array;
  readonly mottle: Float32Array;
  readonly stain: Float32Array;
  /** r g b weight per vertex. */
  readonly paint: Float32Array;
  readonly tris: Uint32Array;
}

export interface SolidSpec {
  readonly shape: SolidShape;
  /** Full extents, meters. */
  readonly size: readonly [number, number, number];
  /** Edge rounding radius, meters (box, cylinder). */
  readonly round: number;
  /** Top (+y) width over bottom width: 1 straight, 0.3 a tapered point. */
  readonly taper: number;
  /** Surface unevenness, a share of the smallest half extent (0..0.3). */
  readonly bump: number;
  /** Grid cells per cube edge before shaping (4..16). */
  readonly segments: number;
  readonly seed: number;
}

/** A small deterministic hash → 0..1. */
export function hash01(a: number, b: number, c: number, seed: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1) ^ Math.imul(seed | 0, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise in 3D (0..1), period-free. */
function noise3(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const fx = x - xi;
  const fy = y - yi;
  const fz = z - zi;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const sz = fz * fz * (3 - 2 * fz);
  let out = 0;
  for (let dz = 0; dz < 2; dz++) {
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const w = (dx ? sx : 1 - sx) * (dy ? sy : 1 - sy) * (dz ? sz : 1 - sz);
        out += w * hash01(xi + dx, yi + dy, zi + dz, seed);
      }
    }
  }
  return out;
}

/** Signed volume of a closed counter-clockwise surface over particle positions `x`. */
export function meshVolume(x: ArrayLike<number>, vp: ArrayLike<number>, tris: ArrayLike<number>): number {
  let v = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const a = vp[tris[t]!]! * 3;
    const b = vp[tris[t + 1]!]! * 3;
    const c = vp[tris[t + 2]!]! * 3;
    v += x[a]! * (x[b + 1]! * x[c + 2]! - x[b + 2]! * x[c + 1]!)
      - x[a + 1]! * (x[b]! * x[c + 2]! - x[b + 2]! * x[c]!)
      + x[a + 2]! * (x[b]! * x[c + 1]! - x[b + 1]! * x[c]!);
  }
  return v / 6;
}

/** Axis-aligned bounds of the particles: [min, max]. */
export function meshBounds(x: ArrayLike<number>): [[number, number, number], [number, number, number]] {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < x.length; k++) {
    const axis = k % 3;
    if (x[k]! < min[axis]!) min[axis] = x[k]!;
    if (x[k]! > max[axis]!) max[axis] = x[k]!;
  }
  return [min, max];
}

/** The starting solid of a shape, centred on the origin. */
export function buildSolid(spec: SolidSpec): SolidMesh {
  const n = Math.max(2, Math.min(24, Math.round(spec.segments)));
  const positions: number[] = [];
  const tris: number[] = [];
  const index = new Map<string, number>();
  const vertex = (x: number, y: number, z: number): number => {
    const key = `${Math.round(x * 1e6)},${Math.round(y * 1e6)},${Math.round(z * 1e6)}`;
    let i = index.get(key);
    if (i === undefined) {
      i = positions.length / 3;
      positions.push(x, y, z);
      index.set(key, i);
    }
    return i;
  };
  const faces: ReadonlyArray<readonly [readonly number[], readonly number[], readonly number[]]> = [
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  for (const [nrm, u, v] of faces) {
    const grid: number[][] = [];
    for (let i = 0; i <= n; i++) {
      const row: number[] = [];
      for (let j = 0; j <= n; j++) {
        const a = i / n - 0.5;
        const b = j / n - 0.5;
        row.push(vertex(nrm[0]! * 0.5 + u[0]! * a + v[0]! * b, nrm[1]! * 0.5 + u[1]! * a + v[1]! * b, nrm[2]! * 0.5 + u[2]! * a + v[2]! * b));
      }
      grid.push(row);
    }
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        // Split each quad along the diagonal that keeps the shaped surface convex-ish.
        tris.push(grid[i]![j]!, grid[i + 1]![j]!, grid[i + 1]![j + 1]!, grid[i]![j]!, grid[i + 1]![j + 1]!, grid[i]![j + 1]!);
      }
    }
  }
  const count = positions.length / 3;
  const rest = new Float64Array(count * 3);
  const [sx, sy, sz] = spec.size;
  const hx = sx / 2;
  const hy = sy / 2;
  const hz = sz / 2;
  const minHalf = Math.min(hx, hy, hz);
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3]!;
    const y = positions[i * 3 + 1]!;
    const z = positions[i * 3 + 2]!;
    let px: number;
    let py: number;
    let pz: number;
    if (spec.shape === 'sphere') {
      const l = Math.hypot(x, y, z) || 1;
      px = (x / l) * hx;
      py = (y / l) * hy;
      pz = (z / l) * hz;
    } else if (spec.shape === 'box') {
      const r = Math.min(Math.max(0, spec.round), minHalf * 0.999);
      const bx = x * sx;
      const by = y * sy;
      const bz = z * sz;
      const ix = Math.max(-hx + r, Math.min(hx - r, bx));
      const iy = Math.max(-hy + r, Math.min(hy - r, by));
      const iz = Math.max(-hz + r, Math.min(hz - r, bz));
      const dx = bx - ix;
      const dy = by - iy;
      const dz = bz - iz;
      const dl = Math.hypot(dx, dy, dz);
      if (dl > 1e-12 && r > 0) {
        px = ix + (dx / dl) * r;
        py = iy + (dy / dl) * r;
        pz = iz + (dz / dl) * r;
      } else {
        px = bx;
        py = by;
        pz = bz;
      }
    } else {
      // Cylinder / capsule along y: the square's (x, z) mapped onto a disc, edges rounded.
      const u = x * 2;
      const w = z * 2;
      const dxz = u * Math.sqrt(Math.max(0, 1 - (w * w) / 2));
      const dzz = w * Math.sqrt(Math.max(0, 1 - (u * u) / 2));
      const rho = Math.hypot(dxz, dzz);
      const R = Math.min(hx, hz);
      const r = spec.shape === 'capsule' ? Math.min(R, hy) * 0.999 : Math.min(Math.max(0, spec.round), Math.min(R, hy) * 0.999);
      let qr = rho * R;
      let qy = y * sy;
      const ir = Math.min(qr, R - r);
      const iy = Math.max(-hy + r, Math.min(hy - r, qy));
      const dr = qr - ir;
      const dy = qy - iy;
      const dl = Math.hypot(dr, dy);
      if (dl > 1e-12 && r > 0) {
        qr = ir + (dr / dl) * r;
        qy = iy + (dy / dl) * r;
      }
      const ax = rho > 1e-12 ? dxz / rho : 0;
      const az = rho > 1e-12 ? dzz / rho : 0;
      px = ax * qr * (hx / R);
      py = qy;
      pz = az * qr * (hz / R);
    }
    if (spec.taper !== 1) {
      const f = 1 + (spec.taper - 1) * (py / sy + 0.5);
      px *= f;
      pz *= f;
    }
    if (spec.bump > 0) {
      const k = 6 / Math.max(1e-3, Math.max(sx, sy, sz));
      const d = (noise3(px * k, py * k, pz * k, spec.seed) - 0.5) * 2 * spec.bump * minHalf;
      const s = 1 + d / (Math.hypot(px, py, pz) + 1e-9);
      px *= s;
      py *= s;
      pz *= s;
    }
    rest[i * 3] = px;
    rest[i * 3 + 1] = py;
    rest[i * 3 + 2] = pz;
  }
  const vp = new Uint32Array(count);
  const mottle = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    vp[i] = i;
    mottle[i] = hash01(i, 7, 13, spec.seed);
  }
  const cap = new Float32Array(count).fill(-1);
  const mesh: SolidMesh = {
    rest, vp, cap, mottle,
    stain: new Float32Array(count),
    paint: new Float32Array(count * 4),
    tris: Uint32Array.from(tris),
  };
  if (meshVolume(rest, vp, mesh.tris) < 0) {
    const t = mesh.tris;
    for (let k = 0; k < t.length; k += 3) {
      const b = t[k + 1]!;
      t[k + 1] = t[k + 2]!;
      t[k + 2] = b;
    }
  }
  return recenter(mesh).mesh;
}

/** The mesh moved so its particles' volume centroid is the origin; `offset` is where that centroid was. */
export function recenter(mesh: SolidMesh): { mesh: SolidMesh; offset: [number, number, number] } {
  const c = centroid(mesh);
  const rest = mesh.rest;
  for (let i = 0; i < rest.length; i += 3) {
    rest[i] = rest[i]! - c[0];
    rest[i + 1] = rest[i + 1]! - c[1];
    rest[i + 2] = rest[i + 2]! - c[2];
  }
  return { mesh, offset: c };
}

/** Volume centroid of a closed mesh (the particle average when it encloses nothing). */
export function centroid(mesh: SolidMesh): [number, number, number] {
  const x = mesh.rest;
  const { vp, tris } = mesh;
  let vol = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const a = vp[tris[t]!]! * 3;
    const b = vp[tris[t + 1]!]! * 3;
    const c = vp[tris[t + 2]!]! * 3;
    const v = (x[a]! * (x[b + 1]! * x[c + 2]! - x[b + 2]! * x[c + 1]!)
      - x[a + 1]! * (x[b]! * x[c + 2]! - x[b + 2]! * x[c]!)
      + x[a + 2]! * (x[b]! * x[c + 1]! - x[b + 1]! * x[c]!)) / 6;
    vol += v;
    cx += v * (x[a]! + x[b]! + x[c]!) / 4;
    cy += v * (x[a + 1]! + x[b + 1]! + x[c + 1]!) / 4;
    cz += v * (x[a + 2]! + x[b + 2]! + x[c + 2]!) / 4;
  }
  if (Math.abs(vol) > 1e-15) return [cx / vol, cy / vol, cz / vol];
  let sx = 0;
  let sy = 0;
  let sz = 0;
  const n = x.length / 3;
  for (let i = 0; i < n; i++) {
    sx += x[i * 3]!;
    sy += x[i * 3 + 1]!;
    sz += x[i * 3 + 2]!;
  }
  return n > 0 ? [sx / n, sy / n, sz / n] : [0, 0, 0];
}

/** Ring radii of a cut face (outermost first), as a share of the way from its middle to its rim. */
const CAP_RINGS = [0.8, 0.45] as const;

/** Rim points closer than 1/WELD m are welded. */
const WELD = 1e6;

class Builder {
  readonly rest: number[] = [];
  readonly vp: number[] = [];
  readonly cap: number[] = [];
  readonly mottle: number[] = [];
  readonly stain: number[] = [];
  readonly paint: number[] = [];
  readonly tris: number[] = [];

  particle(x: number, y: number, z: number): number {
    this.rest.push(x, y, z);
    return this.rest.length / 3 - 1;
  }

  vertex(p: number, cap: number, mottle: number, stain: number, paint: readonly number[]): number {
    this.vp.push(p);
    this.cap.push(cap);
    this.mottle.push(mottle);
    this.stain.push(stain);
    this.paint.push(paint[0]!, paint[1]!, paint[2]!, paint[3]!);
    return this.vp.length - 1;
  }

  finish(): SolidMesh {
    // Drop particles no vertex uses, keeping order.
    const used = new Int32Array(this.rest.length / 3).fill(-1);
    let next = 0;
    for (const p of this.vp) if (used[p] === -1) used[p] = next++;
    // Keep index order (not first-use order).
    next = 0;
    const keep = new Int32Array(used.length).fill(-1);
    for (let p = 0; p < used.length; p++) if (used[p] !== -1) keep[p] = next++;
    const rest = new Float64Array(next * 3);
    for (let p = 0; p < keep.length; p++) {
      const k = keep[p]!;
      if (k < 0) continue;
      rest[k * 3] = this.rest[p * 3]!;
      rest[k * 3 + 1] = this.rest[p * 3 + 1]!;
      rest[k * 3 + 2] = this.rest[p * 3 + 2]!;
    }
    return {
      rest,
      vp: Uint32Array.from(this.vp, (p) => keep[p]!),
      cap: Float32Array.from(this.cap),
      mottle: Float32Array.from(this.mottle),
      stain: Float32Array.from(this.stain),
      paint: Float32Array.from(this.paint),
      tris: Uint32Array.from(this.tris),
    };
  }
}

export interface SliceResult {
  /** The side the normal points away from (signed distance below 0). */
  readonly back: SolidMesh;
  /** The side the normal points to. */
  readonly front: SolidMesh;
}

/**
 * Split `mesh` by the plane n·x = d (n unit, local space). Null when the plane misses the
 * solid or leaves less than `minVolume` (m³) on either side. Both halves keep the original
 * frame (not recentred).
 */
export function slice(mesh: SolidMesh, n: readonly [number, number, number], d: number, minVolume: number): SliceResult | null {
  const rest = mesh.rest;
  const np = rest.length / 3;
  const s = new Float64Array(np);
  // Vertices within SNAP of the plane lie on it: they belong to both sides and to the rim.
  const SNAP = 2e-5;
  let pos = 0;
  let neg = 0;
  for (let i = 0; i < np; i++) {
    let v = n[0] * rest[i * 3]! + n[1] * rest[i * 3 + 1]! + n[2] * rest[i * 3 + 2]! - d;
    if (Math.abs(v) < SNAP) v = 0;
    s[i] = v;
    if (v > 0) pos++;
    else if (v < 0) neg++;
  }
  if (pos === 0 || neg === 0) return null;
  const back = cutSide(mesh, s, -1, n);
  const front = cutSide(mesh, s, 1, n);
  if (back === null || front === null) return null;
  const vb = meshVolume(back.rest, back.vp, back.tris);
  const vf = meshVolume(front.rest, front.vp, front.tris);
  if (vb < minVolume || vf < minVolume) return null;
  return { back, front };
}

/** One side (`sign` 1: s > 0, -1: s < 0) of the cut, capped. */
function cutSide(mesh: SolidMesh, s: Float64Array, sign: 1 | -1, n: readonly [number, number, number]): SolidMesh | null {
  const { rest, vp, cap, mottle, stain, paint, tris } = mesh;
  const b = new Builder();
  const pmap = new Map<number, number>();
  const vmap = new Map<number, number>();
  const edgeParticle = new Map<string, number>();
  const edgeVertex = new Map<string, number>();
  const welded = new Map<string, number>();
  const inside = (p: number): boolean => s[p]! * sign >= 0;
  /** Rim particles in the order found. */
  const rim: number[] = [];
  const particleOf = (p: number): number => {
    let q = pmap.get(p);
    if (q === undefined) {
      q = b.particle(rest[p * 3]!, rest[p * 3 + 1]!, rest[p * 3 + 2]!);
      pmap.set(p, q);
      if (s[p] === 0) rim.push(q);
    }
    return q;
  };
  const vertexOf = (v: number): number => {
    let q = vmap.get(v);
    if (q === undefined) {
      q = b.vertex(particleOf(vp[v]!), cap[v]!, mottle[v]!, stain[v]!, [paint[v * 4]!, paint[v * 4 + 1]!, paint[v * 4 + 2]!, paint[v * 4 + 3]!]);
      vmap.set(v, q);
    }
    return q;
  };
  /** Rim particle → a skin-side attribute source (mottle, paint) for its cap vertex. */
  const rimAttr = new Map<number, number>();
  const edgePoint = (va: number, vb: number): number => {
    const lo = Math.min(va, vb);
    const hi = Math.max(va, vb);
    const vkey = `${lo},${hi}`;
    let q = edgeVertex.get(vkey);
    if (q !== undefined) return q;
    const pa = vp[lo]!;
    const pb = vp[hi]!;
    const t = s[pa]! / (s[pa]! - s[pb]!);
    const plo = Math.min(pa, pb);
    const phi = Math.max(pa, pb);
    const pkey = `${plo},${phi}`;
    let p = edgeParticle.get(pkey);
    if (p === undefined) {
      const tt = s[plo]! / (s[plo]! - s[phi]!);
      const x = rest[plo * 3]! + (rest[phi * 3]! - rest[plo * 3]!) * tt;
      const y = rest[plo * 3 + 1]! + (rest[phi * 3 + 1]! - rest[plo * 3 + 1]!) * tt;
      const z = rest[plo * 3 + 2]! + (rest[phi * 3 + 2]! - rest[plo * 3 + 2]!) * tt;
      // Crossings a hair apart (the plane grazing a vertex) are one rim point.
      const wkey = `${Math.round(x * WELD)},${Math.round(y * WELD)},${Math.round(z * WELD)}`;
      p = welded.get(wkey);
      if (p === undefined) {
        p = b.particle(x, y, z);
        welded.set(wkey, p);
        rim.push(p);
      }
      edgeParticle.set(pkey, p);
    }
    const lerp = (arr: Float32Array, k: number, w: number): number => arr[lo * k + w]! + (arr[hi * k + w]! - arr[lo * k + w]!) * t;
    const capValue = cap[lo]! < 0 || cap[hi]! < 0 ? -1 : lerp(cap, 1, 0);
    q = b.vertex(p, capValue, lerp(mottle, 1, 0), lerp(stain, 1, 0), [lerp(paint, 4, 0), lerp(paint, 4, 1), lerp(paint, 4, 2), lerp(paint, 4, 3)]);
    edgeVertex.set(vkey, q);
    if (!rimAttr.has(p) || capValue < 0) rimAttr.set(p, q);
    return q;
  };

  for (let t = 0; t < tris.length; t += 3) {
    const tv = [tris[t]!, tris[t + 1]!, tris[t + 2]!];
    const ins = tv.map((v) => inside(vp[v]!));
    const count = (ins[0] ? 1 : 0) + (ins[1] ? 1 : 0) + (ins[2] ? 1 : 0);
    if (count === 0) continue;
    // A triangle lying in the plane belongs to neither side: the new face replaces it.
    if (s[vp[tv[0]!]!] === 0 && s[vp[tv[1]!]!] === 0 && s[vp[tv[2]!]!] === 0) continue;
    if (count === 3) {
      b.tris.push(vertexOf(tv[0]!), vertexOf(tv[1]!), vertexOf(tv[2]!));
      continue;
    }
    // Sutherland–Hodgman against the half-space, keeping winding.
    const poly: number[] = [];
    for (let k = 0; k < 3; k++) {
      const cur = tv[k]!;
      const nxt = tv[(k + 1) % 3]!;
      const ci = ins[k]!;
      const ni = ins[(k + 1) % 3]!;
      if (ci) poly.push(vertexOf(cur));
      if (s[vp[cur]!]! * s[vp[nxt]!]! < 0) poly.push(edgePoint(cur, nxt));
    }
    for (let k = 1; k + 1 < poly.length; k++) b.tris.push(poly[0]!, poly[k]!, poly[k + 1]!);
  }
  if (rim.length < 3) return null;

  // The cut face: rim particles sorted by angle about their centroid in the plane, faced
  // away from the kept side (-sign · n), with two inner rings and a middle.
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const p of rim) {
    cx += b.rest[p * 3]!;
    cy += b.rest[p * 3 + 1]!;
    cz += b.rest[p * 3 + 2]!;
  }
  cx /= rim.length;
  cy /= rim.length;
  cz /= rim.length;
  // Plane basis u, w with u × w = n.
  const ref = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  let ux = ref[1]! * n[2] - ref[2]! * n[1];
  let uy = ref[2]! * n[0] - ref[0]! * n[2];
  let uz = ref[0]! * n[1] - ref[1]! * n[0];
  const ul = Math.hypot(ux, uy, uz);
  ux /= ul;
  uy /= ul;
  uz /= ul;
  const wx = n[1] * uz - n[2] * uy;
  const wy = n[2] * ux - n[0] * uz;
  const wz = n[0] * uy - n[1] * ux;
  const angle = new Map<number, number>();
  for (const p of rim) {
    const dx = b.rest[p * 3]! - cx;
    const dy = b.rest[p * 3 + 1]! - cy;
    const dz = b.rest[p * 3 + 2]! - cz;
    angle.set(p, Math.atan2(dx * wx + dy * wy + dz * wz, dx * ux + dy * uy + dz * uz));
  }
  const ring = [...rim].sort((a, c) => angle.get(a)! - angle.get(c)!);
  const m = ring.length;
  const NONE = [0, 0, 0, 0] as const;
  const mottleOf = (p: number): number => {
    const v = rimAttr.get(p);
    return v === undefined ? 0.5 : b.mottle[v]!;
  };
  const rings: number[][] = [];
  const outer: number[] = ring.map((p) => b.vertex(p, 1, mottleOf(p), 0, NONE));
  for (const r of CAP_RINGS) {
    rings.push(ring.map((p, k) => {
      const q = b.particle(cx + (b.rest[p * 3]! - cx) * r, cy + (b.rest[p * 3 + 1]! - cy) * r, cz + (b.rest[p * 3 + 2]! - cz) * r);
      return b.vertex(q, r, hash01(p, k, Math.round(r * 100), 31), 0, NONE);
    }));
  }
  const middle = b.vertex(b.particle(cx, cy, cz), 0, 0.5, 0, NONE);
  // Counter-clockwise about +n when the angle increases; the face must look along -sign·n.
  const flip = sign > 0;
  const tri = (a: number, c: number, d: number): void => {
    if (flip) b.tris.push(a, d, c);
    else b.tris.push(a, c, d);
  };
  const levels = [outer, ...rings];
  for (let l = 0; l + 1 < levels.length; l++) {
    const o = levels[l]!;
    const i = levels[l + 1]!;
    for (let k = 0; k < m; k++) {
      const k1 = (k + 1) % m;
      tri(o[k]!, o[k1]!, i[k1]!);
      tri(o[k]!, i[k1]!, i[k]!);
    }
  }
  const inner = levels[levels.length - 1]!;
  for (let k = 0; k < m; k++) tri(inner[k]!, inner[(k + 1) % m]!, middle);
  return b.finish();
}

/** A deep copy. */
export function copyMesh(mesh: SolidMesh): SolidMesh {
  return {
    rest: Float64Array.from(mesh.rest),
    vp: Uint32Array.from(mesh.vp),
    cap: Float32Array.from(mesh.cap),
    mottle: Float32Array.from(mesh.mottle),
    stain: Float32Array.from(mesh.stain),
    paint: Float32Array.from(mesh.paint),
    tris: Uint32Array.from(mesh.tris),
  };
}

/** Rotate every particle by the column-major 3×3 matrix `R` (in place). */
export function rotateMesh(mesh: SolidMesh, R: readonly number[]): void {
  const x = mesh.rest;
  for (let i = 0; i < x.length; i += 3) {
    const a = x[i]!;
    const b = x[i + 1]!;
    const c = x[i + 2]!;
    x[i] = R[0]! * a + R[3]! * b + R[6]! * c;
    x[i + 1] = R[1]! * a + R[4]! * b + R[7]! * c;
    x[i + 2] = R[2]! * a + R[5]! * b + R[8]! * c;
  }
}
