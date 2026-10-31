/**
 * Prop kits: data-authored dressing for rooms (dungeon rooms, structure rooms). A kit is a
 * `prop_kit` content entry:
 *
 *   {"density": 6, "max_per_room": 12, "wall_step": 3, "clearance": 1.5, "inset": 0.8,
 *    "props": [{"prefab": "brazier", "place": "corner", "weight": 3, "radius": 0.5},
 *              {"prefab": "sarcophagus", "place": "wall", "weight": 2, "radius": 1.0},
 *              {"prefab": "bones", "place": "floor", "scale": [0.8, 1.2]},
 *              {"prefab": "altar", "place": "center"}]}
 *
 * A room gets at most min(max_per_room, density · area / 100) props, placed in order:
 * one `center` prop (only where the caller allows it), a `corner` prop in each corner
 * (facing the room diagonally), `wall` props every `wall_step` meters along the walls
 * (facing into the room), then `floor` props scattered (random yaw) — each kind drawn by
 * weight among the kit's props of that place. Props stay `inset` meters from the walls,
 * never overlap (discs of their `radius`), and keep `clearance` meters from every
 * keep-clear point (doors, the room center where keys, spawns and objectives go; the
 * center prop itself ignores them). All
 * rolls come from the caller's seeded generator: same kit, room and seed, same props.
 */

import type { SeededRandom } from '../../../core/index.js';

export type PropPlace = 'center' | 'corner' | 'wall' | 'floor';

export interface KitProp {
  readonly prefab: string;
  readonly place: PropPlace;
  readonly weight: number;
  readonly radius: number;
  readonly scale: readonly [number, number];
}

export interface PropKit {
  readonly id: string;
  readonly density: number;
  readonly maxPerRoom: number;
  readonly wallStep: number;
  readonly clearance: number;
  readonly inset: number;
  readonly props: readonly KitProp[];
}

export interface PropPlacement {
  readonly prefab: string;
  /** Local x, z on the room floor. */
  readonly x: number;
  readonly z: number;
  /** Degrees about +y (0 faces +z). */
  readonly yaw: number;
  readonly scale: number;
  readonly place: PropPlace;
}

export interface RoomArea {
  readonly x0: number;
  readonly z0: number;
  readonly x1: number;
  readonly z1: number;
}

export function dressRoom(
  kit: PropKit, room: RoomArea, rng: SeededRandom, options: { readonly keepClear: readonly (readonly [number, number])[]; readonly center: boolean },
): PropPlacement[] {
  const out: PropPlacement[] = [];
  const area = (room.x1 - room.x0) * (room.z1 - room.z0);
  const budget = Math.min(kit.maxPerRoom, Math.floor((kit.density * area) / 100));
  const ax = room.x0 + kit.inset;
  const bx = room.x1 - kit.inset;
  const az = room.z0 + kit.inset;
  const bz = room.z1 - kit.inset;
  if (budget <= 0 || bx <= ax || bz <= az) return out;
  const byPlace = (place: PropPlace): KitProp[] => kit.props.filter((p) => p.place === place);
  const draw = (list: readonly KitProp[]): KitProp | undefined => {
    const total = list.reduce((a, p) => a + p.weight, 0);
    if (total <= 0) return undefined;
    let roll = rng.next() * total;
    for (const p of list) {
      roll -= p.weight;
      if (roll < 0) return p;
    }
    return list[list.length - 1];
  };
  // Placed discs (x, z, radius).
  const discs: [number, number, number][] = [];
  const fits = (x: number, z: number, r: number, keepClear: boolean): boolean => {
    if (x - r < ax - 1e-9 || x + r > bx + 1e-9 || z - r < az - 1e-9 || z + r > bz + 1e-9) return false;
    if (keepClear) for (const [kx, kz] of options.keepClear) if (Math.hypot(x - kx, z - kz) < kit.clearance + r) return false;
    for (const [px, pz, pr] of discs) if (Math.hypot(x - px, z - pz) < r + pr) return false;
    return true;
  };
  const place = (prop: KitProp, x: number, z: number, yaw: number, keepClear = true): boolean => {
    if (out.length >= budget) return false;
    const scale = prop.scale[0] + (prop.scale[1] - prop.scale[0]) * rng.next();
    const r = prop.radius * scale;
    if (!fits(x, z, r, keepClear)) return false;
    discs.push([x, z, r]);
    out.push({ prefab: prop.prefab, x, z, yaw, scale, place: prop.place });
    return true;
  };

  const center = draw(byPlace('center'));
  if (options.center && center !== undefined) place(center, (room.x0 + room.x1) / 2, (room.z0 + room.z1) / 2, 0, false);

  const corners = byPlace('corner');
  if (corners.length > 0) {
    for (const [sx, sz] of [[0, 0], [1, 0], [1, 1], [0, 1]] as const) {
      const prop = draw(corners)!;
      const r = prop.radius * prop.scale[1];
      const x = sx === 0 ? ax + r : bx - r;
      const z = sz === 0 ? az + r : bz - r;
      // Facing the room: +x+z from the (x0, z0) corner is 45°, and so on round.
      const yaw = sx === 0 ? (sz === 0 ? 45 : 135) : (sz === 0 ? -45 : -135);
      place(prop, x, z, yaw);
    }
  }

  const walls = byPlace('wall');
  if (walls.length > 0 && kit.wallStep > 0) {
    const sides: Array<{ along: 'x' | 'z'; fixed: number; from: number; to: number; yaw: number; inward: number }> = [
      { along: 'x', fixed: az, from: ax, to: bx, yaw: 0, inward: 1 },
      { along: 'x', fixed: bz, from: ax, to: bx, yaw: 180, inward: -1 },
      { along: 'z', fixed: ax, from: az, to: bz, yaw: 90, inward: 1 },
      { along: 'z', fixed: bx, from: az, to: bz, yaw: -90, inward: -1 },
    ];
    for (const side of sides) {
      const span = side.to - side.from;
      const count = Math.floor(span / kit.wallStep);
      for (let k = 0; k < count; k++) {
        const prop = draw(walls)!;
        const r = prop.radius * prop.scale[1];
        const t = side.from + kit.wallStep * (k + 0.5) + (span - count * kit.wallStep) / 2;
        const off = side.fixed + side.inward * r;
        if (side.along === 'x') place(prop, t, off, side.yaw);
        else place(prop, off, t, side.yaw);
      }
    }
  }

  const floor = byPlace('floor');
  if (floor.length > 0) {
    const attempts = Math.max(0, budget - out.length) * 4;
    for (let k = 0; k < attempts && out.length < budget; k++) {
      const prop = draw(floor)!;
      const x = ax + (bx - ax) * rng.next();
      const z = az + (bz - az) * rng.next();
      place(prop, x, z, Math.floor(rng.next() * 360) - 180);
    }
  }
  return out;
}
