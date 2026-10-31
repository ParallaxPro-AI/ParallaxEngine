/**
 * Presentation the vehicle drives from its own state, as data on other components (read by
 * the renderers and the audio plugin by their SDK ids — no handles, nothing to cancel):
 *
 *   `vehicle_effects` names prefab children by their child name:
 *     exhaust       Particles: emitting while the engine runs, rate_scale 0.3 → 2 with throttle
 *     engine_sound  AudioSource: playing while the engine runs, pitch 0.7 → 2 with revs (the
 *                   drivetrain's rpm, else speed / max_speed), volume 0.5 → 1 with throttle,
 *                   × engine_volume
 *     tire_smoke    Particles: emitting while any wheel skids, rate_scale with the slip
 *     skid_sound    AudioSource: playing while any wheel skids
 *     damage_smoke  Particles: emitting while the engine part is under half health
 *
 *   `vehicle_rig` poses the entity's own Model joints (code models' hinges):
 *     wheels        hinge per wheel (front left, front right, rear left, rear right) rolled by
 *                   the distance the car travels / wheel radius
 *     steer         hinges posed to the front wheels' steering angle (degrees)
 *     propellers    hinges spun at `propeller_rpm` × throttle
 *     controls      joint → input ("pitch", "roll", "yaw", "steer", "throttle", "flaps"),
 *                   posed to input × `control_angle` degrees
 *
 * Writes happen once per fixed step and only when a value changes.
 */

import type { EntityRecord, Fields, Kernel } from '../../kernel/index.js';

export const VEHICLE_EFFECTS = 'vehicle_effects';
export const VEHICLE_RIG = 'vehicle_rig';
export const CONTROL_INPUTS = ['pitch', 'roll', 'yaw', 'steer', 'throttle', 'flaps'] as const;
const PARTICLES = 'particles';
const AUDIO_SOURCE = 'audio_source';
const MODEL = 'model';

export interface Presented {
  readonly engineOn: boolean;
  readonly throttle: number;
  /** 0..1 of the rev range. */
  readonly revs: number;
  readonly skidding: boolean;
  /** Largest wheel slip angle (deg). */
  readonly slip: number;
  readonly damaged: boolean;
  /** Front wheel steering angle (deg). */
  readonly steerAngle: number;
  /** Degrees each wheel rolled this step. */
  readonly roll: number;
  readonly inputs: Readonly<Record<string, number>>;
  readonly dt: number;
}

export function child(kernel: Kernel, record: EntityRecord, name: string | null): EntityRecord | undefined {
  if (name === null || name === '') return undefined;
  for (const id of record.children) {
    const c = kernel.world.get(id);
    if (c?.childName === name) return c;
  }
  return undefined;
}

function set(fields: Fields | undefined, key: string, value: unknown): void {
  if (fields === undefined || fields[key] === value) return;
  fields[key] = value;
}

const round = (v: number): number => Math.round(v * 1000) / 1000;

export function presentEffects(kernel: Kernel, record: EntityRecord, effects: Fields, p: Presented): void {
  const particles = (name: unknown): Fields | undefined => child(kernel, record, name as string | null)?.components.get(PARTICLES);
  const audio = (name: unknown): Fields | undefined => child(kernel, record, name as string | null)?.components.get(AUDIO_SOURCE);
  const exhaust = particles(effects['exhaust']);
  set(exhaust, 'emitting', p.engineOn);
  set(exhaust, 'rate_scale', round(0.3 + 1.7 * Math.abs(p.throttle)));
  const engine = audio(effects['engine_sound']);
  set(engine, 'playing', p.engineOn);
  set(engine, 'pitch', round(0.7 + 1.3 * Math.min(Math.max(p.revs, 0), 1)));
  set(engine, 'volume', round((0.5 + 0.5 * Math.abs(p.throttle)) * (effects['engine_volume'] as number)));
  const smoke = particles(effects['tire_smoke']);
  set(smoke, 'emitting', p.skidding);
  set(smoke, 'rate_scale', round(Math.min(2, 0.5 + Math.abs(p.slip) / 20)));
  set(audio(effects['skid_sound']), 'playing', p.skidding);
  set(particles(effects['damage_smoke']), 'emitting', p.damaged);
}

const wrap = (deg: number): number => ((deg % 360) + 360) % 360;

/** Spinning joints continue from their current value on the Model (so saves and snapshots need nothing else). */
export function presentRig(record: EntityRecord, rig: Fields, p: Presented): void {
  const model = record.components.get(MODEL);
  if (model === undefined) return;
  const before = (model['joints'] ?? {}) as Record<string, number>;
  const joints: Record<string, number> = { ...before };
  for (const j of rig['wheels'] as string[]) joints[j] = round(wrap((before[j] ?? 0) + p.roll));
  for (const j of rig['steer'] as string[]) joints[j] = round(p.steerAngle);
  const rpm = rig['propeller_rpm'] as number;
  const share = p.engineOn ? 0.15 + 0.85 * Math.abs(p.throttle) : 0;
  for (const j of rig['propellers'] as string[]) joints[j] = round(wrap((before[j] ?? 0) + rpm * share * 6 * p.dt));
  const angle = rig['control_angle'] as number;
  for (const [joint, input] of Object.entries(rig['controls'] as Record<string, string>)) {
    joints[joint] = round((p.inputs[input] ?? 0) * angle);
  }
  const changed = Object.keys(joints).some((k) => joints[k] !== before[k]);
  if (changed) model['joints'] = joints;
}
