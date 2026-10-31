/**
 * Surfaces of revolution (an internal helper; Tracks build tyre stacks and cones with it): a
 * profile of (radius, y) points revolved about the local y axis. The profile runs bottom to top; with radius >= 0
 * everywhere the surface faces outward (the right-hand side of each profile segment, the
 * same rule as sweep outlines). `sweep` degrees < 360 leaves a wedge open.
 *
 * Normals are smooth around the revolution; along the profile they are smooth unless
 * `hard` (every profile segment flat — a faceted column). Caps close the bottom (facing
 * down) and top (facing up) when the end point's radius is above 0 and the revolution is
 * whole. uvs are meters / `tile`: u around the widest circumference, v along the profile.
 */

import type { Surface, V3 } from './mesh.js';
import { MeshBuilder } from './mesh.js';

export interface LatheSpec {
  readonly profile: readonly (readonly [number, number])[];
  readonly segments: number;
  /** Degrees. */
  readonly sweep: number;
  readonly caps: boolean;
  readonly hard: boolean;
  readonly tile: number;
}

export function latheMesh(spec: LatheSpec): Surface {
  const mesh = new MeshBuilder();
  const prof = spec.profile;
  const whole = spec.sweep >= 360;
  const columns = spec.segments + 1;
  const total = (spec.sweep * Math.PI) / 180;
  const maxR = Math.max(...prof.map((p) => p[0]));
  const around = (maxR * total) / spec.tile;
  // Per profile segment: 2D normal (dr, dy) → (dy, -dr), and cumulative length.
  const segN: [number, number][] = [];
  const along: number[] = [0];
  for (let i = 0; i + 1 < prof.length; i++) {
    const dr = prof[i + 1]![0] - prof[i]![0];
    const dy = prof[i + 1]![1] - prof[i]![1];
    const l = Math.hypot(dr, dy);
    along.push(along[i]! + l);
    segN.push(l > 0 ? [dy / l, -dr / l] : [1, 0]);
  }
  const ringOf = (radius: number, y: number, n2: readonly [number, number], v: number): number => {
    const base = mesh.vertexCount;
    for (let j = 0; j < columns; j++) {
      const a = (total * j) / spec.segments;
      const e: V3 = [Math.cos(a), 0, Math.sin(a)];
      mesh.vertex([e[0] * radius, y, e[2] * radius], [e[0] * n2[0], n2[1], e[2] * n2[0]], (around * j) / spec.segments, v);
    }
    return base;
  };
  const stitch = (lower: number, upper: number): void => {
    for (let j = 0; j < spec.segments; j++) {
      // (A_j, B_j, B_j+1, A_j+1) with A on the lower ring: counter-clockwise from outside.
      mesh.triangle(lower + j, upper + j, upper + j + 1);
      mesh.triangle(lower + j, upper + j + 1, lower + j + 1);
    }
  };
  if (spec.hard) {
    for (let i = 0; i + 1 < prof.length; i++) {
      const lower = ringOf(prof[i]![0], prof[i]![1], segN[i]!, -along[i]! / spec.tile);
      const upper = ringOf(prof[i + 1]![0], prof[i + 1]![1], segN[i]!, -along[i + 1]! / spec.tile);
      stitch(lower, upper);
    }
  } else {
    let previous = -1;
    for (let i = 0; i < prof.length; i++) {
      const a = segN[Math.max(0, i - 1)]!;
      const b = segN[Math.min(segN.length - 1, i)]!;
      const l = Math.hypot(a[0] + b[0], a[1] + b[1]);
      const n2: [number, number] = l > 0 ? [(a[0] + b[0]) / l, (a[1] + b[1]) / l] : b;
      const ring = ringOf(prof[i]![0], prof[i]![1], n2, -along[i]! / spec.tile);
      if (previous >= 0) stitch(previous, ring);
      previous = ring;
    }
  }
  if (spec.caps && whole) {
    const capAt = (radius: number, y: number, up: boolean): void => {
      if (radius <= 0) return;
      const n: V3 = [0, up ? 1 : -1, 0];
      const center = mesh.vertex([0, y, 0], n, 0, 0);
      const ring = mesh.vertexCount;
      for (let j = 0; j < spec.segments; j++) {
        const a = (total * j) / spec.segments;
        const x = Math.cos(a) * radius;
        const z = Math.sin(a) * radius;
        mesh.vertex([x, y, z], n, x / spec.tile, z / spec.tile);
      }
      for (let j = 0; j < spec.segments; j++) {
        const p = ring + j;
        const q = ring + ((j + 1) % spec.segments);
        // Angle increases from +x towards +z: seen from above (+y) that turns clockwise.
        if (up) mesh.triangle(center, q, p);
        else mesh.triangle(center, p, q);
      }
    };
    capAt(prof[0]![0], prof[0]![1], false);
    capAt(prof[prof.length - 1]![0], prof[prof.length - 1]![1], true);
  }
  return mesh.build(null);
}
