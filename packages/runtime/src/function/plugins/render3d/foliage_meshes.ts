/**
 * Built-in foliage looks, as geometry standing on y = 0 (+y up), built in code (no asset
 * files): each look is a list of parts (geometry + material) drawn with the same instance
 * matrices, in `LOOK_VARIANTS` seeded variants and two detail levels.
 *
 *   tree:*, bush:*   grown from a species recipe (foliage_tree.ts): bark tubes and crossed
 *                    leaf sprays, scaled to the look's nominal height (`NOMINAL_HEIGHT`)
 *   plant:fern       radiating arched fronds; plant:reed   upright blades
 *   rock:*           an icosphere pushed out to a cut, roughened stone (foliage_rock.ts),
 *                    with a world-projected stone grain (the material's triplanar effect)
 *
 * Far instances are drawn as the renderer's impostors (`foliageImpostor`): the mid-detail
 * parts baked into a lit octahedral atlas, so a far tree is the same tree, lit by the same
 * sun. Every part is cached per (look, color, variant, detail).
 */

import { fail, hash2, NO_EFFECTS } from '../../../core/index.js';
import type { Geometry3d, ImpostorSource3d, Material3d, Rgb, Rgba } from '../../../core/index.js';
import { add, MeshBuilder, normalize, scale } from './foliage_gen.js';
import { meshRock, ROCK_SPECS } from './foliage_rock.js';
import { barkTexture, leafSprayTexture, stoneTexture } from './foliage_textures.js';
import { growSkeleton, meshTree, TREE_SPECS } from './foliage_tree.js';
import type { LeafArchetype } from './foliage_tree.js';

export interface FoliagePart {
  readonly geometry: Geometry3d;
  readonly material: Material3d;
  /** Leaves and blades bend with the wind; trunks and stone (weight 0) only lean with the whole. */
  readonly leaves: boolean;
}

/** Seeded variants of every built-in look; an instance picks one by its index. */
export const LOOK_VARIANTS = 4;

/** Height (metres) each built-in look is drawn at scale 1 (the foliage plugin's `LOOKS` heights). */
export const NOMINAL_HEIGHT: Readonly<Record<string, number>> = {
  'tree:broadleaf': 7, 'tree:pine': 9, 'tree:birch': 8, 'tree:willow': 7, 'tree:acacia': 6, 'tree:dead': 6.5, 'tree:palm': 8.5,
  'bush:round': 1.3, 'bush:sprawl': 0.9, 'plant:fern': 0.7, 'plant:reed': 1.5, 'rock:boulder': 1.0, 'rock:slab': 0.5,
};

/** Impostor atlas of a built-in look: frames per side and texels per frame. */
export const FOLIAGE_IMPOSTOR_FRAMES = 8;
export const FOLIAGE_IMPOSTOR_FRAME_SIZE = 96;
/** Leaf alpha cutoff in the impostor bake (the meshes use 0.5; see `foliageImpostor`). */
export const IMPOSTOR_LEAF_CUTOFF = 0.35;

function material(id: string, color: Rgba, opts: Partial<Material3d> = {}): Material3d {
  return {
    id, baseColor: color, baseColorTexture: null, metallic: 0, roughness: 0.9, metallicRoughnessTexture: null, emissive: [0, 0, 0],
    emissiveTexture: null, alphaMode: 'opaque', alphaCutoff: 0.5, doubleSided: false, unlit: false, ...opts,
  };
}

/** Alpha-cut leaves, lit a little from behind (light through the leaf: the subsurface layer's wrap term). */
function leafMaterial(archetype: LeafArchetype, color: Rgb, doubleSided: boolean, height: number, flutter: number): Material3d {
  return material(`foliage:leaves:${archetype}:${color.join(',')}:${doubleSided ? 2 : 1}:${height}:${flutter}`, [color[0], color[1], color[2], 1], {
    baseColorTexture: leafSprayTexture(archetype), alphaMode: 'mask', alphaCutoff: 0.5, doubleSided, roughness: 0.75,
    // Per-leaf flutter in the vertex shader (foliage_wind_shaders.ts), strongest at the crown's top.
    wind: { amount: flutter, height },
    layers: {
      clearcoat: 0, clearcoatRoughness: 0, transmission: 0, subsurface: 0.35,
      subsurfaceColor: [Math.min(1, color[0] * 1.6 + 0.08), Math.min(1, color[1] * 1.5 + 0.1), Math.min(1, color[2] * 1.2)], anisotropy: 0, anisotropyRotation: 0,
    },
  });
}

const rand = (i: number, k: number, seed: number): number => hash2(i, k, seed);

/** A card: center, half-extents along `right` and `up`, normal `n` (uv v = 1 at the bottom). */
function card(m: MeshBuilder, center: readonly number[], right: readonly number[], up: readonly number[], n: readonly number[], shade: number): void {
  const at = (s: number, t: number): number[] => add(add(center, scale(right, s)), scale(up, t));
  const c: number[] = [shade, shade, shade];
  const a = m.vertex(at(-1, -1), n, 0, 1, c);
  const b = m.vertex(at(1, -1), n, 1, 1, c);
  const d = m.vertex(at(1, 1), n, 1, 0, c);
  const e = m.vertex(at(-1, 1), n, 0, 0, c);
  m.triangle(a, b, d);
  m.triangle(a, d, e);
}

function maxY(m: MeshBuilder): number {
  let y = 0;
  for (let i = 1; i < m.positions.length; i += 3) if (m.positions[i]! > y) y = m.positions[i]!;
  return y;
}

const looks = new Map<string, readonly FoliagePart[]>();

/** Whether `look` ("tree:pine") is built in. */
export function isBuiltInLook(look: string): boolean {
  return NOMINAL_HEIGHT[look] !== undefined;
}

/** The parts of a built-in look with this leaf/stone color, in a variant and detail (0 near, 1 mid). */
export function foliageLook(look: string, color: Rgb, variant = 0, detail: 0 | 1 = 0): readonly FoliagePart[] {
  const v = ((variant % LOOK_VARIANTS) + LOOK_VARIANTS) % LOOK_VARIANTS;
  const key = `${look}|${color.join(',')}|${v}|${detail}`;
  let parts = looks.get(key);
  if (parts !== undefined) return parts;
  const id = (part: string): string => `foliage:${look}:${v}:${detail}:${part}`;
  const seed = 0x51ed + v * 7919 + (look.length * 131 + look.charCodeAt(look.length - 1));
  const tree = TREE_SPECS[look];
  const rock = ROCK_SPECS[look];
  if (tree !== undefined) {
    // Grown in its own metres, then scaled so the drawn top (leaves included) is the look's
    // nominal height ± 8% by variant; both details share the near mesh's scale.
    const skel = growSkeleton(tree, seed);
    const reference = meshTree(tree, skel, 0, 1);
    const top = Math.max(maxY(reference.bark), maxY(reference.leaves), 0.1);
    const unit = (NOMINAL_HEIGHT[look]! * (0.92 + 0.16 * rand(v, 1, 0x7ee))) / top;
    const mesh = meshTree(tree, skel, detail, unit);
    parts = [{
      geometry: mesh.bark.build(id('bark')),
      material: material(`foliage:bark:${tree.barkKind}:${tree.bark.join(',')}`, [tree.bark[0], tree.bark[1], tree.bark[2], 1], {
        baseColorTexture: barkTexture(tree.barkKind), roughness: 0.95,
      }),
      leaves: false,
    }];
    if (mesh.leaves.vertexCount > 0) parts = [...parts, { geometry: mesh.leaves.build(id('leaves')), material: leafMaterial(tree.leaf.archetype!, color, false, NOMINAL_HEIGHT[look]!, look.startsWith('bush:') ? 0.12 : 0.05), leaves: true }];
  } else if (rock !== undefined) {
    parts = [{ geometry: meshRock(rock, seed, detail).build(id('stone')), material: material(`foliage:stone:${color.join(',')}`, [color[0], color[1], color[2], 1], {
      roughness: 0.88, baseColorTexture: stoneTexture(), effects: { ...NO_EFFECTS, triplanar: 1.1 },
    }), leaves: false }];
  } else if (look === 'plant:fern') {
    const m = new MeshBuilder();
    const fronds = detail === 0 ? 11 : 7;
    for (let k = 0; k < fronds; k++) {
      const a = (k / fronds) * Math.PI * 2 + rand(k, 0, seed) * 0.5;
      const out = [Math.cos(a), 0, Math.sin(a)];
      const rise = 0.75 + 0.5 * rand(k, 2, seed);
      const len = 0.8 + 0.3 * rand(k, 3, seed);
      // Two segments per frond: up and out, then arching over.
      const mid = scale(normalize([out[0]!, rise, out[2]!]), len * 0.5);
      const tipDir = normalize([out[0]!, rise - 0.9, out[2]!]);
      const side = [-out[2]!, 0, out[0]!];
      const n = [out[0]! * 0.4, 1, out[2]! * 0.4];
      card(m, scale(mid, 0.5), scale(side, 0.16), scale(mid, 0.5), n, 0.75 + 0.1 * rand(k, 1, seed));
      card(m, add(mid, scale(tipDir, len * 0.25)), scale(side, 0.14), scale(tipDir, len * 0.25), n, 0.9 + 0.1 * rand(k, 1, seed));
    }
    parts = [{ geometry: m.build(id('fronds')), material: leafMaterial('frond', color, true, NOMINAL_HEIGHT[look]!, 0.2), leaves: true }];
  } else if (look === 'plant:reed') {
    const m = new MeshBuilder();
    const blades = detail === 0 ? 16 : 9;
    for (let k = 0; k < blades; k++) {
      const a = rand(k, 0, seed) * Math.PI * 2;
      const r = rand(k, 1, seed) * 0.25;
      const h = 1.1 + rand(k, 2, seed) * 0.5;
      const facing = [Math.cos(a + 1.3), 0, Math.sin(a + 1.3)];
      card(m, [Math.cos(a) * r, h / 2, Math.sin(a) * r], scale([-facing[2]!, 0, facing[0]!], 0.07), [Math.cos(a) * 0.08, h / 2, Math.sin(a) * 0.08], facing, 0.75 + 0.25 * rand(k, 3, seed));
    }
    parts = [{ geometry: m.build(id('blades')), material: leafMaterial('lance', color, true, NOMINAL_HEIGHT[look]!, 0.25), leaves: true }];
  } else {
    return fail('PP9830', `render3d has no built-in foliage look "${look}"`, { fix: 'This is an engine bug: the foliage plugin accepted a species render3d does not draw.' });
  }
  looks.set(key, parts);
  return parts;
}

const impostors = new Map<string, ImpostorSource3d>();
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** The impostor of a built-in look's variant: its mid-detail parts, baked by the renderer. */
export function foliageImpostor(look: string, color: Rgb, variant: number): ImpostorSource3d {
  const key = `${look}|${color.join(',')}|${variant % LOOK_VARIANTS}`;
  let source = impostors.get(key);
  if (source !== undefined) return source;
  const parts = foliageLook(look, color, variant, 1);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k]!, p.geometry.min[k]!);
      hi[k] = Math.max(hi[k]!, p.geometry.max[k]!);
    }
  }
  source = {
    id: `impostor:foliage:${key}`,
    // Leaf cutouts are baked with a low cutoff: a frame is ~100 texels, so the spray texture is
    // read from a small mip whose averaged alpha would otherwise thin a crown to bare limbs.
    // (The bake keeps only the front of single-sided leaves, and the impostor pass adds their
    // subsurface term, so a far crown is shaded like the mesh it replaces.)
    parts: parts.map((p) => ({
      geometry: p.geometry, matrix: IDENTITY,
      material: p.material.alphaMode === 'mask' ? { ...p.material, id: `${p.material.id}:bake`, alphaCutoff: IMPOSTOR_LEAF_CUTOFF } : p.material,
    })),
    center: [(lo[0]! + hi[0]!) / 2, (lo[1]! + hi[1]!) / 2, (lo[2]! + hi[2]!) / 2],
    radius: Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!) / 2,
    frames: FOLIAGE_IMPOSTOR_FRAMES, frameSize: FOLIAGE_IMPOSTOR_FRAME_SIZE,
  };
  impostors.set(key, source);
  return source;
}
