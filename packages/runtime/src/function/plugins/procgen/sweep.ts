/**
 * Profiles swept along a centerline (spline.ts): roads, kerbs, walls, rails, tubes, pipes,
 * coaster channels — any 2D outline.
 *
 * Profiles. An outline is 2D points in the path's cross-section: x along the sample's
 * `right`, y along its `up`, meters. Each segment faces to its right-hand side: closed
 * outlines run counter-clockwise (seen with x right, y up) and face outward; an open
 * surface such as a road top runs right to left so it faces up. `smooth` outlines share
 * normals across their corners (tubes); others are faceted (each segment flat).
 *
 * Built-ins are unit-sized and scaled by the layer's width (x) and height (y), whose
 * defaults are the profile's own:
 *
 *   road      a slab, top at y = 0, 8 × 0.3
 *   ribbon    the top face only, 8 wide (draw double-sided to see it from below)
 *   kerb      a low rounded step, 1 × 0.12, sitting on y = 0
 *   wall      a solid wall standing on y = 0, 0.3 × 1.2
 *   rail      a pair of rails (gauge = width) with their tops at y = height, 1.5 × 0.15
 *   tube      a circle around the path, outward faces (pipes seen from outside), 1 × 1
 *   pipe      a circle facing inward (ride inside it), 4 × 4
 *   channel   the bottom half of a circle facing inward (coaster/water-slide trough), 3 × 1.5
 *
 * Geometry. One ring of vertices per path sample per outline segment (hard edges between
 * segments, smooth along the path); closed paths repeat the first ring at the end so the
 * texture runs on across the seam (v = length). uvs are meters: u across the outline
 * divided by `uvWidth`, v along the path divided by `uvLength`. Stripes (kerbs, lane
 * markings) color the rings by distance in bands of `stripe` meters, cycling `colors`;
 * band edges get their own rings so the colors change sharply. Open outlines on open
 * paths end open; `caps` closes the ends of a closed outline on an open path (fanned from
 * its centroid: convex outlines).
 */

import type { Surface, V3 } from './mesh.js';
import { MeshBuilder } from './mesh.js';
import type { Centerline, Sample } from './spline.js';
import { sampleAt } from './spline.js';

export interface Outline {
  readonly points: readonly (readonly [number, number])[];
  readonly closed: boolean;
  readonly smooth: boolean;
}

export interface Profile {
  readonly outlines: readonly Outline[];
  /** Default layer width and height (meters). */
  readonly width: number;
  readonly height: number;
}

function circle(segments: number, inward: boolean, from = 0, to = Math.PI * 2, closed = true): Outline {
  const points: [number, number][] = [];
  const n = closed ? segments : segments + 1;
  for (let i = 0; i < n; i++) {
    const a = from + ((to - from) * i) / segments;
    points.push([0.5 * Math.cos(a), 0.5 * Math.sin(a)]);
  }
  return { points: inward ? points.reverse() : points, closed, smooth: true };
}

export const BUILTIN_PROFILES: Readonly<Record<string, Profile>> = {
  road: { outlines: [{ points: [[-0.5, -1], [0.5, -1], [0.5, 0], [-0.5, 0]], closed: true, smooth: false }], width: 8, height: 0.3 },
  ribbon: { outlines: [{ points: [[0.5, 0], [-0.5, 0]], closed: false, smooth: false }], width: 8, height: 1 },
  kerb: { outlines: [{ points: [[-0.5, 0], [0.5, 0], [0.5, 0.6], [0.3, 1], [-0.3, 1], [-0.5, 0.6]], closed: true, smooth: false }], width: 1, height: 0.12 },
  wall: { outlines: [{ points: [[-0.5, 0], [0.5, 0], [0.5, 1], [-0.5, 1]], closed: true, smooth: false }], width: 0.3, height: 1.2 },
  rail: {
    outlines: [-0.5, 0.5].map((x): Outline => ({
      points: [[x - 0.025, 0], [x + 0.025, 0], [x + 0.025, 1], [x - 0.025, 1]], closed: true, smooth: false,
    })),
    width: 1.5, height: 0.15,
  },
  tube: { outlines: [circle(16, false)], width: 1, height: 1 },
  pipe: { outlines: [circle(24, true)], width: 4, height: 4 },
  // Bottom half from the right rim (angle 0) down and round to the left rim (-π): faces the center.
  channel: { outlines: [{ ...circle(12, false, 0, -Math.PI, false), smooth: true }], width: 3, height: 3 },
};

export interface SweepLayerSpec {
  readonly profile: Profile;
  readonly width: number;
  readonly height: number;
  /** Meters along right and up. */
  readonly offset: readonly [number, number];
  readonly uvLength: number;
  readonly uvWidth: number;
  /** Path distances; `end` undefined = the whole path. */
  readonly start: number;
  readonly end: number | undefined;
  readonly caps: boolean;
  /** Stripe band length (meters, > 0) with the colors cycled; undefined = one color. */
  readonly stripe: number | undefined;
  readonly colors: readonly (readonly [number, number, number, number])[];
}

/** The distances rings are built at: every path sample in [start, end], plus stripe edges. */
function ringDistances(line: Centerline, spec: SweepLayerSpec): { distances: number[]; band: number[] } {
  const L = line.length;
  const start = Math.max(0, Math.min(spec.start, L));
  const end = Math.max(start, Math.min(spec.end ?? L, L));
  const distances: number[] = [];
  for (const s of line.samples) if (s.distance >= start && s.distance <= end) distances.push(s.distance);
  if (distances[0] !== start) distances.unshift(start);
  if (distances[distances.length - 1] !== end) distances.push(end);
  if (spec.stripe === undefined) return { distances, band: distances.map(() => 0) };
  // Each stripe edge strictly inside the range becomes twin rings: the end of band k - 1, the start of band k.
  const stripe = spec.stripe;
  const out: number[] = [];
  const band: number[] = [];
  const push = (d: number, k: number): void => {
    out.push(d);
    band.push(k);
  };
  push(distances[0]!, Math.floor(distances[0]! / stripe));
  for (let i = 1; i < distances.length; i++) {
    const prev = distances[i - 1]!;
    const d = distances[i]!;
    for (let k = Math.floor(prev / stripe) + 1; k * stripe <= d && k * stripe < end; k++) {
      push(k * stripe, k - 1);
      push(k * stripe, k);
    }
    if (out[out.length - 1] === d) continue;
    // A ring ending exactly on an edge (the range's end) closes the band before it.
    push(d, Math.ceil(d / stripe) - 1);
  }
  return { distances: out, band };
}

/** Sweep one layer: a surface per call (one material), colors present when the layer is striped or tinted per vertex. */
export function sweepLayer(line: Centerline, spec: SweepLayerSpec): Surface {
  const mesh = new MeshBuilder();
  const colors: number[] = [];
  const { distances, band } = ringDistances(line, spec);
  if (distances.length < 2) return mesh.build(null);
  const rings: Sample[] = distances.map((d, i) => {
    // The seam ring of a whole closed sweep is the first sample exactly (frames match).
    const s = sampleAt(line, d);
    return i === distances.length - 1 && line.closed && d === line.length ? { ...sampleAt(line, 0), distance: d } : s;
  });
  const striped = spec.stripe !== undefined && spec.colors.length > 0;
  const colorOf = (ring: number): readonly number[] => {
    if (!striped) return spec.colors[0] ?? [1, 1, 1, 1];
    const n = spec.colors.length;
    return spec.colors[((band[ring]! % n) + n) % n]!;
  };
  const W = spec.width;
  const H = spec.height;
  const [ox, oy] = spec.offset;
  for (const outline of spec.profile.outlines) {
    const pts = outline.points.map(([x, y]) => [x * W + ox, y * H + oy] as const);
    const count = pts.length;
    const segments = outline.closed ? count : count - 1;
    // Cumulative outline length (u) at each point; and per segment 2D normals.
    const u: number[] = [0];
    const segNormal: [number, number][] = [];
    for (let j = 0; j < segments; j++) {
      const a = pts[j]!;
      const b = pts[(j + 1) % count]!;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const l = Math.hypot(dx, dy);
      u.push(u[j]! + l);
      segNormal.push(l > 0 ? [dy / l, -dx / l] : [0, 1]);
    }
    const pointNormal = (j: number, seg: number): readonly [number, number] => {
      if (!outline.smooth) return segNormal[seg]!;
      // Average of the segments meeting at point j (open ends: their one segment).
      const before = outline.closed ? segNormal[(j - 1 + segments) % segments] : segNormal[j - 1];
      const after = outline.closed ? segNormal[j % segments] : segNormal[j];
      const a = before ?? after!;
      const b = after ?? before!;
      const x = a[0] + b[0];
      const y = a[1] + b[1];
      const l = Math.hypot(x, y);
      return l > 0 ? [x / l, y / l] : segNormal[seg]!;
    };
    for (let j = 0; j < segments; j++) {
      const ja = j;
      const jb = (j + 1) % count;
      const base = mesh.vertexCount;
      for (let r = 0; r < rings.length; r++) {
        const s = rings[r]!;
        const color = colorOf(r);
        for (const [k, uu] of [[ja, u[j]!], [jb, u[j + 1]!]] as const) {
          const p = pts[k]!;
          const n2 = pointNormal(k, j);
          const position: V3 = [
            s.point[0] + s.right[0] * p[0] + s.up[0] * p[1],
            s.point[1] + s.right[1] * p[0] + s.up[1] * p[1],
            s.point[2] + s.right[2] * p[0] + s.up[2] * p[1],
          ];
          const normal: V3 = [
            s.right[0] * n2[0] + s.up[0] * n2[1], s.right[1] * n2[0] + s.up[1] * n2[1], s.right[2] * n2[0] + s.up[2] * n2[1],
          ];
          mesh.vertex(position, normal, uu / spec.uvWidth, s.distance / spec.uvLength);
          colors.push(color[0]!, color[1]!, color[2]!, color[3]!);
        }
      }
      for (let r = 0; r + 1 < rings.length; r++) {
        // A zero-length step is a stripe edge: no quad between the twin rings.
        if (rings[r + 1]!.distance === rings[r]!.distance) continue;
        const a0 = base + r * 2;
        const b0 = a0 + 1;
        const a1 = a0 + 2;
        const b1 = a0 + 3;
        mesh.triangle(a0, b0, b1);
        mesh.triangle(a0, b1, a1);
      }
    }
    if (spec.caps && outline.closed && !(line.closed && distances[0] === 0 && distances[distances.length - 1] === line.length)) {
      cap(mesh, colors, rings[0]!, pts, colorOf(0), -1);
      cap(mesh, colors, rings[rings.length - 1]!, pts, colorOf(rings.length - 1), 1);
    }
  }
  return mesh.build(colors);
}

/** A fan over a closed outline at one ring; `facing` -1 looks back along the path (start), +1 forward (end). */
function cap(mesh: MeshBuilder, colors: number[], s: Sample, pts: readonly (readonly [number, number])[], color: readonly number[], facing: number): void {
  const n: V3 = [s.tangent[0] * facing, s.tangent[1] * facing, s.tangent[2] * facing];
  const world = (x: number, y: number): V3 => [
    s.point[0] + s.right[0] * x + s.up[0] * y, s.point[1] + s.right[1] * x + s.up[1] * y, s.point[2] + s.right[2] * x + s.up[2] * y,
  ];
  let cx = 0;
  let cy = 0;
  for (const p of pts) {
    cx += p[0];
    cy += p[1];
  }
  cx /= pts.length;
  cy /= pts.length;
  const center = mesh.vertex(world(cx, cy), n, cx, cy);
  colors.push(color[0]!, color[1]!, color[2]!, color[3]!);
  const ring: number[] = [];
  for (const p of pts) {
    ring.push(mesh.vertex(world(p[0], p[1]), n, p[0], p[1]));
    colors.push(color[0]!, color[1]!, color[2]!, color[3]!);
  }
  // right × up = tangent: the counter-clockwise outline faces +tangent (the end cap); the start cap reverses it.
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k]!;
    const b = ring[(k + 1) % ring.length]!;
    if (facing > 0) mesh.triangle(center, a, b);
    else mesh.triangle(center, b, a);
  }
}
