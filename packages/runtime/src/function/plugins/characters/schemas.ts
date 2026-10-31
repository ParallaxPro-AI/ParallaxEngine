/** Field schemas of the characters plugin's components (sdk/parallax/characters.pyi), names verbatim. */

import { Vec3 } from '../../../core/index.js';
import { t } from '../../kernel/index.js';
import type { FieldSpec, FieldType, Schema } from '../../kernel/index.js';

export const CHARACTER = 'character';
export { SEAT } from '../../services/index.js';

const record = (fields: Schema): FieldType => ({ kind: 'record', fields });
const optionalRecord = (fields: Schema): FieldSpec => ({ type: { kind: 'optional', of: record(fields) }, default: null });

export const STANCES_RECORD: Schema = {
  crouch_height: t.number({ default: 1.2, min: 0 }),
  crouch_speed: t.number({ default: 2, min: 0 }),
  prone: t.bool({ default: false }),
  prone_height: t.number({ default: 0.8, min: 0 }),
  prone_speed: t.number({ default: 0.8, min: 0 }),
};

export const TRAVERSAL_RECORD: Schema = {
  vault_height: t.number({ default: 1.1, min: 0 }),
  vault_depth: t.number({ default: 0.9, min: 0 }),
  climb_height: t.number({ default: 2.4, min: 0 }),
  reach: t.number({ default: 0.6, min: 0 }),
  vault_time: t.number({ default: 0.45, min: 0.05 }),
  climb_time: t.number({ default: 0.9, min: 0.05 }),
};

export const SWIMMING_RECORD: Schema = {
  speed: t.number({ default: 2.8, min: 0 }),
  run_speed: t.number({ default: 4, min: 0 }),
  vertical_speed: t.number({ default: 2, min: 0 }),
  enter_depth: t.number({ default: 1.35, min: 0 }),
  exit_depth: t.number({ default: 0.9, min: 0 }),
  float_depth: t.number({ default: 1.25, min: 0 }),
};

export const SKYDIVE_RECORD: Schema = {
  enter_height: t.number({ default: 12, min: 2 }),
  enter_speed: t.number({ default: 9, min: 0 }),
  terminal: t.number({ default: 38, min: 0 }),
  dive_terminal: t.number({ default: 58, min: 0 }),
  steer: t.number({ default: 16, min: 0 }),
  acceleration: t.number({ default: 14, min: 0 }),
};

export const PARACHUTE_RECORD: Schema = {
  glide_speed: t.number({ default: 13, min: 0 }),
  sink: t.number({ default: 4.2, min: 0 }),
  turn_speed: t.number({ default: 75, min: 0 }),
  flare_sink: t.number({ default: 1.8, min: 0 }),
  dive_sink: t.number({ default: 10, min: 0 }),
  deploy_time: t.number({ default: 0.9, min: 0.05 }),
  min_height: t.number({ default: 0, min: 0 }),
  auto_height: t.number({ default: 0, min: 0 }),
};

export const CARRY_RECORD: Schema = {
  offset: t.vec3({ default: new Vec3(0, 1.3, 0.1) }),
  drop: t.vec3({ default: new Vec3(1.1, 0, 0.5) }),
  speed_scale: t.number({ default: 0.55, min: 0.05, max: 1 }),
};

export const CHARACTER_SCHEMA: Schema = {
  walk_speed: t.number({ default: 4, min: 0, modifiable: true }),
  run_speed: t.number({ default: 7, min: 0, modifiable: true }),
  acceleration: t.number({ default: 30, min: 0 }),
  jump_height: t.number({ default: 1.2, min: 0, modifiable: true }),
  air_jumps: t.int({ default: 0, min: 0 }),
  air_control: t.number({ default: 0.5, min: 0, max: 1 }),
  turn_speed: t.number({ default: 720, min: 0 }),
  face_movement: t.bool({ default: true }),
  radius: t.number({ default: 0.35, min: 0 }),
  height: t.number({ default: 1.8, min: 0 }),
  max_slope: t.number({ default: 45, min: 0, max: 90 }),
  step_height: t.number({ default: 0.3, min: 0 }),
  gravity_scale: t.number({ default: 1 }),
  mode: t.enum(['platformer2d', 'topdown2d', '3d'], { default: '3d' }),
  /** World axes the character never moves along (["z"]: a 2.5D side-scroller's lane). */
  lock_axes: t.list({ kind: 'enum', values: ['x', 'z'] }, { default: [] }),
  /** None: EYE_FRACTION × height. */
  eye_height: { type: { kind: 'optional', of: { kind: 'number' } }, default: null, min: 0 },
  hold_socket: t.string({ default: 'grip_r' }),
  hold_offset: t.vec3({ default: new Vec3(0.25, 1.1, 0.55) }),
  animate: t.bool({ default: true }),
  /** "auto": an Animator without a base-layer graph plays clips picked from its model's clip names (locomotion.ts). */
  locomotion: t.enum(['auto', 'off'], { default: 'auto' }),
  /** Locomotion state → clip, over the names automatic locomotion would pick. */
  clips: { type: { kind: 'dict', of: { kind: 'string' } }, default: {} },
  stances: optionalRecord(STANCES_RECORD),
  traversal: optionalRecord(TRAVERSAL_RECORD),
  swim: optionalRecord(SWIMMING_RECORD),
  skydive: optionalRecord(SKYDIVE_RECORD),
  parachute: optionalRecord(PARACHUTE_RECORD),
  carry: optionalRecord(CARRY_RECORD),
};

/** The shared `seat` definition lives with the characters service (vehicles register it too). */
export { SEAT_COMPONENT, SEAT_SCHEMA } from '../../services/index.js';

// ── Typed views of the records (runtime form) ─────────────────────────────────

export interface Stances { crouch_height: number; crouch_speed: number; prone: boolean; prone_height: number; prone_speed: number }
export interface Traversal { vault_height: number; vault_depth: number; climb_height: number; reach: number; vault_time: number; climb_time: number }
export interface Swimming { speed: number; run_speed: number; vertical_speed: number; enter_depth: number; exit_depth: number; float_depth: number }
export interface Skydive { enter_height: number; enter_speed: number; terminal: number; dive_terminal: number; steer: number; acceleration: number }
export interface Parachute {
  glide_speed: number; sink: number; turn_speed: number; flare_sink: number; dive_sink: number; deploy_time: number; min_height: number; auto_height: number;
}
export interface Carry { offset: Vec3; drop: Vec3; speed_scale: number }
