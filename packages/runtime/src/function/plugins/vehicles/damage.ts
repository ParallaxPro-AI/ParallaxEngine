/**
 * The damage model (the `vehicle_damage` component, sdk/parallax/vehicles.pyi): named
 * parts with their own health, what losing each one does, and flooding for boats.
 *
 *   engine    drive force (and aircraft thrust) × (0.3 + 0.7 × health fraction); 0 when
 *             destroyed — the engine is dead.
 *   steering  steering lock × (0.4 + 0.6 × fraction).
 *   wheel     `index` (0 front left, 1 front right, 2 rear left, 3 rear right) loses grip:
 *             × (0.5 + 0.5 × fraction), 0.25 when destroyed (a flat).
 *   hull      boats take on water: `leak_rate` × the hull's lost fraction per second,
 *             minus `pump_rate`; `flooded` (0..1) slows the boat (× 1 − 0.7 × flooded) and
 *             weighs it down (the water aboard: flooded × (1100 kg/m³ × hull volume − mass)),
 *             so it rides lower on its Buoyancy. At `sink_at` it fills (flooded 1) and sinks.
 *   body      only its own health (the shell): add `wrecks=True` to make it count.
 *
 * Damage arrives by `damage(amount, at=, part=)` (the nearest part to `at` within its
 * radius, else the nearest part), by impacts (contact force over `impact_threshold`
 * newtons deals force / threshold, at the contact point) and, with `from_health`, by the
 * combat plugin's `damaged` events on the same entity (weapons hitting the vehicle). A
 * part reaching 0 hides its `model_part` (and below half health shows `damaged_part`) on
 * the entity's Model — the deformation hook — and raises `vehicle_part_destroyed`. The
 * vehicle is wrecked when a part marked `wrecks` is destroyed (default: hull and body
 * parts) or it sinks: the engine stops and `vehicle_disabled` (reason "destroyed" | "sunk") is raised once.
 *
 * Current part health, `flooded` and `wrecked` are component fields, so saves and
 * snapshots keep them.
 */

import { Vec3 } from '../../../core/index.js';
import type { Fields } from '../../kernel/index.js';

export const PART_ROLES = ['engine', 'steering', 'wheel', 'hull', 'body'] as const;
export type PartRole = typeof PART_ROLES[number];

export interface VehiclePart {
  readonly name: string;
  readonly role: string;
  readonly at: Vec3;
  readonly radius: number;
  readonly health: number;
  readonly index: number;
  readonly wrecks: boolean | null;
  readonly model_part: string | null;
  readonly damaged_part: string | null;
}

export interface DamageFields extends Fields {
  parts: VehiclePart[];
  impact_threshold: number | null;
  from_health: boolean;
  leak_rate: number;
  pump_rate: number;
  sink_at: number;
  health: Record<string, number>;
  flooded: number;
  wrecked: boolean;
}

export interface DamageEffects {
  readonly engine: number;
  readonly steer: number;
  readonly wheelGrip: readonly number[];
  readonly speed: number;
}

export const NO_DAMAGE: DamageEffects = { engine: 1, steer: 1, wheelGrip: [1, 1, 1, 1], speed: 1 };

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function partHealth(d: DamageFields, part: VehiclePart): number {
  return d.health[part.name] ?? part.health;
}

export function fraction(d: DamageFields, part: VehiclePart): number {
  return part.health <= 0 ? 0 : clamp(partHealth(d, part) / part.health, 0, 1);
}

export function wrecks(part: VehiclePart): boolean {
  return part.wrecks ?? (part.role === 'hull' || part.role === 'body');
}

/** What the parts' health does to the vehicle now. */
export function effectsOf(d: DamageFields | undefined): DamageEffects {
  if (d === undefined) return NO_DAMAGE;
  let engine = 1;
  let steer = 1;
  const wheelGrip = [1, 1, 1, 1];
  for (const p of d.parts) {
    const f = fraction(d, p);
    if (p.role === 'engine') engine = Math.min(engine, f === 0 ? 0 : 0.3 + 0.7 * f);
    else if (p.role === 'steering') steer = Math.min(steer, 0.4 + 0.6 * f);
    else if (p.role === 'wheel' && p.index >= 0 && p.index < 4) wheelGrip[p.index] = Math.min(wheelGrip[p.index]!, f === 0 ? 0.25 : 0.5 + 0.5 * f);
  }
  if (d.wrecked) engine = 0;
  return { engine, steer, wheelGrip, speed: 1 - 0.7 * clamp(d.flooded, 0, 1) };
}

/** The part a hit at `local` (chassis frame) lands on: inside a part's radius first, else the nearest. */
export function partAt(d: DamageFields, local: Vec3 | undefined): VehiclePart | undefined {
  if (d.parts.length === 0) return undefined;
  if (local === undefined) return d.parts.find((p) => p.role === 'body' || p.role === 'hull') ?? d.parts[0];
  let best: VehiclePart | undefined;
  let bestScore = Infinity;
  for (const p of d.parts) {
    const dist = p.at.distance_to(local);
    // Inside a radius beats outside; then nearest surface.
    const score = dist <= p.radius ? dist - 1e6 : dist - p.radius;
    if (score < bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

export interface PartChange {
  readonly part: VehiclePart;
  readonly dealt: number;
  readonly destroyed: boolean;
}

/** Lower one part's health (never below 0). */
export function damagePart(d: DamageFields, part: VehiclePart, amount: number): PartChange {
  const before = partHealth(d, part);
  const after = Math.max(0, before - Math.max(0, amount));
  d.health = { ...d.health, [part.name]: after };
  return { part, dealt: before - after, destroyed: before > 0 && after === 0 };
}

/** Hull leaks per second minus the pump, for a boat's flooding. */
export function floodRate(d: DamageFields): number {
  let lost = 0;
  for (const p of d.parts) if (p.role === 'hull') lost += 1 - fraction(d, p);
  return d.leak_rate * lost - d.pump_rate;
}

/** The Model parts the damage shows and hides now: name → shown. */
export function modelParts(d: DamageFields): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const p of d.parts) {
    const f = fraction(d, p);
    if (p.model_part !== null) out[p.model_part] = f > 0;
    if (p.damaged_part !== null) out[p.damaged_part] = f < 0.5;
  }
  return out;
}
