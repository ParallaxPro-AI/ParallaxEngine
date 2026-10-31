/**
 * Growable indexed triangle lists with per-vertex colour (sRGB RGBA), as the city's chunk
 * geometry is built: quads, prisms, boxes and cylinders. Front faces are counter-clockwise
 * seen from where the normal points; normals are flat per face. UVs are meters along the
 * face, or — for a builder made with a `tile` — world-projected and divided by the tile, so a
 * texture repeats seamlessly across neighbouring patches (walls by their run along the
 * facade and their height, horizontal surfaces by x and z).
 */

import type { Quad, Rgb } from './layout.js';

export type V3 = readonly [number, number, number];

/** A finished surface: typed arrays a renderer or a job hands over as is. */
export interface CitySurface {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
  readonly colors: Float32Array;
  readonly indices: Uint32Array;
  readonly min: [number, number, number];
  readonly max: [number, number, number];
}

export class MeshBuilder {
  /** Meters per texture repeat for world-projected UVs; 0: UVs are meters along each face. */
  readonly #tile: number;
  #p: number[] = [];
  #n: number[] = [];
  #uv: number[] = [];
  #c: number[] = [];
  #i: number[] = [];

  constructor(tile = 0) {
    this.#tile = tile;
  }

  /** World-projected UV of `p` on a face with normal n (tiled builders). */
  #worldUv(p: V3, nx: number, ny: number, nz: number): [number, number] {
    const t = this.#tile;
    if (Math.abs(ny) > 0.7) return [p[0] / t, p[2] / t];
    const h = Math.hypot(nx, nz) || 1;
    // Along the face (its tangent in the ground plane), then up.
    return [(p[0] * -nz + p[2] * nx) / h / t, -p[1] / t];
  }

  get vertexCount(): number {
    return this.#p.length / 3;
  }

  get triangleCount(): number {
    return this.#i.length / 3;
  }

  /** A planar quad p0 p1 p2 p3 (counter-clockwise seen from the front). */
  quad(p0: V3, p1: V3, p2: V3, p3: V3, color: Rgb, alpha = 1): void {
    const ux = p1[0] - p0[0];
    const uy = p1[1] - p0[1];
    const uz = p1[2] - p0[2];
    const vx = p2[0] - p0[0];
    const vy = p2[1] - p0[1];
    const vz = p2[2] - p0[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-12) return;
    nx /= l;
    ny /= l;
    nz /= l;
    const base = this.#p.length / 3;
    const w = Math.hypot(ux, uy, uz);
    const h = Math.hypot(p3[0] - p0[0], p3[1] - p0[1], p3[2] - p0[2]);
    const uvs = [0, 0, w, 0, w, h, 0, h];
    for (const [k, p] of [p0, p1, p2, p3].entries()) {
      this.#p.push(p[0], p[1], p[2]);
      this.#n.push(nx, ny, nz);
      if (this.#tile > 0) this.#uv.push(...this.#worldUv(p, nx, ny, nz));
      else this.#uv.push(uvs[k * 2]!, uvs[k * 2 + 1]!);
      this.#c.push(color[0], color[1], color[2], alpha);
    }
    this.#i.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  tri(p0: V3, p1: V3, p2: V3, color: Rgb): void {
    const ux = p1[0] - p0[0];
    const uy = p1[1] - p0[1];
    const uz = p1[2] - p0[2];
    const vx = p2[0] - p0[0];
    const vy = p2[1] - p0[1];
    const vz = p2[2] - p0[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-12) return;
    nx /= l;
    ny /= l;
    nz /= l;
    const base = this.#p.length / 3;
    for (const p of [p0, p1, p2]) {
      this.#p.push(p[0], p[1], p[2]);
      this.#n.push(nx, ny, nz);
      if (this.#tile > 0) this.#uv.push(...this.#worldUv(p, nx, ny, nz));
      else this.#uv.push(p[0], p[2]);
      this.#c.push(color[0], color[1], color[2], 1);
    }
    this.#i.push(base, base + 1, base + 2);
  }

  /** A planar quad facing the side `toward` points to (winding fixed up to match). */
  quadToward(p0: V3, p1: V3, p2: V3, p3: V3, toward: V3, color: Rgb, alpha = 1): void {
    const ux = p1[0] - p0[0];
    const uy = p1[1] - p0[1];
    const uz = p1[2] - p0[2];
    const vx = p2[0] - p0[0];
    const vy = p2[1] - p0[1];
    const vz = p2[2] - p0[2];
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    if (n[0]! * toward[0] + n[1]! * toward[1] + n[2]! * toward[2] >= 0) this.quad(p0, p1, p2, p3, color, alpha);
    else this.quad(p0, p3, p2, p1, color, alpha);
  }

  triToward(p0: V3, p1: V3, p2: V3, toward: V3, color: Rgb): void {
    const ux = p1[0] - p0[0];
    const uy = p1[1] - p0[1];
    const uz = p1[2] - p0[2];
    const vx = p2[0] - p0[0];
    const vy = p2[1] - p0[1];
    const vz = p2[2] - p0[2];
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    if (n[0]! * toward[0] + n[1]! * toward[1] + n[2]! * toward[2] >= 0) this.tri(p0, p1, p2, color);
    else this.tri(p0, p2, p1, color);
  }

  /**
   * A rectangle on a vertical face: the face runs from (ax, az) along unit (tx, tz), facing
   * out (tz, −tx); `x0..x1` along it, `y0..y1` up, pushed `out` meters off the face.
   */
  facePatch(ax: number, az: number, tx: number, tz: number, x0: number, x1: number, y0: number, y1: number, out: number, color: Rgb, alpha = 1): void {
    if (x1 - x0 < 1e-6 || y1 - y0 < 1e-6) return;
    const nx = tz * out;
    const nz = -tx * out;
    const p = (x: number, y: number): V3 => [ax + tx * x + nx, y, az + tz * x + nz];
    this.quad(p(x0, y0), p(x0, y1), p(x1, y1), p(x1, y0), color, alpha);
  }

  /**
   * A box standing out of a vertical face (sills, fins, cornices): its front at `out`, its
   * back on the face; front, top, bottom and the two ends.
   */
  faceBox(
    ax: number, az: number, tx: number, tz: number, x0: number, x1: number, y0: number, y1: number, out: number, color: Rgb,
    faces: 'all' | 'ledge' | 'fin' | 'sill' = 'all',
  ): void {
    if (x1 - x0 < 1e-6 || y1 - y0 < 1e-6) return;
    const nx = tz;
    const nz = -tx;
    const p = (x: number, y: number, o: number): V3 => [ax + tx * x + nx * o, y, az + tz * x + nz * o];
    this.quad(p(x0, y0, out), p(x0, y1, out), p(x1, y1, out), p(x1, y0, out), color);
    // ledge: front, top, bottom; fin: front and ends; sill: front and top.
    if (faces !== 'fin') this.quadToward(p(x0, y1, 0), p(x0, y1, out), p(x1, y1, out), p(x1, y1, 0), [0, 1, 0], color);
    if (faces === 'all' || faces === 'ledge') this.quadToward(p(x0, y0, 0), p(x0, y0, out), p(x1, y0, out), p(x1, y0, 0), [0, -1, 0], color);
    if (faces === 'all' || faces === 'fin') {
      this.quadToward(p(x0, y0, 0), p(x0, y1, 0), p(x0, y1, out), p(x0, y0, out), [-tx, 0, -tz], color);
      this.quadToward(p(x1, y0, 0), p(x1, y1, 0), p(x1, y1, out), p(x1, y0, out), [tx, 0, tz], color);
    }
  }

  /** A window or door recess: four reveal faces from the face plane back `depth`, and (unless null) a pane at the back. */
  recess(ax: number, az: number, tx: number, tz: number, x0: number, x1: number, y0: number, y1: number, depth: number, reveal: Rgb, pane: MeshBuilder | null, paneColor: Rgb): void {
    const nx = tz;
    const nz = -tx;
    const p = (x: number, y: number, o: number): V3 => [ax + tx * x + nx * o, y, az + tz * x + nz * o];
    const d = -depth;
    // Each reveal faces into the opening.
    this.quadToward(p(x0, y0, 0), p(x0, y1, 0), p(x0, y1, d), p(x0, y0, d), [tx, 0, tz], reveal);
    this.quadToward(p(x1, y0, 0), p(x1, y1, 0), p(x1, y1, d), p(x1, y0, d), [-tx, 0, -tz], reveal);
    this.quadToward(p(x0, y1, 0), p(x1, y1, 0), p(x1, y1, d), p(x0, y1, d), [0, -1, 0], reveal);
    this.quadToward(p(x0, y0, 0), p(x1, y0, 0), p(x1, y0, d), p(x0, y0, d), [0, 1, 0], reveal);
    if (pane !== null) pane.quad(p(x0, y0, d), p(x0, y1, d), p(x1, y1, d), p(x1, y0, d), paneColor);
  }

  /** A vertical wall from a to b (x, z) between y0 and y1, facing to the right of a → b. */
  wall(ax: number, az: number, bx: number, bz: number, y0: number, y1: number, color: Rgb): void {
    if (y1 - y0 < 1e-6) return;
    this.quad([ax, y0, az], [ax, y1, az], [bx, y1, bz], [bx, y0, bz], color);
  }

  /** A horizontal quad facing up (corners with the inside on their left, as layout quads are). */
  top(q: Quad, y: number, color: Rgb, alpha = 1): void {
    this.quad([q[0][0], y, q[0][1]], [q[3][0], y, q[3][1]], [q[2][0], y, q[2][1]], [q[1][0], y, q[1][1]], color, alpha);
  }

  /** A horizontal quad facing down. */
  bottom(q: Quad, y: number, color: Rgb): void {
    this.quad([q[0][0], y, q[0][1]], [q[1][0], y, q[1][1]], [q[2][0], y, q[2][1]], [q[3][0], y, q[3][1]], color);
  }

  /** A closed upright prism over a quad (walls out, top up; `bottom` adds the underside). */
  prism(q: Quad, y0: number, y1: number, color: Rgb, opts: { top?: Rgb; bottom?: boolean } = {}): void {
    for (let k = 0; k < 4; k++) {
      const a = q[k]!;
      const b = q[(k + 1) % 4]!;
      this.wall(a[0], a[1], b[0], b[1], y0, y1, color);
    }
    this.top(q, y1, opts.top ?? color);
    if (opts.bottom === true) this.bottom(q, y0, color);
  }

  /** An axis-free box: center, half extents along a unit direction `ux` (x, z) and its left, height y0..y1. */
  box(cx: number, cz: number, ux: number, uz: number, hx: number, hz: number, y0: number, y1: number, color: Rgb, top?: Rgb): void {
    const lx = -uz;
    const lz = ux;
    const c = (sx: number, sz: number): [number, number] => [cx + ux * hx * sx + lx * hz * sz, cz + uz * hx * sx + lz * hz * sz];
    this.prism([c(-1, -1), c(1, -1), c(1, 1), c(-1, 1)], y0, y1, color, top === undefined ? {} : { top });
  }

  /** An upright n-sided cylinder (or cone when `r1` differs), capped on top. */
  cylinder(cx: number, cz: number, r0: number, r1: number, y0: number, y1: number, sides: number, color: Rgb, cap = true): void {
    const at = (k: number, r: number): [number, number] => [cx + Math.cos((k / sides) * Math.PI * 2) * r, cz + Math.sin((k / sides) * Math.PI * 2) * r];
    for (let k = 0; k < sides; k++) {
      // The angle grows from +x toward +z, so the outside is to the right of k → k + 1 (as `wall` faces).
      const a0 = at(k, r0);
      const b0 = at(k + 1, r0);
      const a1 = at(k, r1);
      const b1 = at(k + 1, r1);
      this.quad([a0[0], y0, a0[1]], [a1[0], y1, a1[1]], [b1[0], y1, b1[1]], [b0[0], y0, b0[1]], color);
    }
    if (cap && r1 > 1e-6) {
      for (let k = 0; k < sides; k++) {
        const a = at(k, r1);
        const b = at(k + 1, r1);
        this.tri([cx, y1, cz], [b[0], y1, b[1]], [a[0], y1, a[1]], color);
      }
    }
  }

  /** A flat strip along the ground from a to b (x, z), `width` wide, at height y, facing up. */
  strip(ax: number, az: number, bx: number, bz: number, width: number, y: number, color: Rgb): void {
    const dx = bx - ax;
    const dz = bz - az;
    const l = Math.hypot(dx, dz);
    if (l < 1e-6) return;
    const lx = (-dz / l) * width / 2;
    const lz = (dx / l) * width / 2;
    this.top([[ax - lx, az - lz], [bx - lx, bz - lz], [bx + lx, bz + lz], [ax + lx, az + lz]], y, color);
  }

  /** A horizontal regular polygon facing up. */
  disc(cx: number, cz: number, r: number, y: number, sides: number, color: Rgb): void {
    for (let k = 0; k < sides; k++) {
      const a0 = (k / sides) * Math.PI * 2;
      const a1 = ((k + 1) / sides) * Math.PI * 2;
      this.tri([cx, y, cz], [cx + Math.cos(a1) * r, y, cz + Math.sin(a1) * r], [cx + Math.cos(a0) * r, y, cz + Math.sin(a0) * r], color);
    }
  }

  build(): CitySurface {
    const positions = new Float32Array(this.#p);
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = positions[i + k]!;
        if (v < min[k]!) min[k] = v;
        if (v > max[k]!) max[k] = v;
      }
    }
    if (positions.length === 0) {
      min.fill(0);
      max.fill(0);
    }
    return {
      positions, normals: new Float32Array(this.#n), uvs: new Float32Array(this.#uv), colors: new Float32Array(this.#c),
      indices: new Uint32Array(this.#i), min, max,
    };
  }
}

/** Collision triangles in world space. */
export class SolidBuilder {
  #v: number[] = [];
  #i: number[] = [];

  get triangleCount(): number {
    return this.#i.length / 3;
  }

  tri(a: V3, b: V3, c: V3): void {
    const base = this.#v.length / 3;
    this.#v.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    this.#i.push(base, base + 1, base + 2);
  }

  quad(a: V3, b: V3, c: V3, d: V3): void {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }

  wall(ax: number, az: number, bx: number, bz: number, y0: number, y1: number): void {
    if (y1 - y0 < 1e-6) return;
    this.quad([ax, y0, az], [ax, y1, az], [bx, y1, bz], [bx, y0, bz]);
  }

  top(q: Quad, y: number): void {
    this.quad([q[0][0], y, q[0][1]], [q[3][0], y, q[3][1]], [q[2][0], y, q[2][1]], [q[1][0], y, q[1][1]]);
  }

  prism(q: Quad, y0: number, y1: number): void {
    for (let k = 0; k < 4; k++) {
      const a = q[k]!;
      const b = q[(k + 1) % 4]!;
      this.wall(a[0], a[1], b[0], b[1], y0, y1);
    }
    this.top(q, y1);
  }

  build(): { vertices: Float32Array; indices: Uint32Array } {
    return { vertices: new Float32Array(this.#v), indices: new Uint32Array(this.#i) };
  }
}
