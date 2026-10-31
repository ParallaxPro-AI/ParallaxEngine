/**
 * Primitive meshes for the `shape` component in 3D: box, sphere, cylinder, cone, plane and
 * circle at unit size (scaled per instance by `shape.size`), and capsules built per
 * proportion (a capsule's hemispheres would stretch under a non-uniform scale).
 *
 * Unit shapes span -0.5..0.5 on every axis (plane and circle: flat on x and z, facing +y). Triangles are
 * wound so `cross(b - a, c - a)` points outward (the port's front-face rule).
 */

import type { Geometry3d } from '../../core/index.js';

const SEGMENTS = 32;
const RINGS = 16;

class Builder {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly uvs: number[] = [];
  readonly indices: number[] = [];

  vertex(p: readonly number[], n: readonly number[], u: number, v: number): number {
    this.positions.push(p[0]!, p[1]!, p[2]!);
    this.normals.push(n[0]!, n[1]!, n[2]!);
    this.uvs.push(u, v);
    return this.positions.length / 3 - 1;
  }

  /** A triangle, wound outward (by its vertices' normals); degenerate ones are dropped. */
  triangle(a: number, b: number, c: number): void {
    const p = this.positions;
    const e1 = [p[b * 3]! - p[a * 3]!, p[b * 3 + 1]! - p[a * 3 + 1]!, p[b * 3 + 2]! - p[a * 3 + 2]!];
    const e2 = [p[c * 3]! - p[a * 3]!, p[c * 3 + 1]! - p[a * 3 + 1]!, p[c * 3 + 2]! - p[a * 3 + 2]!];
    const cx = e1[1]! * e2[2]! - e1[2]! * e2[1]!;
    const cy = e1[2]! * e2[0]! - e1[0]! * e2[2]!;
    const cz = e1[0]! * e2[1]! - e1[1]! * e2[0]!;
    if (Math.hypot(cx, cy, cz) < 1e-12) return;
    const n = this.normals;
    const nx = n[a * 3]! + n[b * 3]! + n[c * 3]!;
    const ny = n[a * 3 + 1]! + n[b * 3 + 1]! + n[c * 3 + 1]!;
    const nz = n[a * 3 + 2]! + n[b * 3 + 2]! + n[c * 3 + 2]!;
    if (cx * nx + cy * ny + cz * nz >= 0) this.indices.push(a, b, c);
    else this.indices.push(a, c, b);
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.triangle(a, b, c);
    this.triangle(a, c, d);
  }

  /**
   * Revolve a profile around +y. Each profile point is [radius, y, normal radial, normal y, v].
   */
  lathe(profile: readonly (readonly number[])[]): void {
    const first = this.positions.length / 3;
    for (const [r, y, nr, ny, v] of profile) {
      for (let s = 0; s <= SEGMENTS; s++) {
        const a = (s / SEGMENTS) * Math.PI * 2;
        const cos = Math.cos(a);
        const sin = Math.sin(a);
        this.vertex([r! * sin, y!, r! * cos], [nr! * sin, ny!, nr! * cos], s / SEGMENTS, v!);
      }
    }
    const row = SEGMENTS + 1;
    for (let i = 0; i + 1 < profile.length; i++) {
      for (let s = 0; s < SEGMENTS; s++) {
        const a = first + i * row + s;
        this.quad(a, a + 1, a + row + 1, a + row);
      }
    }
  }

  /** A flat disc at height y facing `ny` (+1 up, -1 down). */
  cap(radius: number, y: number, ny: number): void {
    const center = this.vertex([0, y, 0], [0, ny, 0], 0.5, 0.5);
    const first = this.positions.length / 3;
    for (let s = 0; s <= SEGMENTS; s++) {
      const a = (s / SEGMENTS) * Math.PI * 2;
      this.vertex([radius * Math.sin(a), y, radius * Math.cos(a)], [0, ny, 0], 0.5 + 0.5 * Math.sin(a), 0.5 - 0.5 * Math.cos(a));
    }
    for (let s = 0; s < SEGMENTS; s++) this.triangle(center, first + s, first + s + 1);
  }

  build(id: string): Geometry3d {
    const p = this.positions;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k]!, p[i + k]!);
        max[k] = Math.max(max[k]!, p[i + k]!);
      }
    }
    const count = p.length / 3;
    return {
      id,
      positions: new Float32Array(p),
      normals: new Float32Array(this.normals),
      uvs: new Float32Array(this.uvs),
      indices: count > 65535 ? new Uint32Array(this.indices) : new Uint16Array(this.indices),
      joints: null,
      weights: null,
      colors: null,
      min: [min[0]!, min[1]!, min[2]!],
      max: [max[0]!, max[1]!, max[2]!],
    };
  }
}

function box(): Geometry3d {
  const b = new Builder();
  // normal, then the face's u and v axes.
  const faces: [number[], number[], number[]][] = [
    [[1, 0, 0], [0, 0, -1], [0, -1, 0]], [[-1, 0, 0], [0, 0, 1], [0, -1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, -1, 0]], [[0, 0, -1], [-1, 0, 0], [0, -1, 0]],
  ];
  for (const [n, u, v] of faces) {
    const corner = (su: number, sv: number): number => b.vertex(
      [0, 1, 2].map((k) => n[k]! * 0.5 + u[k]! * su * 0.5 + v[k]! * sv * 0.5), n, (su + 1) / 2, (sv + 1) / 2,
    );
    b.quad(corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1));
  }
  return b.build('shape:box');
}

function sphere(): Geometry3d {
  const b = new Builder();
  const profile: number[][] = [];
  for (let i = 0; i <= RINGS; i++) {
    const a = (i / RINGS) * Math.PI;
    const r = Math.sin(a);
    const y = -Math.cos(a);
    profile.push([0.5 * r, 0.5 * y, r, y, 1 - i / RINGS]);
  }
  b.lathe(profile);
  return b.build('shape:sphere');
}

function cylinder(): Geometry3d {
  const b = new Builder();
  b.lathe([[0.5, -0.5, 1, 0, 1], [0.5, 0.5, 1, 0, 0]]);
  b.cap(0.5, 0.5, 1);
  b.cap(0.5, -0.5, -1);
  return b.build('shape:cylinder');
}

function cone(): Geometry3d {
  const b = new Builder();
  // Side normals lean up by the slope: radius 0.5 over height 1.
  const len = Math.hypot(1, 0.5);
  b.lathe([[0.5, -0.5, 1 / len, 0.5 / len, 1], [0, 0.5, 1 / len, 0.5 / len, 0]]);
  b.cap(0.5, -0.5, -1);
  return b.build('shape:cone');
}

function plane(): Geometry3d {
  const b = new Builder();
  const n = [0, 1, 0];
  b.quad(b.vertex([-0.5, 0, -0.5], n, 0, 1), b.vertex([0.5, 0, -0.5], n, 1, 1), b.vertex([0.5, 0, 0.5], n, 1, 0), b.vertex([-0.5, 0, 0.5], n, 0, 0));
  return b.build('shape:plane');
}

function disc(): Geometry3d {
  const b = new Builder();
  b.cap(0.5, 0, 1);
  return b.build('shape:circle');
}

/** A capsule `height` tall (end to end) with hemispherical ends of `radius`. */
export function capsule(radius: number, height: number): Geometry3d {
  const b = new Builder();
  const half = Math.max(0, height / 2 - radius);
  const profile: number[][] = [];
  const total = height;
  const steps = RINGS / 2;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * (Math.PI / 2);
    const r = Math.sin(a);
    const y = -Math.cos(a);
    const py = -half + radius * y;
    profile.push([radius * r, py, r, y, 1 - (py + total / 2) / total]);
  }
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * (Math.PI / 2);
    const r = Math.cos(a);
    const y = Math.sin(a);
    const py = half + radius * y;
    profile.push([radius * r, py, r, y, 1 - (py + total / 2) / total]);
  }
  b.lathe(profile);
  return b.build(`shape:capsule:${radius}:${height}`);
}

/**
 * A ring `width` × `depth` across its outside (x and z, meters) with a band `thickness` wide,
 * built per proportion (a non-uniform scale would pinch the band). `flat`: an annulus at y = 0
 * facing +y (a range ring on the ground); otherwise a torus whose round tube is `thickness` thick.
 * The band is cut to the ring's half-size when thicker; UVs: u around the ring, v across the band.
 */
export function ring(width: number, depth: number, thickness: number, flat: boolean): Geometry3d {
  const b = new Builder();
  const band = Math.min(thickness, width / 2, depth / 2);
  const row = SEGMENTS + 1;
  if (flat) {
    const first = b.positions.length / 3;
    for (const [k, v] of [[0, 0], [band, 1]] as const) {
      for (let s = 0; s <= SEGMENTS; s++) {
        const a = (s / SEGMENTS) * Math.PI * 2;
        b.vertex([(width / 2 - k) * Math.sin(a), 0, (depth / 2 - k) * Math.cos(a)], [0, 1, 0], s / SEGMENTS, v);
      }
    }
    for (let s = 0; s < SEGMENTS; s++) b.quad(first + s, first + s + 1, first + row + s + 1, first + row + s);
  } else {
    // The tube's centre line: an ellipse band/2 inside the outer edge; the tube is offset along its normal.
    const r = band / 2;
    const ax = width / 2 - r;
    const az = depth / 2 - r;
    const tube = RINGS;
    const first = b.positions.length / 3;
    for (let j = 0; j <= tube; j++) {
      const phi = (j / tube) * Math.PI * 2;
      for (let s = 0; s <= SEGMENTS; s++) {
        const a = (s / SEGMENTS) * Math.PI * 2;
        const sin = Math.sin(a);
        const cos = Math.cos(a);
        // Outward normal of the ellipse (x = ax sin a, z = az cos a) in the ground plane.
        let nx = ax > 0 ? sin / ax : sin;
        let nz = az > 0 ? cos / az : cos;
        const len = Math.hypot(nx, nz) || 1;
        nx /= len;
        nz /= len;
        const n = [Math.cos(phi) * nx, Math.sin(phi), Math.cos(phi) * nz];
        b.vertex([ax * sin + r * n[0]!, r * n[1]!, az * cos + r * n[2]!], n, s / SEGMENTS, j / tube);
      }
    }
    for (let j = 0; j < tube; j++) {
      for (let s = 0; s < SEGMENTS; s++) {
        const a = first + j * row + s;
        b.quad(a, a + 1, a + row + 1, a + row);
      }
    }
  }
  return b.build(`shape:ring:${width}:${depth}:${thickness}:${flat ? 'flat' : 'torus'}`);
}

export type UnitShape = 'box' | 'sphere' | 'cylinder' | 'cone' | 'plane' | 'circle';

const UNIT: Record<UnitShape, () => Geometry3d> = { box, sphere, cylinder, cone, plane, circle: disc };
const unitCache = new Map<UnitShape, Geometry3d>();

/** The shared unit geometry of a shape kind (built once per process: geometry is immutable). */
export function unitShape(kind: UnitShape): Geometry3d {
  let geometry = unitCache.get(kind);
  if (geometry === undefined) {
    geometry = UNIT[kind]();
    unitCache.set(kind, geometry);
  }
  return geometry;
}

export const UNIT_SHAPES: readonly UnitShape[] = ['box', 'sphere', 'cylinder', 'cone', 'plane', 'circle'];
