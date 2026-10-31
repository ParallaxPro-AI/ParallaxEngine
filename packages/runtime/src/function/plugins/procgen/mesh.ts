/**
 * Triangle meshes as plain arrays: what every generator here emits. A `MeshBuilder`
 * collects one surface (one material); `build` returns it as typed arrays with its bounds.
 * Winding is counter-clockwise seen from where the normal points.
 */

export type V3 = readonly [number, number, number];

export interface Surface {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
  /** sRGB RGBA per vertex, or null (white). */
  readonly colors: Float32Array | null;
  readonly indices: Uint32Array;
  readonly min: V3;
  readonly max: V3;
}

export class MeshBuilder {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly uvs: number[] = [];
  readonly indices: number[] = [];

  get vertexCount(): number { return this.positions.length / 3; }
  get triangleCount(): number { return this.indices.length / 3; }

  vertex(p: V3, n: V3, u: number, v: number): number {
    this.positions.push(p[0], p[1], p[2]);
    this.normals.push(n[0], n[1], n[2]);
    this.uvs.push(u, v);
    return this.positions.length / 3 - 1;
  }

  triangle(a: number, b: number, c: number): void {
    this.indices.push(a, b, c);
  }

  /** A flat quad, corners counter-clockwise seen from the front; uvs (0,0)…(w,h) in the given units. */
  quad(a: V3, b: V3, c: V3, d: V3, w = 1, h = 1): void {
    const n = normalize(cross(sub(b, a), sub(d, a)));
    const i = this.vertex(a, n, 0, h);
    this.vertex(b, n, w, h);
    this.vertex(c, n, w, 0);
    this.vertex(d, n, 0, 0);
    this.indices.push(i, i + 1, i + 2, i, i + 2, i + 3);
  }

  /**
   * An axis-aligned box from `min` to `max`; `faces` leaves out sides (`-x +x -y +y -z +z`
   * order). uvs are meters divided by `tile` on each face's plane, anchored at the origin
   * so textures run on across neighbouring boxes.
   */
  box(min: V3, max: V3, tile = 1, faces: readonly boolean[] = [true, true, true, true, true, true]): void {
    const [x0, y0, z0] = min;
    const [x1, y1, z1] = max;
    const sides: ReadonlyArray<readonly [V3, V3, V3, V3, V3]> = [
      [[-1, 0, 0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]],
      [[1, 0, 0], [x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]],
      [[0, -1, 0], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]],
      [[0, 1, 0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]],
      [[0, 0, -1], [x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]],
      [[0, 0, 1], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]],
    ];
    sides.forEach(([n, a, b, c, d], side) => {
      if (faces[side] !== true) return;
      if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) return;
      const u = normalize(sub(b, a));
      const v = normalize(sub(d, a));
      const i = this.vertexCount;
      for (const p of [a, b, c, d]) this.vertex(p, n, dot(p, u) / tile, -dot(p, v) / tile);
      this.indices.push(i, i + 1, i + 2, i, i + 2, i + 3);
    });
  }

  /**
   * A planar convex polygon (counter-clockwise seen from its front), fanned from its first
   * corner; repeated consecutive corners are dropped (a hip roof's ridge of length 0).
   */
  polygon(input: readonly V3[], tile = 1): void {
    const corners = input.filter((c, i) => {
      const p = input[(i + input.length - 1) % input.length]!;
      return Math.abs(c[0] - p[0]) + Math.abs(c[1] - p[1]) + Math.abs(c[2] - p[2]) > 1e-9;
    });
    if (corners.length < 3) return;
    // Newell's normal: robust for any planar polygon.
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let i = 0; i < corners.length; i++) {
      const a = corners[i]!;
      const b = corners[(i + 1) % corners.length]!;
      nx += (a[1] - b[1]) * (a[2] + b[2]);
      ny += (a[2] - b[2]) * (a[0] + b[0]);
      nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    const n = normalize([nx, ny, nz]);
    const ax = normalize(sub(corners[1]!, corners[0]!));
    const ay = cross(n, ax);
    const base = this.vertexCount;
    for (const c of corners) {
      const d = sub(c, corners[0]!);
      this.vertex(c, n, dot(d, ax) / tile, -dot(d, ay) / tile);
    }
    for (let k = 1; k + 1 < corners.length; k++) this.indices.push(base, base + k, base + k + 1);
  }

  /** A copy facing the other way: normals negated, every triangle's winding reversed. */
  flipped(): MeshBuilder {
    const out = new MeshBuilder();
    out.positions.push(...this.positions);
    out.normals.push(...this.normals.map((v) => -v));
    out.uvs.push(...this.uvs);
    for (let i = 0; i < this.indices.length; i += 3) out.indices.push(this.indices[i]!, this.indices[i + 2]!, this.indices[i + 1]!);
    return out;
  }

  append(other: MeshBuilder): void {
    const base = this.vertexCount;
    this.positions.push(...other.positions);
    this.normals.push(...other.normals);
    this.uvs.push(...other.uvs);
    for (const i of other.indices) this.indices.push(base + i);
  }

  build(colors: readonly number[] | null = null): Surface {
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < this.positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = this.positions[i + k]!;
        if (v < min[k]!) min[k] = v;
        if (v > max[k]!) max[k] = v;
      }
    }
    if (this.positions.length === 0) {
      min.fill(0);
      max.fill(0);
    }
    return {
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      uvs: new Float32Array(this.uvs),
      colors: colors === null ? null : new Float32Array(colors),
      indices: new Uint32Array(this.indices),
      min,
      max,
    };
  }
}

/** Positions and indices of several surfaces as one triangle list, transformed by a column-major matrix. */
export function collisionOf(surfaces: readonly Surface[], matrix: Float32Array): { vertices: Float32Array; indices: Uint32Array } {
  let vertexCount = 0;
  let indexCount = 0;
  for (const s of surfaces) {
    vertexCount += s.positions.length / 3;
    indexCount += s.indices.length;
  }
  const vertices = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(indexCount);
  let v = 0;
  let i = 0;
  const m = matrix;
  for (const s of surfaces) {
    const base = v / 3;
    for (let k = 0; k < s.positions.length; k += 3) {
      const x = s.positions[k]!;
      const y = s.positions[k + 1]!;
      const z = s.positions[k + 2]!;
      vertices[v++] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
      vertices[v++] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
      vertices[v++] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
    }
    for (const index of s.indices) indices[i++] = base + index;
  }
  return { vertices, indices };
}

// ── Small vector helpers (plain tuples, no allocation of classes) ────────────────

export function add(a: V3, b: V3): [number, number, number] { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
export function sub(a: V3, b: V3): [number, number, number] { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
export function scale(a: V3, s: number): [number, number, number] { return [a[0] * s, a[1] * s, a[2] * s]; }
export function dot(a: V3, b: V3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
export function cross(a: V3, b: V3): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
export function length(a: V3): number { return Math.hypot(a[0], a[1], a[2]); }
export function normalize(a: V3): [number, number, number] {
  const l = length(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}
export function lerp3(a: V3, b: V3, t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
/** `v` rotated about unit `axis` by `radians` (Rodrigues). */
export function rotate(v: V3, axis: V3, radians: number): [number, number, number] {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  const k = cross(axis, v);
  const d = dot(axis, v) * (1 - c);
  return [v[0] * c + k[0] * s + axis[0] * d, v[1] * c + k[1] * s + axis[1] * d, v[2] * c + k[2] * s + axis[2] * d];
}
