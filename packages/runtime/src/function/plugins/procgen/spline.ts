/**
 * Splines and their sampled centerlines, in the owning entity's local space.
 *
 * Curves. `catmull_rom` passes through every control point (centripetal parameterization,
 * α = 0.5: no cusps or self-loops on uneven spacing); open curves extend their ends by
 * mirroring the neighbour point. `bezier` is piecewise cubic: anchor, handle, handle,
 * anchor, handle, handle, anchor, … (3k + 1 points open, 3k closed — the last segment's
 * handles lead back to the first anchor). `linear` joins the points with straight lines.
 *
 * Sampling. The curve is measured by arc length and resampled at even steps of at most
 * `spacing` meters, so `distance` is true meters along the curve. Each sample has a frame:
 *
 *   - `level` (default): right = normalize(up_local × tangent), up = tangent × right —
 *     the profile stays upright, as roads, rails and race tracks expect. Where the tangent
 *     is vertical the previous sample's right is kept.
 *   - `transport`: rotation-minimizing frames (double reflection), which follow the
 *     curve through vertical loops and corkscrews (coasters, tubes). On a closed curve the
 *     twist left over after one lap is spread evenly along it, so the seam matches.
 *
 * Bank (degrees, positive leans the right side down) is the authored per-point bank,
 * interpolated smoothly between control points (anchors for bezier), plus the automatic
 * bank: `auto_bank` degrees at a turn of radius `bank_radius`, proportional to curvature
 * (sharper turns clamp at ±auto_bank), leaning into the turn, smoothed over `bank_radius`
 * meters of track. The bank rolls right and up about the tangent.
 */

import type { V3 } from './mesh.js';
import { cross, dot, length, normalize, sub } from './mesh.js';

export type CurveKind = 'catmull_rom' | 'bezier' | 'linear';
export type FrameMode = 'level' | 'transport';

export interface SplineSpec {
  readonly points: readonly V3[];
  readonly closed: boolean;
  readonly curve: CurveKind;
  readonly frame: FrameMode;
  /** Degrees per control point (anchors for bezier); empty = 0 everywhere. */
  readonly bank: readonly number[];
  readonly autoBank: number;
  readonly bankRadius: number;
  /** Most meters between samples. */
  readonly spacing: number;
}

export interface Sample {
  readonly distance: number;
  readonly point: [number, number, number];
  readonly tangent: [number, number, number];
  readonly right: [number, number, number];
  readonly up: [number, number, number];
  readonly bank: number;
}

export interface Centerline {
  readonly closed: boolean;
  readonly length: number;
  /** Closed: `count` samples, the seam not repeated. Open: from 0 to length inclusive. */
  readonly samples: readonly Sample[];
}

/** What is wrong with a spline spec (a sentence), or undefined. */
export function splineProblem(spec: SplineSpec): string | undefined {
  const n = spec.points.length;
  if (spec.curve === 'bezier') {
    if (spec.closed ? n < 3 || n % 3 !== 0 : n < 4 || (n - 1) % 3 !== 0) {
      return spec.closed
        ? `a closed bezier needs 3k points (anchor, handle, handle, ...), got ${n}`
        : `an open bezier needs 3k + 1 points (anchor, handle, handle, anchor, ...), got ${n}`;
    }
  } else if (n < 2 || (spec.closed && n < 3)) {
    return `needs at least ${spec.closed ? 3 : 2} points, got ${n}`;
  }
  const anchors = anchorCount(spec);
  if (spec.bank.length !== 0 && spec.bank.length !== anchors) {
    return `bank has ${spec.bank.length} values but the spline has ${anchors} ${spec.curve === 'bezier' ? 'anchors' : 'points'} (give one per point, or none)`;
  }
  if (!(spec.spacing > 0)) return 'spacing must be greater than 0';
  if (!(spec.bankRadius > 0)) return 'bank_radius must be greater than 0';
  for (let i = 0; i < n; i++) {
    const p = spec.points[i]!;
    if (!p.every(Number.isFinite)) return `point ${i} is not finite`;
  }
  return undefined;
}

function anchorCount(spec: SplineSpec): number {
  return spec.curve === 'bezier' ? (spec.closed ? spec.points.length / 3 : (spec.points.length - 1) / 3) : spec.points.length;
}

/** Segment count and a position/derivative evaluator over segment index + local t ∈ [0, 1]. */
interface Curve {
  readonly segments: number;
  eval(segment: number, t: number): { p: [number, number, number]; d: [number, number, number] };
}

function catmullRom(points: readonly V3[], closed: boolean): Curve {
  const n = points.length;
  const at = (i: number): V3 => {
    if (closed) return points[((i % n) + n) % n]!;
    if (i < 0) return sub2(points[0]!, points[1]!);
    if (i >= n) return sub2(points[n - 1]!, points[n - 2]!);
    return points[i]!;
  };
  const segments = closed ? n : n - 1;
  return {
    segments,
    eval(s, t) {
      const p0 = at(s - 1);
      const p1 = at(s);
      const p2 = at(s + 1);
      const p3 = at(s + 2);
      // Centripetal knots (Barry–Goldman pyramid), with a floor so coincident points don't divide by zero.
      const knot = (a: V3, b: V3): number => Math.max(Math.sqrt(length(sub(b, a))), 1e-4);
      const t0 = 0;
      const t1 = t0 + knot(p0, p1);
      const t2 = t1 + knot(p1, p2);
      const t3 = t2 + knot(p2, p3);
      const u = t1 + (t2 - t1) * t;
      const du = t2 - t1;
      const out: [number, number, number] = [0, 0, 0];
      const der: [number, number, number] = [0, 0, 0];
      for (let k = 0; k < 3; k++) {
        const a1 = ((t1 - u) * p0[k]! + (u - t0) * p1[k]!) / (t1 - t0);
        const a2 = ((t2 - u) * p1[k]! + (u - t1) * p2[k]!) / (t2 - t1);
        const a3 = ((t3 - u) * p2[k]! + (u - t2) * p3[k]!) / (t3 - t2);
        const b1 = ((t2 - u) * a1 + (u - t0) * a2) / (t2 - t0);
        const b2 = ((t3 - u) * a2 + (u - t1) * a3) / (t3 - t1);
        out[k] = ((t2 - u) * b1 + (u - t1) * b2) / (t2 - t1);
        // Derivatives of the pyramid with respect to u, times du/dt.
        const da1 = (p1[k]! - p0[k]!) / (t1 - t0);
        const da2 = (p2[k]! - p1[k]!) / (t2 - t1);
        const da3 = (p3[k]! - p2[k]!) / (t3 - t2);
        const db1 = (a2 - a1) / (t2 - t0) + ((t2 - u) * da1 + (u - t0) * da2) / (t2 - t0);
        const db2 = (a3 - a2) / (t3 - t1) + ((t3 - u) * da2 + (u - t1) * da3) / (t3 - t1);
        der[k] = ((b2 - b1) / (t2 - t1) + ((t2 - u) * db1 + (u - t1) * db2) / (t2 - t1)) * du;
      }
      return { p: out, d: der };
    },
  };
}

function bezier(points: readonly V3[], closed: boolean): Curve {
  const n = points.length;
  const segments = closed ? n / 3 : (n - 1) / 3;
  return {
    segments,
    eval(s, t) {
      const p0 = points[(3 * s) % n]!;
      const p1 = points[(3 * s + 1) % n]!;
      const p2 = points[(3 * s + 2) % n]!;
      const p3 = points[(3 * s + 3) % n]!;
      const m = 1 - t;
      const out: [number, number, number] = [0, 0, 0];
      const der: [number, number, number] = [0, 0, 0];
      for (let k = 0; k < 3; k++) {
        out[k] = m * m * m * p0[k]! + 3 * m * m * t * p1[k]! + 3 * m * t * t * p2[k]! + t * t * t * p3[k]!;
        der[k] = 3 * m * m * (p1[k]! - p0[k]!) + 6 * m * t * (p2[k]! - p1[k]!) + 3 * t * t * (p3[k]! - p2[k]!);
      }
      return { p: out, d: der };
    },
  };
}

function linear(points: readonly V3[], closed: boolean): Curve {
  const n = points.length;
  return {
    segments: closed ? n : n - 1,
    eval(s, t) {
      const a = points[s % n]!;
      const b = points[(s + 1) % n]!;
      const d = sub(b, a);
      return { p: [a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t], d };
    },
  };
}

function sub2(a: V3, b: V3): V3 {
  // Mirror b through a: a + (a - b).
  return [2 * a[0] - b[0], 2 * a[1] - b[1], 2 * a[2] - b[2]];
}

/** Sub-steps per segment used to measure arc length. */
const MEASURE_STEPS = 48;

/**
 * Build the sampled centerline of a valid spec (check `splineProblem` first). `place`
 * moves each evenly spaced sample (a terrain drape); tangents then come from the moved
 * neighbours (central differences) and distances are re-measured along them.
 */
export function centerline(spec: SplineSpec, place?: (p: V3) => V3): Centerline {
  const curve = spec.curve === 'bezier' ? bezier(spec.points, spec.closed)
    : spec.curve === 'linear' ? linear(spec.points, spec.closed) : catmullRom(spec.points, spec.closed);

  // 1. Arc-length table: (segment + t) → cumulative meters.
  const table: number[] = [0];
  const params: number[] = [0];
  let total = 0;
  let prev = curve.eval(0, 0).p;
  for (let s = 0; s < curve.segments; s++) {
    for (let k = 1; k <= MEASURE_STEPS; k++) {
      const t = k / MEASURE_STEPS;
      const p = curve.eval(s, t).p;
      total += length(sub(p, prev));
      prev = p;
      table.push(total);
      params.push(s + t);
    }
  }
  const len = total;
  const count = Math.max(spec.closed ? 3 : 1, Math.ceil(len / spec.spacing - 1e-9));
  const step = len / count;
  const sampleCount = spec.closed ? count : count + 1;

  // 2. Even resampling: distance → curve parameter (linear in the table), exact position.
  const raw: { distance: number; param: number; p: [number, number, number]; tangent: [number, number, number] }[] = [];
  let cursor = 0;
  for (let i = 0; i < sampleCount; i++) {
    const distance = i === sampleCount - 1 && !spec.closed ? len : i * step;
    while (cursor < table.length - 2 && table[cursor + 1]! < distance) cursor++;
    const span = table[cursor + 1]! - table[cursor]!;
    const f = span > 0 ? (distance - table[cursor]!) / span : 0;
    const param = Math.min(params[cursor]! + (params[cursor + 1]! - params[cursor]!) * f, curve.segments - 1e-9);
    const segment = Math.min(Math.floor(param), curve.segments - 1);
    const { p, d } = curve.eval(segment, param - segment);
    let tangent = normalize(d);
    if (length(tangent) === 0) tangent = raw.length > 0 ? raw[raw.length - 1]!.tangent : [0, 0, 1];
    raw.push({ distance, param, p, tangent });
  }

  let len2 = len;
  if (place !== undefined) {
    for (const s of raw) s.p = [...place(s.p)] as [number, number, number];
    const n = raw.length;
    const tangents = raw.map((s, i) => {
      const a = raw[spec.closed ? (i - 1 + n) % n : Math.max(0, i - 1)]!.p;
      const b = raw[spec.closed ? (i + 1) % n : Math.min(n - 1, i + 1)]!.p;
      const t = normalize(sub(b, a));
      return length(t) > 0 ? t : s.tangent;
    });
    let d = 0;
    raw.forEach((s, i) => {
      if (i > 0) d += length(sub(s.p, raw[i - 1]!.p));
      s.distance = d;
      s.tangent = tangents[i]!;
    });
    len2 = spec.closed ? d + length(sub(raw[0]!.p, raw[n - 1]!.p)) : d;
  }

  // 3. Frames.
  const rights: [number, number, number][] = [];
  const ups: [number, number, number][] = [];
  if (spec.frame === 'level') {
    let lastRight: [number, number, number] = [1, 0, 0];
    for (const s of raw) {
      let right = normalize(cross([0, 1, 0], s.tangent));
      if (length(right) < 0.5) right = normalize(sub(lastRight, scaleBy(s.tangent, dot(lastRight, s.tangent))));
      lastRight = right;
      rights.push(right);
      ups.push(cross(s.tangent, right));
    }
  } else {
    transportFrames(raw.map((s) => s.p), raw.map((s) => s.tangent), spec.closed, rights, ups);
  }

  // 4. Bank: authored (per anchor, smoothstep between) + automatic (curvature).
  const anchors = anchorCount(spec);
  const authored = raw.map((s) => {
    if (spec.bank.length === 0) return 0;
    // Curve parameter → anchor index: bezier and the others both have one segment per anchor pair.
    const seg = Math.min(Math.floor(s.param), curve.segments - 1);
    const f = s.param - seg;
    const a = spec.bank[seg % anchors]!;
    const b = spec.bank[(seg + 1) % anchors]!;
    const e = f * f * (3 - 2 * f);
    return a + (b - a) * e;
  });
  const auto = new Array<number>(raw.length).fill(0);
  if (spec.autoBank !== 0 && raw.length >= 3) {
    for (let i = 0; i < raw.length; i++) {
      const a = spec.closed ? (i - 1 + raw.length) % raw.length : Math.max(0, i - 1);
      const b = spec.closed ? (i + 1) % raw.length : Math.min(raw.length - 1, i + 1);
      const db = b < i && spec.closed ? raw[b]!.distance + len2 : raw[b]!.distance;
      const da = a > i && spec.closed ? raw[a]!.distance - len2 : raw[a]!.distance;
      const ds = db - da;
      if (ds <= 0) continue;
      const turn = dot(sub(raw[b]!.tangent, raw[a]!.tangent), rights[i]!) / ds;
      auto[i] = clamp(spec.autoBank * spec.bankRadius * turn, -Math.abs(spec.autoBank), Math.abs(spec.autoBank));
    }
    smoothInPlace(auto, Math.max(1, Math.round(spec.bankRadius / step / 2)), spec.closed);
  }

  const samples: Sample[] = raw.map((s, i) => {
    const bank = authored[i]! + auto[i]!;
    const r = (bank * Math.PI) / 180;
    const c = Math.cos(r);
    const sn = Math.sin(r);
    const right0 = rights[i]!;
    const up0 = ups[i]!;
    const right: [number, number, number] = [right0[0] * c - up0[0] * sn, right0[1] * c - up0[1] * sn, right0[2] * c - up0[2] * sn];
    const up: [number, number, number] = [up0[0] * c + right0[0] * sn, up0[1] * c + right0[1] * sn, up0[2] * c + right0[2] * sn];
    return { distance: s.distance, point: s.p, tangent: s.tangent, right, up, bank };
  });
  return { closed: spec.closed, length: len2, samples };
}

function scaleBy(v: V3, s: number): [number, number, number] { return [v[0] * s, v[1] * s, v[2] * s]; }
function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }

/** Box-filter a series `passes` = 2 times with a half-width of `radius` samples. */
function smoothInPlace(values: number[], radius: number, closed: boolean): void {
  const n = values.length;
  for (let pass = 0; pass < 2; pass++) {
    const copy = values.slice();
    for (let i = 0; i < n; i++) {
      let sum = 0;
      let count = 0;
      for (let k = -radius; k <= radius; k++) {
        let j = i + k;
        if (closed) j = ((j % n) + n) % n;
        else if (j < 0 || j >= n) continue;
        sum += copy[j]!;
        count++;
      }
      values[i] = sum / count;
    }
  }
}

/** Rotation-minimizing frames by double reflection (Wang, Jüttler, Zheng, Liu 2008); closed loops spread the leftover twist. */
function transportFrames(
  points: readonly V3[], tangents: readonly [number, number, number][], closed: boolean,
  rights: [number, number, number][], ups: [number, number, number][],
): void {
  const t0 = tangents[0]!;
  let r0 = normalize(cross([0, 1, 0], t0));
  if (length(r0) < 0.5) r0 = normalize(cross([0, 0, 1], t0));
  rights.push(r0);
  const n = points.length;
  const steps = closed ? n : n - 1;
  const transported: [number, number, number][] = [r0];
  for (let i = 0; i < steps; i++) {
    const j = (i + 1) % n;
    const r = transported[i]!;
    const v1 = sub(points[j]!, points[i]!);
    const c1 = dot(v1, v1);
    if (c1 < 1e-18) {
      transported.push(r);
      continue;
    }
    const rL = sub(r, scaleBy(v1, (2 / c1) * dot(v1, r)));
    const tL = sub(tangents[i]!, scaleBy(v1, (2 / c1) * dot(v1, tangents[i]!)));
    const v2 = sub(tangents[j]!, tL);
    const c2 = dot(v2, v2);
    const next = c2 < 1e-18 ? rL : sub(rL, scaleBy(v2, (2 / c2) * dot(v2, rL)));
    transported.push(normalize(next));
  }
  let twist = 0;
  if (closed) {
    // Angle from the transported-back right to the starting right, about the first tangent.
    const back = transported[n]!;
    const up0 = cross(t0, r0);
    twist = Math.atan2(dot(back, up0), dot(back, r0));
  }
  rights.length = 0;
  for (let i = 0; i < n; i++) {
    const t = tangents[i]!;
    let r = transported[i]!;
    if (twist !== 0) {
      // Undo the fraction of the twist accumulated so far: rotate right towards up by -twist·i/n.
      const a = (-twist * i) / n;
      const u = cross(t, r);
      r = normalize([r[0] * Math.cos(a) + u[0] * Math.sin(a), r[1] * Math.cos(a) + u[1] * Math.sin(a), r[2] * Math.cos(a) + u[2] * Math.sin(a)]);
    }
    rights.push(r);
    ups.push(cross(t, r));
  }
}

// ── Queries ─────────────────────────────────────────────────────────────────────

/** The sample at a distance, interpolated (wrapped on closed lines, clamped on open ones). */
export function sampleAt(line: Centerline, distance: number): Sample {
  const s = line.samples;
  const L = line.length;
  let d = distance;
  if (line.closed) d = ((d % L) + L) % L;
  else d = clamp(d, 0, L);
  const count = s.length;
  // Binary search for the last sample at or before d.
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s[mid]!.distance <= d) lo = mid;
    else hi = mid - 1;
  }
  const a = s[lo]!;
  const bIndex = lo + 1 < count ? lo + 1 : line.closed ? 0 : lo;
  const b = s[bIndex]!;
  const bDistance = bIndex === 0 && line.closed ? L : b.distance;
  const span = bDistance - a.distance;
  const f = span > 0 ? (d - a.distance) / span : 0;
  return blend(a, b, f, d);
}

function blend(a: Sample, b: Sample, f: number, distance: number): Sample {
  const mix = (x: V3, y: V3): [number, number, number] => [x[0] + (y[0] - x[0]) * f, x[1] + (y[1] - x[1]) * f, x[2] + (y[2] - x[2]) * f];
  return {
    distance,
    point: mix(a.point, b.point),
    tangent: normalize(mix(a.tangent, b.tangent)),
    right: normalize(mix(a.right, b.right)),
    up: normalize(mix(a.up, b.up)),
    bank: a.bank + (b.bank - a.bank) * f,
  };
}

export interface Nearest {
  readonly sample: Sample;
  readonly lateral: number;
  readonly offset: number;
}

/** The nearest point on the polyline through the samples (every segment tested: O(samples)). */
export function nearestOn(line: Centerline, q: V3): Nearest {
  const s = line.samples;
  const segments = line.closed ? s.length : s.length - 1;
  let best = Infinity;
  let bestI = 0;
  let bestF = 0;
  for (let i = 0; i < segments; i++) {
    const a = s[i]!.point;
    const b = s[(i + 1) % s.length]!.point;
    const ab = sub(b, a);
    const l2 = dot(ab, ab);
    const f = l2 > 0 ? clamp(dot(sub(q, a), ab) / l2, 0, 1) : 0;
    const p: V3 = [a[0] + ab[0] * f, a[1] + ab[1] * f, a[2] + ab[2] * f];
    const d2 = dot(sub(q, p), sub(q, p));
    if (d2 < best) {
      best = d2;
      bestI = i;
      bestF = f;
    }
  }
  const a = s[bestI]!;
  const bIndex = (bestI + 1) % s.length;
  const b = s[segments === 0 ? bestI : bIndex]!;
  const bDistance = bIndex === 0 && line.closed ? line.length : b.distance;
  const sample = blend(a, b, bestF, a.distance + (bDistance - a.distance) * bestF);
  const delta = sub(q, sample.point);
  return { sample, lateral: dot(delta, sample.right), offset: Math.sqrt(best) };
}
