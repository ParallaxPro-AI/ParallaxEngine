/**
 * The `striker`, `hurtbox`, `lock_on` and `impact_damage` components (sdk/parallax/combat.pyi).
 */

import { fail, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import { componentEntity, t } from '../../kernel/index.js';
import type { ComponentDef, Fields, Schema } from '../../kernel/index.js';
import { bind, describe, finite } from './args.js';
import { HURTBOX, IMPACT_DAMAGE, LOCK_ON, STRIKE, STRIKER } from './engagement.js';
import type { Engagement, StrikeRef } from './engagement.js';

const ZONE_RECORD: Schema = {
  name: t.string({ default: '' }),
  socket: { type: { kind: 'optional', of: { kind: 'string' } }, default: null },
  offset: t.vec3({ default: Vec3.ZERO }),
  length: t.number({ default: 0, min: 0 }),
  radius: t.number({ default: 0.3, min: 0 }),
  multiplier: t.number({ default: 1, min: 0 }),
};

export const STRIKER_SCHEMA: Schema = {};
export const HURTBOX_SCHEMA: Schema = {
  zones: t.list({ kind: 'record', fields: ZONE_RECORD }, { default: [] }),
};
export const LOCK_ON_SCHEMA: Schema = {
  range: t.number({ default: 25, min: 0 }),
  angle: t.number({ default: 60, min: 0, max: 180 }),
  break_range: t.number({ default: 35, min: 0 }),
  line_of_sight: t.bool({ default: true }),
  /** Engine-kept. */
  target: { type: { kind: 'optional', of: { kind: 'entity' } }, default: null },
};
export const IMPACT_DAMAGE_SCHEMA: Schema = {
  threshold: { type: { kind: 'optional', of: { kind: 'number' } }, default: null, min: 0 },
  min_speed: t.number({ default: 0, min: 0 }),
  kind: { type: { kind: 'optional', of: { kind: 'tag' } }, default: null },
  from_breakable: t.bool({ default: false }),
};

type State = () => Engagement;

function owner(fields: unknown): EntityId {
  return componentEntity(fields as Fields);
}

function strikeRef(value: unknown, where: string): StrikeRef {
  const ref = value as Partial<StrikeRef> | null;
  if (typeof value !== 'object' || ref === null || typeof ref.id !== 'string' || ref.kind !== STRIKE) {
    fail('PP7402', `${where} must be a strike (Content.strike.<id>), got ${describe(value)}`, {
      fix: 'Add content/strike/<id>.json and pass Content.strike.<id>.',
    });
  }
  return ref as StrikeRef;
}

function define(state: State, methods: object, getters: Record<string, (fields: Fields) => unknown>): object {
  Object.defineProperty(methods, 'entity', {
    get(this: Fields): unknown { return state().kernel.handles.wrap(owner(this)); }, enumerable: false,
  });
  for (const [name, read] of Object.entries(getters)) {
    Object.defineProperty(methods, name, { get(this: Fields): unknown { return read(this); }, enumerable: false });
  }
  return methods;
}

export function engagementComponents(state: State): ComponentDef[] {
  const striker = define(state, {
    strike(this: Fields, ...args: unknown[]): null {
      const a = bind('strike', args, ['strike'], [], ['strike']);
      state().strike(owner(this), strikeRef(a['strike'], 'strike()'));
      return null;
    },
    cancel(this: Fields, ...args: unknown[]): null {
      bind('cancel', args, []);
      state().cancel(owner(this));
      return null;
    },
  }, {
    active: (f) => state().active(owner(f)),
    striking: (f) => state().swing(owner(f)) !== undefined,
    current: (f) => state().swing(owner(f))?.ref ?? null,
  });
  const lockOn = define(state, {
    lock(this: Fields, ...args: unknown[]): boolean {
      bind('lock', args, []);
      return state().lock(owner(this), this);
    },
    cycle(this: Fields, ...args: unknown[]): boolean {
      const a = bind('cycle', args, ['direction']);
      const direction = a['direction'] === undefined ? 1 : finite(a['direction'], 'cycle() direction');
      return state().cycle(owner(this), this, direction);
    },
    release(this: Fields, ...args: unknown[]): null {
      bind('release', args, []);
      state().release(owner(this), this);
      return null;
    },
  }, {
    locked: (f) => f['target'] !== null && f['target'] !== undefined,
  });
  return [
    { id: STRIKER, schema: STRIKER_SCHEMA, methods: striker },
    { id: HURTBOX, schema: HURTBOX_SCHEMA, methods: define(state, {}, {}) },
    { id: LOCK_ON, schema: LOCK_ON_SCHEMA, methods: lockOn },
    { id: IMPACT_DAMAGE, schema: IMPACT_DAMAGE_SCHEMA, methods: define(state, {}, {}) },
  ];
}
