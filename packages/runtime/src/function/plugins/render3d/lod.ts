/**
 * Levels of detail (the `lod` component, DESIGN §6.7): which model an entity draws at its
 * distance from the nearest camera, as bands:
 *
 *   band 0          the entity's own Model (Shape), from 0 m
 *   band i (1..n)   `levels[i - 1].model` from `levels[i - 1].distance` (None: nothing)
 *   impostor        a baked impostor of the last model band, from `impostor`
 *   culled          nothing, from `cull` (default: the quality's view distance)
 *
 * Every distance is multiplied by the quality's `lodScale` (low switches at half the
 * distance). Selection is a pure function of distance — no hysteresis state — and each
 * switch cross-fades over `fade` × its distance with complementary dither patterns
 * (`MeshBatch.fades`): the incoming band keeps fraction t of its pixels, the outgoing one
 * exactly the other 1 - t, so there is never a hole or an overlap and nothing pops. The
 * last band fades out over the same margin before the cull distance; the view distance's
 * fog (`Quality3d.viewDistance`) has the world fully hidden by then, so the edge of the
 * drawn world never shows.
 */

import { fail } from '../../../core/index.js';
import type { Quality3d } from '../../../core/index.js';
import type { Fields } from '../../kernel/index.js';
import { describe, finite } from './draw.js';

export const LOD = 'lod';

export interface LodBands {
  /** Start distance of each band after band 0 (levels, then the impostor), scaled, increasing. */
  readonly starts: readonly number[];
  /** Model reference of each level (index i is band i + 1); null draws nothing. */
  readonly models: readonly (string | null)[];
  /** Whether the last band is the impostor. */
  readonly impostor: boolean;
  /** Meters past which nothing is drawn (Infinity: never culled). */
  readonly cull: number;
  readonly fade: number;
}

/** A band drawn this frame and its cross-fade (`MeshBatch.fades` rules: 1 whole, 0..1 fading in, -1..0 fading out). */
export interface LodDraw {
  readonly band: number;
  readonly fade: number;
}

/** The entity's bands, checked: increasing distances, an impostor past the last level, a cull past everything. */
export function lodBands(fields: Fields, quality: Quality3d, where: string): LodBands {
  const scale = quality.lodScale;
  const levels = fields['levels'] as readonly { distance: unknown; model: unknown }[];
  const starts: number[] = [];
  const models: (string | null)[] = [];
  let last = 0;
  levels.forEach((level, i) => {
    const d = finite(level.distance, `${where}.levels[${i}].distance`);
    if (!(d > last)) {
      fail('PP3850', `${where}.levels[${i}].distance is ${d}; each level must start farther than the one before (${last} m)`, {
        fix: 'List the levels nearest first, with increasing distances above 0.',
      });
    }
    last = d;
    starts.push(d * scale);
    const model = level.model;
    if (model !== null && model !== undefined && typeof model !== 'string' && typeof (model as { path?: unknown }).path !== 'string') {
      fail('PP3800', `${where}.levels[${i}].model must be a model reference or None, got ${describe(model)}`);
    }
    models.push(model === null || model === undefined ? null : typeof model === 'string' ? model : (model as { path: string }).path);
  });
  const impostorAt = fields['impostor'];
  const impostor = impostorAt !== null && impostorAt !== undefined;
  if (impostor) {
    const d = finite(impostorAt, `${where}.impostor`);
    if (!(d > last)) fail('PP3850', `${where}.impostor is ${d} m; it must be farther than the last level (${last} m)`);
    last = d;
    starts.push(d * scale);
  }
  const cullAt = fields['cull'];
  let cull = quality.viewDistance;
  if (cullAt !== null && cullAt !== undefined) {
    const d = finite(cullAt, `${where}.cull`);
    if (!(d > last)) fail('PP3850', `${where}.cull is ${d} m; it must be farther than every level and the impostor (${last} m)`);
    cull = Math.min(cull, d * scale);
  }
  return { starts, models, impostor, cull, fade: finite(fields['fade'], `${where}.fade`) };
}

/** The band (or two, while they cross-fade) drawn at `distance` meters; none past the cull distance. */
export function chooseLod(bands: LodBands, distance: number): LodDraw[] {
  if (distance >= bands.cull) return [];
  let band = 0;
  while (band < bands.starts.length && distance >= bands.starts[band]!) band++;
  const out: LodDraw[] = [];
  // Fading in over [start, start · (1 + fade)], the band before fading out over the same span.
  const start = band === 0 ? 0 : bands.starts[band - 1]!;
  const span = start * bands.fade;
  let fade = 1;
  if (band > 0 && span > 0 && distance < start + span) {
    const t = (distance - start) / span;
    fade = t;
    if (t < 1) out.push({ band: band - 1, fade: t - 1 });
  }
  // Fading out (no partner) before the cull distance.
  const edge = bands.cull * bands.fade;
  if (Number.isFinite(bands.cull) && edge > 0 && distance > bands.cull - edge) {
    fade = Math.min(fade, (bands.cull - distance) / edge);
  }
  if (fade > 0) out.unshift({ band, fade: fade >= 1 ? 1 : fade });
  return out;
}
