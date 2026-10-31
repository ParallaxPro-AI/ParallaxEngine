/**
 * Wind you can see: drifting air streaks and blown leaves around the first camera, when
 * the scene's wind asks for them (`"streaks": true`, `"debris": n`). Each streak or leaf
 * lives in a box around the camera, carried by the wind's mean velocity and wrapped back
 * into the box, so they never run out; their spots are hashed per index (no state).
 * Streaks are faint ribbons (lines); leaves are small tinted billboards that tumble.
 * They fade out in calm air.
 */

import { hash2 } from '../../../core/index.js';
import type { BillboardBatch, Line3d, View3d } from '../../../core/index.js';
import { BILLBOARD_STRIDE } from '../../../core/index.js';
import type { WindService } from '../../services/index.js';

export const STREAKS = 28;
/** Meters around the camera streaks (and leaves) wrap within. */
const BOX = 36;
const LEAF_BOX = 18;
/** Meters streaks keep from the camera (beyond their own length). */
const NEAR_CLEARANCE = 3;

function wrap(v: number, size: number): number {
  return v - Math.floor(v / size) * size - size / 2;
}

export function windVisuals(wind: WindService, view: View3d | undefined, now: number): { lines: Line3d[]; billboards: BillboardBatch[] } {
  const s = wind.settings();
  const lines: Line3d[] = [];
  const billboards: BillboardBatch[] = [];
  if (view === undefined || s.speed <= 0.2 || (!s.streaks && s.debris === 0)) return { lines, billboards };
  const [cx, cy, cz] = view.position;
  const vx = s.dirX * s.speed;
  const vz = s.dirZ * s.speed;
  const strength = Math.min(1, s.speed / 6);
  if (s.streaks) {
    for (let i = 0; i < STREAKS; i++) {
      const ox = hash2(i, 0, 0x57e1) * BOX;
      const oz = hash2(i, 1, 0x57e1) * BOX;
      const y = cy - 2 + hash2(i, 2, 0x57e1) * 6;
      const x = cx + wrap(ox + vx * now * 1.4 - cx, BOX);
      const z = cz + wrap(oz + vz * now * 1.4 - cz, BOX);
      const length = 2 + hash2(i, 3, 0x57e1) * 3;
      // A ribbon passing right by the eye would sweep across the whole screen: keep clear of it.
      const near = Math.hypot(x - s.dirX * length * 0.5 - cx, y - cy, z - s.dirZ * length * 0.5 - cz);
      if (near < length + NEAR_CLEARANCE) continue;
      const points = new Float32Array(18);
      for (let k = 0; k < 6; k++) {
        const t = k / 5;
        const wiggle = Math.sin(now * 2 + i + t * 3) * 0.15;
        points[k * 3] = x - s.dirX * length * t - s.dirZ * wiggle;
        points[k * 3 + 1] = y + Math.sin(now * 1.3 + i * 0.7 + t * 2) * 0.1;
        points[k * 3 + 2] = z - s.dirZ * length * t + s.dirX * wiggle;
      }
      lines.push({ layer: 'scene', points, width: 0.025, color: [1, 1, 1, 0.18 * strength], entity: null });
    }
  }
  if (s.debris > 0) {
    const data = new Float32Array(s.debris * BILLBOARD_STRIDE);
    for (let i = 0; i < s.debris; i++) {
      const o = i * BILLBOARD_STRIDE;
      const ox = hash2(i, 4, 0x57e1) * LEAF_BOX;
      const oz = hash2(i, 5, 0x57e1) * LEAF_BOX;
      data[o] = cx + wrap(ox + vx * now - cx, LEAF_BOX);
      data[o + 1] = Math.max(cy - 3, cy - 1.5 + hash2(i, 6, 0x57e1) * 4 + Math.sin(now * 1.7 + i) * 0.5);
      data[o + 2] = cz + wrap(oz + vz * now - cz, LEAF_BOX);
      data[o + 5] = 0.09 + 0.05 * hash2(i, 7, 0x57e1);
      data[o + 6] = data[o + 5]! * 0.6;
      data[o + 7] = (now * (90 + 120 * hash2(i, 8, 0x57e1)) + i * 40) % 360;
      const brown = hash2(i, 9, 0x57e1);
      data.set([0.45 + 0.2 * brown, 0.38 + 0.12 * (1 - brown), 0.16, strength], o + 8);
    }
    billboards.push({ layer: 'scene', shape: 'circle', image: null, count: s.debris, data, entity: null });
  }
  return { lines, billboards };
}
