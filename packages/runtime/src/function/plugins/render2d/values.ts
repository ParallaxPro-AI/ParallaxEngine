/** Conversions between the SDK's runtime values (Color, Vec2/Vec3) and the port's plain numbers. */

import { Color, fail, Vec2, Vec3 } from '../../../core/index.js';
import type { Rgba } from '../../../core/index.js';

export const WHITE: Rgba = [1, 1, 1, 1];

export function describe(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'object') return value.constructor?.name ?? 'object';
  return JSON.stringify(value);
}

export function rgba(value: unknown, where: string): Rgba {
  if (value instanceof Color) return [value.r, value.g, value.b, value.a];
  return fail('PP3600', `${where} must be a Color, got ${describe(value)}`, { fix: 'Use Color(r, g, b) or Color.hex("#rrggbb").' });
}

export function multiply(a: Rgba, b: Rgba): Rgba {
  return [a[0] * b[0], a[1] * b[1], a[2] * b[2], a[3] * b[3]];
}

export function finite(value: unknown, where: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return fail('PP3600', `${where} must be a finite number, got ${describe(value)}`);
}

/** A Vec2 (or a Vec3's x, y) as numbers. */
export function xy(value: unknown, where: string): [number, number] {
  if (value instanceof Vec2 || value instanceof Vec3) return [value.x, value.y];
  return fail('PP3600', `${where} must be a Vec2 or Vec3, got ${describe(value)}`, { fix: 'Pass vec2(x, y) or vec3(x, y, z).' });
}


/**
 * The stand-in color of an image a data-only run doesn't have (multiplied into the draw's
 * own color): a hue hashed from the reference, so pieces that differ only by image (chess
 * pieces, gem kinds, card faces) stay distinguishable instead of all drawing white.
 */
export function missingImageColor(ref: string): Rgba {
  let h = 0x811c9dc5;
  for (let i = 0; i < ref.length; i++) {
    h ^= ref.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const hue = (h % 360) / 60;
  // HSL with saturation 0.6 and lightness 0.62: light enough to read under dark tints.
  const c = (1 - Math.abs(2 * 0.62 - 1)) * 0.6;
  const x = c * (1 - Math.abs((hue % 2) - 1));
  const m = 0.62 - c / 2;
  const [r, g, b] = hue < 1 ? [c, x, 0] : hue < 2 ? [x, c, 0] : hue < 3 ? [0, c, x] : hue < 4 ? [0, x, c] : hue < 5 ? [x, 0, c] : [c, 0, x];
  return [r + m, g + m, b + m, 1];
}
