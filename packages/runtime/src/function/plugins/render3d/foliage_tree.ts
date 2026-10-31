/**
 * Procedural trees and bushes: a species is a growth recipe, a seed grows a skeleton from
 * it, and the skeleton is meshed at a detail level. Ported from the platform engine's
 * foliage generator (tree_species / tree_skeleton / tree_mesh / leaf), in metres:
 *
 *   habit        `continuation` — each branch carries on past its laterals as a terminal
 *                shoot, so a trunk divides (deciduous); `whorl` — laterals ring a straight
 *                leader and shorten toward the top (conifers, palms)
 *   levels       trunk + up to three branch levels, each with its pitch, count, length,
 *                radius factor, start point, taper, gnarliness (a random walk that curls
 *                thin twigs more than thick limbs) and twist
 *   tropism      a pull toward +y (positive: reaching up, birch) or down (negative: a
 *                willow's weep), stronger on thin branches
 *   leaves       clusters along the last level (and the limbs one level in, so the big
 *                inner limbs aren't bare), each a CROSSED SPRAY: two alpha-cut quads at 90°
 *                carrying a generated sprig of leaflets (foliage_textures.ts), so a few
 *                thousand vertices read as tens of thousands of leaves
 *
 * Shading: leaf normals are bent toward the canopy-center→vertex direction, which lights a
 * crown as one soft volume instead of confetti; vertex colors darken the interior and the
 * underside (ambient occlusion) and warm the sunlit outside. Both faces of every leaf quad
 * are emitted with the same rounded normal (single-sided material), since a double-sided
 * material would flip the normal on the back face. Bark gets flare at the base, darker
 * junctions and a generated bark texture.
 *
 * Detail 0 is the near mesh; detail 1 (the mid tier) keeps fewer rings and sections, drops
 * the thinnest twigs and keeps a hashed half of the leaf clusters, grown to cover the same
 * crown. Trees are scaled to the look's nominal height, so collision sizes (spec.ts LOOKS)
 * match what is drawn.
 */

import type { Rgb } from '../../../core/index.js';
import { add, anyPerpendicular, clamp, cross, dot, lerp, MeshBuilder, normalize, perpendicular, rotate, scale, Stream, sub } from './foliage_gen.js';
import type { Vec3 } from './foliage_gen.js';

export type LeafArchetype = 'broad' | 'ovate' | 'needle' | 'frond' | 'lance';

interface BranchLevel {
  /** Pitch off the parent axis, degrees (> 90 points down). */
  readonly angle: number;
  /** Laterals per parent (whorl: per ring). */
  readonly count: number;
  readonly length: number;
  /** Times the parent's radius where it starts. */
  readonly radius: number;
  /** Lowest point along the parent a child starts at, 0..1. */
  readonly start: number;
  readonly sections: number;
  readonly segments: number;
  readonly taper: number;
  readonly gnarl: number;
  readonly twist: number;
}

export interface TreeSpec {
  readonly habit: 'continuation' | 'whorl';
  readonly trunk: {
    readonly length: number; readonly radius: number; readonly sections: number; readonly segments: number;
    readonly taper: number; readonly gnarl: number; readonly twist: number; readonly flare: number;
    /** Degrees the trunk starts off vertical (palms). */
    readonly lean?: number;
  };
  readonly branch: readonly BranchLevel[];
  /** + reaches up, − droops. */
  readonly tropism: number;
  readonly leaf: {
    readonly archetype: LeafArchetype | null;
    /** Clusters per last-level branch, and per branch one level in. */
    readonly clusters: number;
    readonly inner: number;
    readonly start: number;
    /** Spray length, metres. */
    readonly size: number;
    readonly variance: number;
    /** How far sprays hang toward −y, 0..1. */
    readonly droop: number;
    /** Sprays along the branch (fronds) instead of facing out of the crown. */
    readonly along?: boolean;
    /** Sprays held level, as a flat-topped crown (acacia). */
    readonly flat?: boolean;
  };
  /** Bark color (sRGB) and texture. */
  readonly bark: Rgb;
  readonly barkKind: 'rough' | 'birch' | 'smooth' | 'palm';
}

const L = (angle: number, count: number, length: number, radius: number, start: number, sections: number, segments: number, taper: number, gnarl: number, twist = 0): BranchLevel =>
  ({ angle, count, length, radius, start, sections, segments, taper, gnarl, twist });

/** The built-in species, by look (`tree:broadleaf`, `bush:round`, …). */
export const TREE_SPECS: Readonly<Record<string, TreeSpec>> = {
  // Broad deciduous (oak): short flared trunk dividing into a wide round crown.
  'tree:broadleaf': {
    habit: 'continuation',
    trunk: { length: 3.4, radius: 0.32, sections: 8, segments: 8, taper: 0.6, gnarl: 0.034, twist: 0.05, flare: 0.45 },
    branch: [L(52, 3, 2.6, 0.62, 0.42, 5, 6, 0.55, 0.076, 0.12), L(48, 3, 1.6, 0.6, 0.22, 3, 4, 0.6, 0.13, 0.1), L(42, 3, 0.85, 0.6, 0.12, 2, 3, 0.9, 0.17)],
    tropism: 0.12,
    leaf: { archetype: 'broad', clusters: 6, inner: 8, start: 0.1, size: 1.25, variance: 0.3, droop: 0.15 },
    bark: [0.33, 0.26, 0.2], barkKind: 'rough',
  },
  // Conifer: one straight leader, whorled laterals shortening to a cone, needle fans.
  'tree:pine': {
    habit: 'whorl',
    trunk: { length: 10.5, radius: 0.26, sections: 11, segments: 7, taper: 0.9, gnarl: 0.012, twist: 0, flare: 0.35 },
    branch: [L(100, 6, 2.6, 0.3, 0.16, 3, 3, 0.9, 0.06)],
    tropism: 0.04,
    leaf: { archetype: 'needle', clusters: 9, inner: 0, start: 0.05, size: 1.45, variance: 0.2, droop: 0.2 },
    bark: [0.3, 0.22, 0.17], barkKind: 'rough',
  },
  // Slender deciduous: pale pencil trunk, high late branching swept skyward.
  'tree:birch': {
    habit: 'continuation',
    trunk: { length: 5.2, radius: 0.15, sections: 8, segments: 6, taper: 0.6, gnarl: 0.027, twist: 0.03, flare: 0.2 },
    branch: [L(36, 3, 2.0, 0.5, 0.45, 5, 5, 0.55, 0.083, 0.1), L(34, 3, 1.3, 0.55, 0.2, 3, 4, 0.6, 0.14), L(30, 3, 0.7, 0.55, 0.1, 2, 3, 0.9, 0.2)],
    tropism: 0.3,
    leaf: { archetype: 'ovate', clusters: 5, inner: 6, start: 0.08, size: 0.95, variance: 0.35, droop: 0.2 },
    bark: [0.86, 0.85, 0.8], barkKind: 'birch',
  },
  // Weeping: limbs arc out and the long outer twigs hang to the ground.
  'tree:willow': {
    habit: 'continuation',
    trunk: { length: 3.6, radius: 0.32, sections: 7, segments: 7, taper: 0.6, gnarl: 0.042, twist: 0.06, flare: 0.5 },
    branch: [L(55, 3, 2.4, 0.55, 0.32, 5, 6, 0.55, 0.071, 0.1), L(65, 2, 1.9, 0.5, 0.2, 4, 4, 0.6, 0.061), L(80, 3, 2.0, 0.45, 0.1, 5, 3, 0.9, 0.049)],
    tropism: -0.5,
    leaf: { archetype: 'lance', clusters: 6, inner: 4, start: 0.05, size: 1.0, variance: 0.3, droop: 0.85, along: true },
    bark: [0.3, 0.25, 0.19], barkKind: 'rough',
  },
  // Savanna: short trunk, wide limbs fanning out to a flat-topped umbrella crown.
  'tree:acacia': {
    habit: 'continuation',
    trunk: { length: 2.8, radius: 0.28, sections: 8, segments: 7, taper: 0.55, gnarl: 0.04, twist: 0.05, flare: 0.4 },
    branch: [L(52, 4, 3.8, 0.62, 0.6, 5, 6, 0.6, 0.05, 0.08), L(80, 4, 2.4, 0.5, 0.3, 3, 4, 0.85, 0.06), L(72, 3, 1.0, 0.5, 0.2, 2, 3, 0.9, 0.12)],
    tropism: 0.08,
    leaf: { archetype: 'frond', clusters: 6, inner: 7, start: 0.25, size: 1.35, variance: 0.3, droop: 0, flat: true },
    bark: [0.36, 0.29, 0.21], barkKind: 'rough',
  },
  // Bare: gnarled, leafless.
  'tree:dead': {
    habit: 'continuation',
    trunk: { length: 4.4, radius: 0.27, sections: 10, segments: 7, taper: 0.68, gnarl: 0.082, twist: 0.1, flare: 0.55 },
    branch: [L(62, 3, 2.2, 0.55, 0.35, 6, 6, 0.6, 0.185, 0.15), L(58, 2, 1.3, 0.55, 0.2, 4, 4, 0.65, 0.27, 0.12), L(50, 2, 0.7, 0.5, 0.1, 3, 3, 0.95, 0.32)],
    tropism: 0.06,
    leaf: { archetype: null, clusters: 0, inner: 0, start: 0, size: 0, variance: 0, droop: 0 },
    bark: [0.4, 0.37, 0.33], barkKind: 'rough',
  },
  // Palm: a leaning, curving ringed trunk with a crown of long arching fronds.
  'tree:palm': {
    habit: 'whorl',
    trunk: { length: 8, radius: 0.2, sections: 10, segments: 8, taper: 0.3, gnarl: 0.01, twist: 0, flare: 0.3, lean: 12 },
    branch: [L(62, 6, 3.4, 0.25, 0.94, 6, 3, 0.9, 0.02)],
    tropism: -0.9,
    leaf: { archetype: 'frond', clusters: 6, inner: 0, start: 0.08, size: 1.2, variance: 0.15, droop: 0.2, along: true },
    bark: [0.45, 0.38, 0.29], barkKind: 'palm',
  },
  // Bushes: a short multi-stem base with leafy twigs (bush_round / bush_sprawl).
  'bush:round': {
    habit: 'continuation',
    trunk: { length: 0.3, radius: 0.04, sections: 3, segments: 5, taper: 0.5, gnarl: 0.12, twist: 0.05, flare: 0.2 },
    branch: [L(50, 9, 0.6, 0.6, 0.15, 3, 4, 0.7, 0.3, 0.1), L(45, 2, 0.3, 0.55, 0.3, 2, 3, 0.8, 0.4)],
    tropism: 0.15,
    leaf: { archetype: 'ovate', clusters: 3, inner: 3, start: 0.2, size: 0.55, variance: 0.4, droop: 0.1 },
    bark: [0.33, 0.27, 0.2], barkKind: 'smooth',
  },
  'bush:sprawl': {
    habit: 'continuation',
    trunk: { length: 0.22, radius: 0.035, sections: 2, segments: 5, taper: 0.55, gnarl: 0.2, twist: 0.08, flare: 0.15 },
    branch: [L(76, 8, 0.85, 0.6, 0.1, 3, 4, 0.68, 0.4, 0.12), L(62, 3, 0.4, 0.55, 0.35, 2, 3, 0.7, 0.45, 0.1)],
    tropism: 0.05,
    leaf: { archetype: 'broad', clusters: 2, inner: 3, start: 0.3, size: 0.5, variance: 0.5, droop: 0.15 },
    bark: [0.33, 0.28, 0.21], barkKind: 'smooth',
  },
};

// ── Skeleton ──────────────────────────────────────────────────────────────────

interface Frame {
  readonly o: Vec3;
  readonly d: Vec3;
  readonly s: Vec3;
  readonly r: number;
}

interface Branch {
  readonly level: number;
  readonly frames: readonly Frame[];
  readonly segments: number;
}

interface LeafAnchor {
  readonly p: Vec3;
  readonly d: Vec3;
  readonly scale: number;
  readonly hash: number;
}

export interface Skeleton {
  readonly branches: readonly Branch[];
  readonly leaves: readonly LeafAnchor[];
  readonly height: number;
}

const MAX_BRANCHES = 2500;
const GOLDEN = 137.50776 * (Math.PI / 180);
const RAD = Math.PI / 180;

function frameAt(frames: readonly Frame[], t: number): Frame {
  const last = frames.length - 1;
  if (last <= 0) return frames[0]!;
  const x = clamp(t, 0, 1) * last;
  const i = Math.min(Math.floor(x), last - 1);
  const a = frames[i]!;
  const b = frames[i + 1]!;
  const u = x - i;
  const d = normalize([lerp(a.d[0], b.d[0], u), lerp(a.d[1], b.d[1], u), lerp(a.d[2], b.d[2], u)], a.d);
  return {
    o: [lerp(a.o[0], b.o[0], u), lerp(a.o[1], b.o[1], u), lerp(a.o[2], b.o[2], u)], d,
    s: perpendicular([lerp(a.s[0], b.s[0], u), lerp(a.s[1], b.s[1], u), lerp(a.s[2], b.s[2], u)], d), r: lerp(a.r, b.r, u),
  };
}

interface Pending {
  readonly level: number;
  readonly o: Vec3;
  readonly d: Vec3;
  readonly s: Vec3;
  readonly length: number;
  readonly radius: number;
  readonly sections: number;
  readonly segments: number;
}

/** Grow a skeleton (breadth first; one hashed stream per branch, so branches don't shift each other). */
export function growSkeleton(spec: TreeSpec, seed: number): Skeleton {
  const levels = spec.branch.length;
  const branches: Branch[] = [];
  const leaves: LeafAnchor[] = [];
  const top = new Stream(seed, 0);
  const lean = (spec.trunk.lean ?? 0) * RAD;
  const leanYaw = top.next() * Math.PI * 2;
  const d0 = normalize([Math.sin(lean) * Math.cos(leanYaw), Math.cos(lean), Math.sin(lean) * Math.sin(leanYaw)]);
  const queue: Pending[] = [{
    level: 0, o: [0, 0, 0], d: d0, s: anyPerpendicular(d0),
    length: spec.trunk.length * (1 + top.signed(0.1)), radius: spec.trunk.radius * (1 + top.signed(0.1)),
    sections: spec.trunk.sections, segments: spec.trunk.segments,
  }];
  for (let head = 0; head < queue.length; head++) {
    const p = queue[head]!;
    const index = branches.length;
    const stream = new Stream(seed, index * 2 + 1);
    const wobble = new Stream(seed, index * 2 + 2);
    const last = p.level >= levels;
    const params = p.level === 0 ? spec.trunk : spec.branch[p.level - 1]!;
    const frames: Frame[] = [];
    let o = p.o;
    let d = p.d;
    let s = p.s;
    const step = p.length / p.sections;
    for (let i = 0; i <= p.sections; i++) {
      const along = i / p.sections;
      let r = p.radius * (1 - params.taper * along);
      if (p.level === 0 && spec.trunk.flare > 0 && along < 0.15) {
        const k = 1 - along / 0.15;
        r *= 1 + spec.trunk.flare * k * k;
      }
      if (i === p.sections && last) r = p.radius * 0.05;
      r = Math.max(r, 0.002);
      frames.push({ o, d, s, r });
      if (i === p.sections) break;
      o = add(o, scale(d, step));
      const gnarl = Math.min(0.6, params.gnarl * clamp(1 / Math.sqrt(r), 1, 4));
      if (gnarl > 0) {
        const dir = normalize([wobble.next() * 2 - 1, wobble.next() * 2 - 1, wobble.next() * 2 - 1]);
        d = normalize(add(d, scale(perpendicular(dir, d), gnarl * stream.next())), d);
      }
      if (params.twist !== 0) s = normalize(add(s, scale(cross(d, s), params.twist)), s);
      if (spec.tropism !== 0 && p.level > 0) {
        const pull = clamp((spec.tropism * 0.05) / Math.max(r, 0.03), -0.35, 0.35);
        d = normalize([d[0], d[1] + pull, d[2]], d);
      } else if (p.level === 0 && lean > 0) {
        d = normalize([d[0], d[1] + 0.04, d[2]], d); // a leaning trunk curves back up
      }
      s = perpendicular(s, d);
    }
    branches.push({ level: p.level, frames, segments: p.segments });

    const leaf = spec.leaf;
    const hang = (clusters: number, start: number, tag: number): void => {
      if (leaf.archetype === null || clusters <= 0) return;
      const ls = new Stream(seed, 0x4c450000 + index * 4 + tag);
      const span = (1 - start) / clusters;
      for (let i = 0; i < clusters; i++) {
        const f = frameAt(frames, start + (i + ls.next()) * span);
        leaves.push({ p: f.o, d: f.d, scale: Math.max(0.2, 1 + ls.signed(leaf.variance)), hash: ls.next() });
      }
    };
    if (p.level >= 1 && p.level === levels - 1) hang(leaf.inner, 0.25, 1);
    if (last) {
      hang(leaf.clusters, leaf.start, 0);
      continue;
    }
    const child = spec.branch[p.level]!;
    if (branches.length + queue.length - head >= MAX_BRANCHES) continue;
    if (spec.habit === 'continuation') {
      const tip = frames[frames.length - 1]!;
      queue.push({
        level: p.level + 1, o: tip.o, d: tip.d, s: tip.s, length: Math.max(0.02, child.length * (1 + stream.signed(0.18))),
        radius: tip.r, sections: child.sections, segments: p.segments,
      });
    }
    const whorl = spec.habit === 'whorl';
    // A whorl starting near the top (a palm's crown) is two rings; otherwise one per section.
    const rings = whorl ? (child.start > 0.8 ? 2 : Math.max(1, Math.round(p.sections * (1 - child.start)))) : child.count;
    const perRing = whorl ? child.count : 1;
    const ringStep = (1 - child.start) / rings;
    const offset = stream.next() * Math.PI * 2;
    for (let j = 0; j < rings; j++) {
      const t = clamp(child.start + (j + (whorl ? 0.5 + stream.signed(0.18) : stream.next())) * ringStep, 0, 1);
      const at = frameAt(frames, t);
      const b = cross(at.d, at.s);
      for (let k = 0; k < perRing; k++) {
        const a = offset + j * GOLDEN + (k * Math.PI * 2) / perRing;
        const radial = normalize(add(scale(at.s, Math.cos(a)), scale(b, Math.sin(a))));
        const pitch = (child.angle + stream.signed(7)) * RAD;
        const cd = normalize(add(scale(at.d, Math.cos(pitch)), scale(radial, Math.sin(pitch))));
        const shrink = whorl && child.start < 0.8 ? Math.max(0.15, 1 - t) : 1;
        queue.push({
          level: p.level + 1, o: at.o, d: cd, s: perpendicular(radial, cd),
          length: Math.max(0.02, child.length * shrink * (1 + stream.signed(0.18))),
          radius: Math.max(0.004, child.radius * at.r * (1 + stream.signed(0.12))), sections: child.sections, segments: child.segments,
        });
      }
    }
  }
  let height = 0;
  for (const b of branches) for (const f of b.frames) height = Math.max(height, f.o[1]);
  for (const l of leaves) height = Math.max(height, l.p[1] + spec.leaf.size * l.scale * 0.6);
  return { branches, leaves, height };
}

// ── Mesh ──────────────────────────────────────────────────────────────────────

export interface TreeMeshes {
  readonly bark: MeshBuilder;
  readonly leaves: MeshBuilder;
}

/** Shade multipliers for leaf vertices: shaded interior → sunlit outside (sRGB). */
const LEAF_INNER: Vec3 = [0.42, 0.5, 0.46];
const LEAF_OUTER: Vec3 = [1.0, 1.0, 0.9];

/**
 * Mesh a skeleton at `detail` (0 near, 1 mid), scaled by `unit` (metres per skeleton metre).
 * Leaves get uvs over the spray texture (v = 1 at the stem, 0 at the tip).
 */
export function meshTree(spec: TreeSpec, skel: Skeleton, detail: 0 | 1, unit: number): TreeMeshes {
  const bark = new MeshBuilder();
  const leaves = new MeshBuilder();
  const deepest = skel.branches.reduce((m, b) => Math.max(m, b.level), 0);
  const height = Math.max(skel.height, 0.1);
  for (const branch of skel.branches) {
    // Mid detail drops the finest twigs (their leaves still hang there).
    if (detail === 1 && branch.level === deepest && deepest >= 2) continue;
    const segs = Math.max(3, detail === 0 ? branch.segments : Math.ceil(branch.segments * 0.6));
    const stride = detail === 0 || branch.frames.length <= 3 ? 1 : 2;
    const frames = branch.frames.filter((_, i) => i % stride === 0 || i === branch.frames.length - 1);
    const first = bark.vertexCount;
    let v = 0;
    frames.forEach((f, i) => {
      if (i > 0) v += Math.hypot(f.o[0] - frames[i - 1]!.o[0], f.o[1] - frames[i - 1]!.o[1], f.o[2] - frames[i - 1]!.o[2]) * unit;
      const b = cross(f.d, f.s);
      // Darker near the ground and where limbs leave the trunk: cheap ambient occlusion.
      const ground = clamp((f.o[1] * unit) / 1.6, 0, 1);
      const shade = (0.6 + 0.4 * ground) * (branch.level === 0 ? 1 : 0.9 + 0.1 * (i / Math.max(1, frames.length - 1)));
      const color: Vec3 = [shade, shade, shade];
      for (let k = 0; k <= segs; k++) {
        const a = (k / segs) * Math.PI * 2;
        const n = add(scale(f.s, Math.cos(a)), scale(b, Math.sin(a)));
        const p = scale(add(f.o, scale(n, f.r)), unit);
        if (branch.level > 0) p[1] = Math.max(p[1], 0.02); // weeping twigs rest on the ground
        bark.vertex(p, n, (k / segs) * Math.max(1, Math.round(f.r * unit * 6)), v * 0.5, color);
      }
    });
    for (let i = 0; i + 1 < frames.length; i++) {
      for (let k = 0; k < segs; k++) {
        const a = first + i * (segs + 1) + k;
        const c = a + segs + 1;
        bark.triangle(a, a + 1, c + 1);
        bark.triangle(a, c + 1, c);
      }
    }
  }

  const leaf = spec.leaf;
  if (leaf.archetype === null || skel.leaves.length === 0) return { bark, leaves };
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const l of skel.leaves) {
    cx += l.p[0];
    cy += l.p[1];
    cz += l.p[2];
  }
  const center: Vec3 = [cx / skel.leaves.length, cy / skel.leaves.length, cz / skel.leaves.length];
  let extent = 0;
  for (const l of skel.leaves) extent = Math.max(extent, Math.hypot(l.p[0] - center[0], (l.p[1] - center[1]) * 1.3, l.p[2] - center[2]));
  extent = Math.max(extent, 0.2);
  const keep = detail === 0 ? 1 : 0.5;
  const grow = detail === 0 ? 1 : 1.3;
  for (const anchor of skel.leaves) {
    if (anchor.hash >= keep) continue;
    const outward = normalize(sub(anchor.p, center), anchor.d);
    let axis: Vec3 = leaf.along
      ? normalize(add(anchor.d, [0, -leaf.droop, 0]), anchor.d)
      : normalize(add(add(scale(anchor.d, 0.55), scale(outward, 0.45)), [0, -leaf.droop, 0]), outward);
    if (leaf.flat === true) axis = normalize([axis[0], axis[1] * 0.2, axis[2]], outward);
    // A little hashed roll, so sprays don't line up.
    axis = normalize(rotate(axis, anyPerpendicular(axis), (anchor.hash - 0.5) * 0.6), axis);
    const flat = perpendicular(leaf.along || leaf.flat === true ? [0, 1, 0] : outward, axis);
    const side = normalize(cross(axis, flat), anyPerpendicular(axis));
    const span = leaf.size * anchor.scale * grow;
    const origin = sub(anchor.p, scale(axis, span * 0.12));
    const tip = add(origin, scale(axis, span));
    const half = span * (leaf.archetype === 'needle' ? 0.42 : leaf.archetype === 'lance' ? 0.3 : 0.5);
    // Interior → outside, by how far the vertex is from the crown's center (and lower = darker).
    const tone = (p: Vec3): Vec3 => {
      const r = clamp(Math.hypot(p[0] - center[0], (p[1] - center[1]) * 1.3, p[2] - center[2]) / extent, 0, 1);
      const under = clamp(0.5 + (p[1] - center[1]) / (extent * 2), 0, 1);
      const t = clamp(r * 0.75 + under * 0.35, 0, 1) * (0.88 + 0.12 * anchor.hash * 2);
      return [lerp(LEAF_INNER[0], LEAF_OUTER[0], t), lerp(LEAF_INNER[1], LEAF_OUTER[1], t), lerp(LEAF_INNER[2], LEAF_OUTER[2], t)];
    };
    const planes: [Vec3, Vec3][] = [[side, flat], [flat, side]];
    for (const [across, sheet] of planes) {
      const corners: [Vec3, number, number][] = [
        [sub(origin, scale(across, half)), 0, 1], [add(origin, scale(across, half)), 1, 1],
        [add(tip, scale(across, half)), 1, 0], [sub(tip, scale(across, half)), 0, 0],
      ];
      // Both faces, with the same rounded normal (see the header).
      for (const facing of [1, -1]) {
        const ids = corners.map(([p, u, vv]) => {
          const radial = normalize(sub(p, center), sheet);
          const n = normalize(add(scale(sheet, 0.25 * (dot(sheet, radial) >= 0 ? 1 : -1)), scale(radial, 0.75)), radial);
          // Sprays that hang to the ground (willow, low bushes) rest on it instead of passing through.
          const placed = scale(p, unit);
          placed[1] = Math.max(placed[1], 0.03);
          return leaves.vertex(placed, n, u, vv, tone(p));
        });
        const face = cross(sub(corners[1]![0], corners[0]![0]), sub(corners[2]![0], corners[0]![0]));
        const front = dot(face, sheet) * facing >= 0;
        if (front) {
          leaves.rawTriangle(ids[0]!, ids[1]!, ids[2]!);
          leaves.rawTriangle(ids[0]!, ids[2]!, ids[3]!);
        } else {
          leaves.rawTriangle(ids[0]!, ids[2]!, ids[1]!);
          leaves.rawTriangle(ids[0]!, ids[3]!, ids[2]!);
        }
      }
    }
  }
  return { bark, leaves };
}
