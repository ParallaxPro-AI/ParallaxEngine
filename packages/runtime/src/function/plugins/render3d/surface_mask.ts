/**
 * The `surface_mask` component (visuals' surface_mask.ts) as render data: the entity's
 * mask cells become a `MaterialPaint3d` on its materials (a swap, like surface effects),
 * with the cells as a `pixels` texture whose version follows the mask's, and the matrix that
 * takes a world point into the volume this frame (the mask follows the entity as it moves).
 */

import type { Material3d, MaterialPaint3d, PaintLayer3d, Rgb, Texture3d } from '../../../core/index.js';
import type { EntityRecord, Fields, Kernel } from '../../kernel/index.js';
import { SURFACE_MASKS_SERVICE } from '../../services/index.js';
import type { SurfaceMaskView } from '../../services/index.js';
import { finite, nameOf, rgba } from './draw.js';

/** The component's id (visuals' render_schemas.ts), read by id. */
export const SURFACE_MASK = 'surface_mask';

type MaskState = Pick<SurfaceMaskView, 'nx' | 'ny' | 'nz' | 'cell' | 'min'>;

type Swap = (material: Material3d, name: string | null) => Material3d;

/** The inverse of an affine column-major 4×4 (out: 16 floats). False when it is singular. */
export function invertAffine(m: ArrayLike<number>, out: Float32Array): boolean {
  const a = m[0]!; const b = m[4]!; const c = m[8]!;
  const d = m[1]!; const e = m[5]!; const f = m[9]!;
  const g = m[2]!; const h = m[6]!; const i = m[10]!;
  const A = e * i - f * h; const B = -(d * i - f * g); const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-20) return false;
  const s = 1 / det;
  const r00 = A * s; const r01 = -(b * i - c * h) * s; const r02 = (b * f - c * e) * s;
  const r10 = B * s; const r11 = (a * i - c * g) * s; const r12 = -(a * f - c * d) * s;
  const r20 = C * s; const r21 = -(a * h - b * g) * s; const r22 = (a * e - b * d) * s;
  const tx = m[12]!; const ty = m[13]!; const tz = m[14]!;
  out[0] = r00; out[4] = r01; out[8] = r02; out[12] = -(r00 * tx + r01 * ty + r02 * tz);
  out[1] = r10; out[5] = r11; out[9] = r12; out[13] = -(r10 * tx + r11 * ty + r12 * tz);
  out[2] = r20; out[6] = r21; out[10] = r22; out[14] = -(r20 * tx + r21 * ty + r22 * tz);
  out[3] = 0; out[7] = 0; out[11] = 0; out[15] = 1;
  return true;
}

/** World → volume (0..1 per axis) for a mask on an entity drawn with world matrix `m`. */
export function worldToVolume(state: MaskState, m: ArrayLike<number>): Float32Array | null {
  const inv = new Float32Array(16);
  if (!invertAffine(m, inv)) return null;
  const size = [state.nx * state.cell, state.ny * state.cell, state.nz * state.cell];
  // volume = (local - min) / size: scale each row of the inverse, then shift.
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) inv[col * 4 + row] = inv[col * 4 + row]! / size[row]!;
    inv[12 + row] = inv[12 + row]! - state.min[row]! / size[row]!;
  }
  return inv;
}

const textures = new WeakMap<SurfaceMaskView, { version: number; texture: Texture3d }>();
let serial = 0;

/** The mask's cells as a texture, a new object (same id) whenever they changed. */
export function maskTexture(state: SurfaceMaskView): Texture3d {
  const known = textures.get(state);
  if (known !== undefined && known.version === state.version) return known.texture;
  const id = known?.texture.id ?? `paint:${++serial}`;
  const texture: Texture3d = {
    id,
    source: { kind: 'pixels', width: state.width, height: state.height, data: state.texels(), version: state.version },
    colorSpace: 'linear', wrapU: 'clamp', wrapV: 'clamp', filter: 'linear',
  };
  textures.set(state, { version: state.version, texture });
  return texture;
}

/** The layers' looks from the component's fields. */
function layersOf(record: EntityRecord, fields: Fields): PaintLayer3d[] {
  const where = `${nameOf(record)} surface_mask`;
  const layers = (fields['layers'] as readonly Fields[] | undefined) ?? [];
  return layers.map((l, k) => {
    const c = rgba(l['color'], `${where}.layers[${k}].color`);
    const color: Rgb = [c[0], c[1], c[2]];
    return {
      color,
      roughness: finite(l['roughness'], `${where}.layers[${k}].roughness`),
      metallic: finite(l['metallic'], `${where}.layers[${k}].metallic`),
      pattern: finite(l['pattern'], `${where}.layers[${k}].pattern`),
      breakup: finite(l['breakup'], `${where}.layers[${k}].breakup`),
    };
  });
}

/** An entity's paint this frame (null: its model is still loading, or it has no layers). */
export function paintOf(kernel: Kernel, record: EntityRecord, fields: Fields, m: ArrayLike<number>): MaterialPaint3d | null {
  const state = kernel.tryService(SURFACE_MASKS_SERVICE)?.mask(record, fields);
  if (state === undefined || state.layers.length === 0) return null;
  const toVolume = worldToVolume(state, m);
  if (toVolume === null) return null;
  return {
    texture: maskTexture(state), grid: [state.nx, state.ny, state.nz], tiles: state.tiles, cell: state.cell,
    worldToVolume: toVolume, layers: layersOf(record, fields),
  };
}

/** The swap that lays an entity's paint on its materials (only the `material` its component names), over `inner`. */
export function paintSwap(record: EntityRecord, fields: Fields, paint: MaterialPaint3d, inner: Swap | null): Swap {
  const only = fields['material'] as string | null;
  const key = `|paint:${record.id}`;
  return (material, name) => {
    const under = inner === null ? material : inner(material, name);
    return only !== null && name !== only ? under : { ...under, id: `${under.id}${key}`, paint };
  };
}
