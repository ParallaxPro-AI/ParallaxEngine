/**
 * Formations as pure geometry: slot offsets for a shape, placed at a point facing a
 * direction, and a deterministic assignment of units to slots. Offsets are (x right,
 * z behind the front), in meters; facing +z, right is +x.
 *
 *   line     side by side                       column  one behind another
 *   wedge    a V with slot 0 at the tip         box     rows of ceil(√n), front first
 *   circle   a ring (radius from spacing)       echelon a diagonal back to the right
 */

import { fail, Vec3 } from '../../../core/index.js';

export const FORMATIONS = ['line', 'column', 'wedge', 'box', 'circle', 'echelon'] as const;
export type Formation = (typeof FORMATIONS)[number];

export interface Offset {
  readonly x: number;
  readonly z: number;
}

export function isFormation(value: unknown): value is Formation {
  return typeof value === 'string' && (FORMATIONS as readonly string[]).includes(value);
}

export function formationOffsets(kind: Formation, count: number, spacing: number): Offset[] {
  if (!(Number.isInteger(count) && count >= 0)) fail('PP3270', `formation count must be a whole number, got ${count}`);
  if (!(Number.isFinite(spacing) && spacing > 0)) fail('PP3270', `formation spacing must be a number greater than 0, got ${spacing}`);
  const out: Offset[] = [];
  for (let i = 0; i < count; i++) {
    switch (kind) {
      case 'line': out.push({ x: (i - (count - 1) / 2) * spacing, z: 0 }); break;
      case 'column': out.push({ x: 0, z: i * spacing }); break;
      case 'wedge': {
        const row = Math.ceil(i / 2);
        const side = i === 0 ? 0 : i % 2 === 1 ? -1 : 1;
        out.push({ x: side * row * spacing, z: row * spacing });
        break;
      }
      case 'box': {
        const cols = Math.ceil(Math.sqrt(count));
        const row = Math.floor(i / cols);
        const inRow = Math.min(cols, count - row * cols);
        out.push({ x: ((i % cols) - (inRow - 1) / 2) * spacing, z: row * spacing });
        break;
      }
      case 'circle': {
        if (count === 1) { out.push({ x: 0, z: 0 }); break; }
        const radius = Math.max(spacing, (count * spacing) / (2 * Math.PI));
        const a = (i / count) * 2 * Math.PI;
        out.push({ x: Math.sin(a) * radius, z: -Math.cos(a) * radius });
        break;
      }
      case 'echelon': out.push({ x: i * spacing * Math.SQRT1_2, z: i * spacing * Math.SQRT1_2 }); break;
    }
  }
  return out;
}

/** The unit vector a group faces on the ground plane (+z when there is no direction). */
export function facingOf(from: Vec3, to: Vec3): { x: number; z: number } {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const len = Math.hypot(dx, dz);
  return len < 1e-9 ? { x: 0, z: 1 } : { x: dx / len, z: dz / len };
}

/**
 * World slots: offsets turned to `facing` around `anchor`. `centered` puts the offsets'
 * centroid on the anchor (a group's destination); otherwise slot 0 is the anchor (a leader).
 */
export function placeSlots(anchor: Vec3, facing: { x: number; z: number }, offsets: readonly Offset[], centered: boolean): Vec3[] {
  let cx = 0;
  let cz = 0;
  if (centered && offsets.length > 0) {
    for (const o of offsets) { cx += o.x; cz += o.z; }
    cx /= offsets.length;
    cz /= offsets.length;
  }
  const rx = facing.z;
  const rz = -facing.x;
  return offsets.map((o) => {
    const x = o.x - cx;
    const back = o.z - cz;
    return new Vec3(anchor.x + rx * x - facing.x * back, anchor.y, anchor.z + rz * x - facing.z * back);
  });
}

/**
 * Units to slots: repeatedly the closest remaining (unit, slot) pair on the ground plane,
 * ties by slot then unit order — deterministic, and short walks for everyone. Returns the
 * slot index per unit, in the units' order.
 */
export function assignSlots(units: readonly Vec3[], slots: readonly Vec3[]): number[] {
  if (slots.length < units.length) fail('PP9270', `assignSlots: ${units.length} units for ${slots.length} slots`);
  const pairs: { d: number; u: number; s: number }[] = [];
  units.forEach((u, ui) => slots.forEach((s, si) => pairs.push({ d: Math.hypot(u.x - s.x, u.z - s.z), u: ui, s: si })));
  pairs.sort((a, b) => a.d - b.d || a.s - b.s || a.u - b.u);
  const unitSlot = new Array<number>(units.length).fill(-1);
  const taken = new Set<number>();
  let left = units.length;
  for (const p of pairs) {
    if (left === 0) break;
    if (unitSlot[p.u] !== -1 || taken.has(p.s)) continue;
    unitSlot[p.u] = p.s;
    taken.add(p.s);
    left--;
  }
  return unitSlot;
}
