/**
 * Projected decals (the `decal` component): an image stamped through a box onto whatever
 * surfaces lie inside it — terrain, meshes, generated geometry — drawn by the surface after
 * the opaque scene. The box is the entity's placement scaled by `size` (x wide, y deep,
 * z tall), projected along the entity's down axis; `angle_fade` keeps it off steep walls.
 * The nearest `quality.maxDecals` to the first view are drawn, in `order`, then nearest
 * last so the closest wins ties.
 */

import { fail } from '../../../core/index.js';
import type { Decal3d, Texture3d } from '../../../core/index.js';
import { compose, invert, multiply } from '../../../resource/index.js';
import type { EntityRecord, Fields } from '../../kernel/index.js';
import type { Placed3d } from './draw.js';
import { finite, nameOf, rgba, vec3 } from './draw.js';

export const DECAL = 'decal';

/** An entity's decal: its box (placement × size), image and look. */
export function decalOf(record: EntityRecord, fields: Fields, at: Placed3d, image: (ref: unknown, where: string) => Texture3d): Decal3d | null {
  const where = `${nameOf(record)} decal`;
  const [sx, sy, sz] = vec3(fields['size'], `${where}.size`);
  if (!(sx > 0 && sy > 0 && sz > 0)) fail('PP3851', `${where}.size is (${sx}, ${sy}, ${sz}); every side must be above 0`, { fix: 'Give the decal box a width, depth and height.' });
  const matrix = multiply(at.m, compose(0, 0, 0, 0, 0, 0, 1, sx, sy, sz));
  const inverse = invert(matrix);
  if (inverse === null) return null;
  const angle = finite(fields['angle_fade'], `${where}.angle_fade`);
  return {
    matrix, inverse, texture: image(fields['image'], `${where}.image`), color: rgba(fields['color'], `${where}.color`),
    angleFade: Math.cos((angle * Math.PI) / 180), order: finite(fields['order'], `${where}.order`), entity: record.id,
  };
}

/** The decals drawn: at most `max`, nearest to `eye` first, then sorted by order (nearer later within an order). */
export function chooseDecals(decals: readonly Decal3d[], eye: readonly number[] | null, max: number): Decal3d[] {
  const d2 = (d: Decal3d): number => (eye === null ? 0 : (d.matrix[12]! - eye[0]!) ** 2 + (d.matrix[13]! - eye[1]!) ** 2 + (d.matrix[14]! - eye[2]!) ** 2);
  const kept = [...decals].sort((a, b) => d2(a) - d2(b)).slice(0, max);
  return kept.sort((a, b) => a.order - b.order || d2(b) - d2(a));
}
