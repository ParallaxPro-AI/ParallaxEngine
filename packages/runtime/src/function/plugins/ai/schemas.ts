/**
 * The ai plugin's components and events, with the SDK's field names verbatim
 * (sdk/parallax/ai.pyi is the contract). Methods are attached in index.ts.
 */

import { t } from '../../kernel/index.js';
import type { EventDef, FieldSpec, Schema } from '../../kernel/index.js';

export const BRAIN = 'brain';
export const PERCEPTION = 'perception';
export const DETECTABLE = 'detectable';
export const SQUAD_MEMBER = 'squad_member';
export const COVER_POINT = 'cover_point';
export const ORDERS = 'orders';
export const FLOCK = 'flock';
export const VISION = 'vision';
/** Built-in content kind: content/behavior_tree/<id>.json. */
export const BEHAVIOR_TREE = 'behavior_tree';

/** Components read by id (never imported): combat's Side, the HUD's awareness meter. */
export const SIDE = 'side';
export const AWARENESS = 'awareness';

const optional = (of: FieldSpec['type'], spec: Omit<FieldSpec, 'type' | 'default'> = {}): FieldSpec =>
  ({ type: { kind: 'optional', of }, default: null, ...spec });

export const SCHEMAS: Readonly<Record<string, Schema>> = {
  [BRAIN]: {
    tree: optional({ kind: 'string' }),
    /** Seconds between ticks; None: the tree's own `tick`. */
    tick: optional({ kind: 'number' }, { min: 0 }),
    enabled: t.bool({ default: true }),
  },
  [PERCEPTION]: {
    sight_range: t.number({ default: 20, min: 0, modifiable: true }),
    fov: t.number({ default: 120, min: 0, max: 360, modifiable: true }),
    eye_height: t.number({ default: 1.6, min: 0 }),
    close_range: t.number({ default: 2, min: 0 }),
    hearing: t.number({ default: 1, min: 0, modifiable: true }),
    memory: t.number({ default: 10, min: 0 }),
    notice_time: t.number({ default: 1, min: 0 }),
    calm_time: t.number({ default: 8, min: 0 }),
    suspicious: t.number({ default: 0.35, min: 0, max: 1 }),
    targets: optional({ kind: 'tag' }),
    interval: t.number({ default: 0.2, min: 0, max: 2 }),
  },
  [DETECTABLE]: {
    visibility: t.number({ default: 1, min: 0, modifiable: true }),
    height: t.number({ default: 1, min: 0 }),
  },
  [SQUAD_MEMBER]: {
    squad: t.string(),
    role: t.string({ default: '' }),
  },
  [COVER_POINT]: {
    height: t.number({ default: 1.2, min: 0 }),
  },
  [ORDERS]: {
    stance: t.enum(['aggressive', 'defensive', 'passive'], { default: 'aggressive' }),
    attack_range: t.number({ default: 6, min: 0, modifiable: true }),
    acquire_range: t.number({ default: 10, min: 0, modifiable: true }),
  },
  [FLOCK]: {
    group: t.string({ default: 'default' }),
    max_speed: t.number({ default: 4, min: 0, modifiable: true }),
    min_speed: t.number({ default: 1, min: 0 }),
    acceleration: t.number({ default: 8, min: 0 }),
    neighbor_radius: t.number({ default: 3, min: 0 }),
    separation_radius: t.number({ default: 1, min: 0 }),
    cohesion: t.number({ default: 1, min: 0 }),
    alignment: t.number({ default: 1, min: 0 }),
    separation: t.number({ default: 1.5, min: 0 }),
    wander: t.number({ default: 0.3, min: 0 }),
    home: optional({ kind: 'vec3' }),
    home_radius: t.number({ default: 10, min: 0 }),
    avoid: optional({ kind: 'tag' }),
    avoid_radius: t.number({ default: 5, min: 0 }),
    flee: t.number({ default: 2, min: 0 }),
    flat: t.bool({ default: false }),
  },
  [VISION]: {
    range: t.number({ default: 8, min: 0, modifiable: true }),
    team: optional({ kind: 'tag' }),
  },
};

export const AI_EVENTS = {
  spotted: { id: 'spotted', target: 'entity' },
  suspicious: { id: 'suspicious', target: 'entity' },
  lostTarget: { id: 'lost_target', target: 'entity' },
  heardNoise: { id: 'heard_noise', target: 'entity' },
  orderDone: { id: 'order_done', target: 'entity' },
  directorPhase: { id: 'director_phase' },
} as const satisfies Record<string, EventDef>;
