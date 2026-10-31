/**
 * The `health`, `health_bar`, `side` and `effects` components (sdk/parallax/combat.pyi).
 * Methods run with `this` = the component's fields; the owner is `componentEntity(this)`.
 * HealthBar is data for the renderers (they read it by id).
 */

import { fail } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import { componentEntity, t } from '../../kernel/index.js';
import type { ComponentDef, Fields, Schema } from '../../kernel/index.js';
import {
  bind, bool, describe, finite, nonNegative, optionalEntity, optionalPoint, optionalString, optionalTag, positive,
} from './args.js';
import { EFFECTS, HEALTH, HEALTH_BAR, SIDE, STATUS_EFFECT } from './state.js';
import type { CombatState, StatusEffectRef } from './state.js';
import type { Engagement } from './engagement.js';

export const HEALTH_SCHEMA: Schema = {
  current: t.number({ default: 100, min: 0 }),
  max: t.number({ default: 100, min: 1, modifiable: true }),
  /** Absorbed before health. */
  shield: t.number({ default: 0, min: 0 }),
  /** Subtracted from every hit. */
  flat_armor: t.number({ default: 0, min: 0, modifiable: true }),
  /** Fraction of the remainder absorbed. */
  armor: t.number({ default: 0, min: 0, max: 1, modifiable: true }),
  /** Health never drops below this (training dummies). */
  minimum: t.number({ default: 0, min: 0 }),
  /** Seconds. */
  invulnerable_after_hit: t.number({ default: 0 }),
  destroy_on_death: t.bool({ default: true }),
};

export const HEALTH_BAR_SCHEMA: Schema = {
  offset: t.vec3(),
  /** Used when no ally/enemy colour applies. */
  color: { type: { kind: 'optional', of: { kind: 'color' } }, default: null },
  /** Per viewer: used when the viewer's side matches. */
  ally_color: { type: { kind: 'optional', of: { kind: 'color' } }, default: null },
  enemy_color: { type: { kind: 'optional', of: { kind: 'color' } }, default: null },
  hide_when_full: t.bool({ default: true }),
  /** The bar's look (CSS pixels; None: the HUD's): width, height, track and border colours. */
  width: { type: { kind: 'optional', of: { kind: 'number' } }, default: null, min: 4, max: 400 },
  height: { type: { kind: 'optional', of: { kind: 'number' } }, default: null, min: 1, max: 60 },
  background: { type: { kind: 'optional', of: { kind: 'color' } }, default: null },
  border: { type: { kind: 'optional', of: { kind: 'color' } }, default: null },
};

export const SIDE_SCHEMA: Schema = {
  side: { type: { kind: 'tag' } },
};

export const EFFECTS_SCHEMA: Schema = {};

type State = () => CombatState;

function owner(fields: unknown): EntityId {
  return componentEntity(fields as Fields);
}

function withEntity(state: State, methods: object, getters: Record<string, (fields: Fields) => unknown> = {}): object {
  Object.defineProperty(methods, 'entity', {
    get(this: Fields): unknown { return state().kernel.handles.wrap(owner(this)); },
    enumerable: false,
  });
  for (const [name, read] of Object.entries(getters)) {
    Object.defineProperty(methods, name, { get(this: Fields): unknown { return read(this); }, enumerable: false });
  }
  return methods;
}

function healthMethods(state: State, engaged: () => Engagement): object {
  const methods = {
    damage(this: Fields, ...args: unknown[]): number {
      const a = bind('damage', args, ['amount'], ['source', 'kind', 'point', 'ignores_armor', 'lethal'], ['amount']);
      const handles = state().kernel.handles;
      return state().hit(owner(this), {
        amount: finite(a['amount'], 'damage() amount'),
        source: optionalEntity(handles, a['source'], 'damage() source'),
        kind: optionalTag(a['kind'], 'damage() kind'),
        point: optionalPoint(a['point'], 'damage() point'),
        ignoresArmor: a['ignores_armor'] === undefined ? false : bool(a['ignores_armor'], 'damage() ignores_armor'),
        lethal: a['lethal'] === undefined ? true : bool(a['lethal'], 'damage() lethal'),
      }).dealt;
    },
    add_shield(this: Fields, ...args: unknown[]): null {
      const a = bind('add_shield', args, ['amount'], ['seconds', 'key'], ['amount']);
      const seconds = a['seconds'] === undefined || a['seconds'] === null ? null : positive(a['seconds'], 'add_shield() seconds');
      state().addShield(owner(this), nonNegative(a['amount'], 'add_shield() amount'), seconds,
        optionalString(a['key'], 'add_shield() key') ?? 'shield');
      return null;
    },
    drain(this: Fields, ...args: unknown[]): null {
      const a = bind('drain', args, ['per_second'], ['key', 'kind', 'tick'], ['per_second', 'key']);
      const key = optionalString(a['key'], 'drain() key')!;
      state().drain(owner(this), nonNegative(a['per_second'], 'drain() per_second'), key,
        optionalTag(a['kind'], 'drain() kind'), a['tick'] === undefined ? 0.5 : positive(a['tick'], 'drain() tick'));
      return null;
    },
    heal(this: Fields, ...args: unknown[]): number {
      const a = bind('heal', args, ['amount'], [], ['amount']);
      return state().heal(owner(this), finite(a['amount'], 'heal() amount'));
    },
    kill(this: Fields, ...args: unknown[]): null {
      const a = bind('kill', args, [], ['source']);
      state().kill(owner(this), optionalEntity(state().kernel.handles, a['source'], 'kill() source'));
      return null;
    },
    revive(this: Fields, ...args: unknown[]): null {
      const a = bind('revive', args, [], ['health']);
      const health = a['health'] === undefined || a['health'] === null ? null : finite(a['health'], 'revive() health');
      state().revive(owner(this), health);
      return null;
    },
    protect(this: Fields, ...args: unknown[]): null {
      const a = bind('protect', args, ['seconds'], [], ['seconds']);
      state().protect(owner(this), nonNegative(a['seconds'], 'protect() seconds'));
      return null;
    },
  };
  // Readable while the entity is being destroyed (a `destroyed` handler).
  const settled = (fields: Fields): Fields => {
    const id = owner(fields);
    return state().kernel.world.isAlive(id) ? state().health(id) : fields;
  };
  return withEntity(state, methods, {
    invulnerable: (fields) => state().invulnerable(owner(fields)),
    staggered: (fields) => engaged().staggered(owner(fields)),
    dead: (fields) => (settled(fields)['current'] as number) <= 0,
    fraction: (fields) => {
      const f = settled(fields);
      return (f['current'] as number) / (f['max'] as number);
    },
  });
}

/** A `ContentRef[StatusEffectDef]` argument. */
function effectRef(value: unknown, where: string): StatusEffectRef {
  const ref = value as Partial<StatusEffectRef> | null;
  if (typeof value !== 'object' || ref === null || typeof ref.id !== 'string' || ref.kind !== STATUS_EFFECT) {
    fail('PP3902', `${where} must be a status effect (Content.status_effect.<id>), got ${describe(value)}`, {
      fix: 'Add content/status_effect/<id>.json and pass Content.status_effect.<id>.',
    });
  }
  return ref as StatusEffectRef;
}

function effectsMethods(state: State): object {
  return withEntity(state, {
    apply(this: Fields, ...args: unknown[]): null {
      const a = bind('apply', args, ['effect', 'seconds'], ['strength', 'source'], ['effect', 'seconds']);
      state().apply(owner(this), effectRef(a['effect'], 'apply() effect'), positive(a['seconds'], 'apply() seconds'),
        a['strength'] === undefined ? 1 : nonNegative(a['strength'], 'apply() strength'),
        optionalEntity(state().kernel.handles, a['source'], 'apply() source'));
      return null;
    },
    remove(this: Fields, ...args: unknown[]): null {
      const a = bind('remove', args, ['effect'], [], ['effect']);
      state().removeEffect(owner(this), effectRef(a['effect'], 'remove() effect').id);
      return null;
    },
    has(this: Fields, ...args: unknown[]): boolean {
      const a = bind('has', args, ['effect'], [], ['effect']);
      return state().hasEffect(owner(this), effectRef(a['effect'], 'has() effect').id);
    },
    strength(this: Fields, ...args: unknown[]): number {
      const a = bind('strength', args, ['effect'], [], ['effect']);
      return state().strength(owner(this), effectRef(a['effect'], 'strength() effect').id);
    },
  });
}

export function combatComponents(state: State, engaged: () => Engagement): ComponentDef[] {
  return [
    { id: HEALTH, schema: HEALTH_SCHEMA, methods: healthMethods(state, engaged) },
    { id: HEALTH_BAR, schema: HEALTH_BAR_SCHEMA, methods: withEntity(state, {}) },
    { id: SIDE, schema: SIDE_SCHEMA, methods: withEntity(state, {}) },
    { id: EFFECTS, schema: EFFECTS_SCHEMA, methods: effectsMethods(state) },
  ];
}
