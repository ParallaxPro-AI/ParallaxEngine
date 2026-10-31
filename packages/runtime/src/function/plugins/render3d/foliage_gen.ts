/**
 * The toolkit the built-in foliage generators share (foliage_tree.ts, foliage_rock.ts,
 * grass.ts): a mesh builder, small vector helpers and a hashed random stream.
 *
 * Generators are pure functions of (spec, seed, detail): every random value comes from
 * `hash2` (core/values/ground_math.ts), so a look is the same in every session. Foliage
 * geometry is rendering only (collision uses the layer's radius and height), so the
 * generators may use Math.sin/cos freely.
 */

import { hash2 } from '../../../core/index.js';
import type { Geometry3d } from '../../../core/index.js';

export type Vec3 = [number, number, number];

export const add = (a: readonly number[], b: readonly number[]): Vec3 => [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!];
export const sub = (a: readonly number[], b: readonly number[]): Vec3 => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
export const scale = (a: readonly number[], s: number): Vec3 => [a[0]! * s, a[1]! * s, a[2]! * s];
export const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
export const cross = (a: readonly number[], b: readonly number[]): Vec3 => [
  a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!,
];
export const length = (a: readonly number[]): number => Math.hypot(a[0]!, a[1]!, a[2]!);
export function normalize(a: readonly number[], fallback: readonly number[] = [0, 1, 0]): Vec3 {
  const l = length(a);
  return l > 1e-9 ? scale(a, 1 / l) : [fallback[0]!, fallback[1]!, fallback[2]!];
}
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** The part of `v` perpendicular to unit `axis`, normalized. */
export function perpendicular(v: readonly number[], axis: readonly number[]): Vec3 {
  const d = dot(v, axis);
  return normalize([v[0]! - axis[0]! * d, v[1]! - axis[1]! * d, v[2]! - axis[2]! * d], anyPerpendicular(axis));
}

/** Some unit vector perpendicular to unit `axis`. */
export function anyPerpendicular(axis: readonly number[]): Vec3 {
  return normalize(cross(axis, Math.abs(axis[1]!) < 0.9 ? [0, 1, 0] : [1, 0, 0]), [1, 0, 0]);
}

/** `v` turned `angle` radians about unit `axis` (Rodrigues). */
export function rotate(v: readonly number[], axis: readonly number[], angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = cross(axis, v);
  const d = dot(axis, v) * (1 - c);
  return [v[0]! * c + k[0]! * s + axis[0]! * d, v[1]! * c + k[1]! * s + axis[1]! * d, v[2]! * c + k[2]! * s + axis[2]! * d];
}

/** A hashed stream of numbers in [0, 1): stream k of a seed. */
export class Stream {
  readonly #seed: number;
  readonly #key: number;
  #i = 0;

  constructor(seed: number, key: number) {
    this.#seed = seed | 0;
    this.#key = key | 0;
  }

  next(): number {
    return hash2(this.#key, this.#i++, this.#seed);
  }

  /** Uniform in [-amount, amount]. */
  signed(amount: number): number {
    return (this.next() * 2 - 1) * amount;
  }
}

/** Geometry under construction: positions, normals, uvs, sRGB vertex colors, triangles. */
export class MeshBuilder {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly uvs: number[] = [];
  readonly colors: number[] = [];
  readonly indices: number[] = [];

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  get triangleCount(): number {
    return this.indices.length / 3;
  }

  vertex(p: readonly number[], n: readonly number[], u: number, v: number, color: readonly number[]): number {
    this.positions.push(p[0]!, p[1]!, p[2]!);
    const l = Math.hypot(n[0]!, n[1]!, n[2]!) || 1;
    this.normals.push(n[0]! / l, n[1]! / l, n[2]! / l);
    this.uvs.push(u, v);
    this.colors.push(color[0]!, color[1]!, color[2]!, 1);
    return this.positions.length / 3 - 1;
  }

  /** A triangle, wound so its face agrees with its vertices' normals. */
  triangle(a: number, b: number, c: number): void {
    const p = this.positions;
    const n = this.normals;
    const e1 = [p[b * 3]! - p[a * 3]!, p[b * 3 + 1]! - p[a * 3 + 1]!, p[b * 3 + 2]! - p[a * 3 + 2]!];
    const e2 = [p[c * 3]! - p[a * 3]!, p[c * 3 + 1]! - p[a * 3 + 1]!, p[c * 3 + 2]! - p[a * 3 + 2]!];
    const f = cross(e1, e2);
    const s = f[0] * (n[a * 3]! + n[b * 3]! + n[c * 3]!) + f[1] * (n[a * 3 + 1]! + n[b * 3 + 1]! + n[c * 3 + 1]!) + f[2] * (n[a * 3 + 2]! + n[b * 3 + 2]! + n[c * 3 + 2]!);
    if (s >= 0) this.indices.push(a, b, c);
    else this.indices.push(a, c, b);
  }

  /** A triangle exactly as given (counter-clockwise from its front). */
  rawTriangle(a: number, b: number, c: number): void {
    this.indices.push(a, b, c);
  }

  build(id: string): Geometry3d {
    const positions = Float32Array.from(this.positions);
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        if (positions[i + k]! < min[k]!) min[k] = positions[i + k]!;
        if (positions[i + k]! > max[k]!) max[k] = positions[i + k]!;
      }
    }
    if (positions.length === 0) {
      min.fill(0);
      max.fill(0);
    }
    return {
      id, positions, normals: Float32Array.from(this.normals), uvs: Float32Array.from(this.uvs),
      indices: positions.length / 3 > 65535 ? Uint32Array.from(this.indices) : Uint16Array.from(this.indices),
      joints: null, weights: null, colors: Float32Array.from(this.colors), min, max,
    };
  }
}
