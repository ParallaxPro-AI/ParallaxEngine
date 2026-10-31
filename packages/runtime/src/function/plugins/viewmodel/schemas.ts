/** Field schemas of the viewmodel plugin's components (sdk/parallax/viewmodel.pyi), names verbatim. */

import { Color, Vec3 } from '../../../core/index.js';
import { t } from '../../kernel/index.js';
import type { FieldType, Schema } from '../../kernel/index.js';

export const VIEWMODEL = 'viewmodel';
export const VIEWMODEL_ITEM = 'viewmodel_item';

export const RECOIL_RECORD: Schema = {
  kick_back: t.number({ default: 0.02, min: 0 }),
  kick_up: t.number({ default: 0.007, min: 0 }),
  pitch: t.number({ default: 3 }),
  yaw: t.number({ default: 0.8, min: 0 }),
  roll: t.number({ default: 1.8, min: 0 }),
  frequency: t.number({ default: 9, min: 0.1 }),
  damping: t.number({ default: 0.42, min: 0 }),
  pattern: t.list({ kind: 'number' }, { default: [1.45, 1.3, 1.15, 1.05, 1.0] }),
  reset: t.number({ default: 0.3, min: 0 }),
};

export const POSE_KEY_RECORD: Schema = {
  at: t.number({ min: 0, max: 1 }),
  offset: t.vec3({ default: Vec3.ZERO }),
  turn: t.vec3({ default: Vec3.ZERO }),
};

export const POSE_CUE_RECORD: Schema = {
  at: t.number({ min: 0, max: 1 }),
  name: t.string(),
};

export const VIEW_POSE_RECORD: Schema = {
  seconds: t.number({ default: 0.6, min: 0.01 }),
  keys: t.list({ kind: 'record', fields: POSE_KEY_RECORD }, { default: [] }),
  cues: t.list({ kind: 'record', fields: POSE_CUE_RECORD }, { default: [] }),
  hold: t.bool({ default: false }),
};

function defaults(schema: Schema): Record<string, unknown> {
  return Object.fromEntries(Object.entries(schema).map(([k, spec]) => [k, spec.default]));
}

const recoil: FieldType = { kind: 'record', fields: RECOIL_RECORD };

export const VIEWMODEL_ITEM_SCHEMA: Schema = {
  hip: t.vec3({ default: new Vec3(0.14, -0.3, 0.4) }),
  hip_turn: t.vec3({ default: Vec3.ZERO }),
  sight: t.string({ default: 'sight' }),
  eye_relief: t.number({ default: 0.17, min: 0 }),
  aim: { type: { kind: 'optional', of: { kind: 'vec3' } }, default: null },
  /** [right, left]: a tuple in the SDK, a two-item list here (the kernel keeps tuples as lists). */
  grips: t.list({ kind: 'string' }, { default: ['grip_r', 'grip_l'] }),
  aim_time: t.number({ default: 0.22, min: 0 }),
  sway: t.number({ default: 1, min: 0 }),
  recoil: { type: recoil, default: defaults(RECOIL_RECORD) },
};

export const VIEWMODEL_SCHEMA: Schema = {
  item: { type: { kind: 'optional', of: { kind: 'ref', to: 'prefab' } }, default: null },
  arms: { type: { kind: 'optional', of: { kind: 'ref', to: 'prefab' } }, default: null },
  arms_offset: t.vec3({ default: new Vec3(0, -0.05, 0) }),
  /** Without `arms`: draw the engine's procedural arms (resource/models/procedural_arms.ts). */
  procedural_arms: t.bool({ default: true }),
  skin_color: t.color({ default: new Color(0.8, 0.6, 0.48) }),
  sleeve_color: t.color({ default: new Color(0.16, 0.18, 0.22) }),
  body: { type: { kind: 'optional', of: { kind: 'entity' } }, default: null },
  fov: t.number({ default: 54, min: 10, max: 120 }),
  aim_fov: t.number({ default: 40, min: 10, max: 120 }),
  near: t.number({ default: 0.01, min: 0.001 }),
  body_options: { type: { kind: 'dict', of: { kind: 'string' } }, default: {} },
  hide_body: t.bool({ default: false }),
  bob: t.number({ default: 1, min: 0 }),
  sway: t.number({ default: 1, min: 0 }),
  lag: t.number({ default: 1, min: 0 }),
  sprint_offset: t.vec3({ default: new Vec3(0.04, -0.07, -0.06) }),
  sprint_turn: t.vec3({ default: new Vec3(-8, -28, 14) }),
  poses: { type: { kind: 'dict', of: { kind: 'record', fields: VIEW_POSE_RECORD } }, default: {} },
  aiming: t.number({ default: 0, min: 0, max: 1 }),
  pose: { type: { kind: 'optional', of: { kind: 'string' } }, default: null },
};
