/**
 * Garments and the wardrobe (sdk/parallax/characters.pyi `Garment`, `Wardrobe`).
 *
 * A Garment is a skinned model worn on its parent's skeleton: the models plugin poses an
 * entity with a `garment` component from its parent Model's posed bones (by bone name,
 * models/garments.ts), so clothing, hair and armor bend with every animation of the body.
 *
 * A Wardrobe on the body is its outfit as data — slot → garment prefab, with optional
 * tints — and the garments follow from it: every frame (the kernel's 'ui' hook) and at
 * once from its methods, each slot's prefab is spawned as a child (its Garment's `slot`
 * set) and anything else the wardrobe wore is taken off. The body's Model parts the worn
 * garments `hides` (skin under a jacket) are hidden while they are worn and shown again
 * after, and kept in `hidden`. Being data, an outfit saves, replicates, replays and
 * reloads with the entity; assigning `outfit` (another character's) dresses at once.
 */

import { Color, fail } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import { resolvePrefab } from '../../../resource/index.js';
import { componentEntity, t } from '../../kernel/index.js';
import type { ComponentDef, EntityRecord, Fields, Kernel, Schema } from '../../kernel/index.js';
import { describe, splitKeywords } from './args.js';

export const GARMENT = 'garment';
export const WARDROBE = 'wardrobe';
const MODEL = 'model';

export const GARMENT_SCHEMA: Schema = {
  slot: t.string({ default: '' }),
  hides: t.list({ kind: 'string' }, { default: [] }),
};

export const WARDROBE_SCHEMA: Schema = {
  outfit: { type: { kind: 'dict', of: { kind: 'ref', to: 'prefab' } }, default: {} },
  tints: { type: { kind: 'dict', of: { kind: 'color' } }, default: {} },
  /** The body's Model parts hidden by what is worn (kept by the engine). */
  hidden: t.list({ kind: 'string' }, { default: [] }),
};

function stored(value: unknown, where: string): string {
  if (typeof value === 'string' && value !== '') return value;
  const toJSON = typeof value === 'object' && value !== null ? (value as { toJSON?: unknown }).toJSON : undefined;
  if (typeof toJSON === 'function') {
    const form = (toJSON as () => unknown).call(value);
    if (typeof form === 'string') return form;
  }
  return fail('PP3172', `${where} must be a prefab, got ${describe(value)}`, { fix: 'Pass a prefab reference: Prefabs.leather_jacket.' });
}

function nameOf(record: EntityRecord): string {
  return `"${record.placedId ?? record.prefab ?? record.id}"`;
}

export class Wardrobes {
  readonly #kernel: Kernel;

  constructor(kernel: Kernel) {
    this.#kernel = kernel;
  }

  get kernel(): Kernel {
    return this.#kernel;
  }

  /** The garments the wardrobe of `body` wears now, by slot. */
  worn(body: EntityRecord): Map<string, EntityRecord> {
    const out = new Map<string, EntityRecord>();
    for (const child of body.children) {
      const record = this.#kernel.world.get(child);
      const garment = record?.components.get(GARMENT);
      if (record === undefined || garment === undefined) continue;
      out.set(garment['slot'] as string, record);
    }
    return out;
  }

  /** The slot a garment prefab names (its Garment's `slot`), or undefined. */
  slotOf(prefab: string): string | undefined {
    const slot = resolvePrefab(this.#kernel.project, prefab).components[GARMENT]?.['slot'];
    return typeof slot === 'string' && slot !== '' ? slot : undefined;
  }

  /** Make the body's children and hidden parts follow its wardrobe's data. */
  reconcile(body: EntityRecord, fields: Fields): void {
    const kernel = this.#kernel;
    const outfit = fields['outfit'] as Readonly<Record<string, string>>;
    const tints = fields['tints'] as Readonly<Record<string, Color>>;
    const worn = this.worn(body);
    for (const [slot, garment] of worn) {
      if (outfit[slot] !== garment.prefab) {
        kernel.destroy(garment.id);
        worn.delete(slot);
      }
    }
    for (const [slot, prefab] of Object.entries(outfit)) {
      if (!body.components.has(MODEL)) {
        fail('PP3172', `The wardrobe of ${nameOf(body)} has no Model to dress`, { fix: 'Garments are worn on a skinned Model: give the body a model component.' });
      }
      let garment = worn.get(slot);
      if (garment === undefined) {
        garment = kernel.spawn(prefab, {}, { parent: body.id, components: { [GARMENT]: { slot } } });
        if (!garment.components.has(MODEL)) {
          kernel.destroy(garment.id);
          fail('PP3172', `The garment prefab "${prefab}" (slot "${slot}") has no Model`, { fix: 'A garment is a skinned model: give its prefab a model component.' });
        }
        worn.set(slot, garment);
      }
      const tint = tints[slot];
      const model = garment.components.get(MODEL)!;
      if (tint !== undefined && !(model['tint'] as Color).__eq__(tint)) model['tint'] = tint;
    }
    // The body's parts under what is worn.
    const hide = new Set<string>();
    for (const garment of worn.values()) for (const part of garment.components.get(GARMENT)!['hides'] as readonly string[]) hide.add(part);
    const before = fields['hidden'] as readonly string[];
    const next = [...hide].sort();
    if (before.length === next.length && before.every((p, i) => p === next[i])) return;
    const model = body.components.get(MODEL)!;
    const parts = { ...(model['parts'] as Record<string, boolean>) };
    for (const part of before) if (!hide.has(part)) delete parts[part];
    for (const part of next) parts[part] = false;
    model['parts'] = parts;
    fields['hidden'] = next;
  }

  frame(): void {
    for (const [id, fields] of this.#kernel.world.query([WARDROBE])) this.reconcile(this.#kernel.world.require(id), fields!);
  }
}

function methods(current: () => Wardrobes): object {
  const body = (fields: unknown): EntityRecord => current().kernel.world.require(componentEntity(fields as Fields));
  const wrap = (id: EntityId | undefined): unknown => (id === undefined ? null : current().kernel.handles.wrap(id));
  const slotArg = (value: unknown, where: string): string => {
    if (typeof value !== 'string' || value === '') fail('PP3172', `${where} must be a slot name, got ${describe(value)}`);
    return value;
  };
  return {
    wear(this: Fields, ...args: unknown[]): unknown {
      const { positional: p, keywords: k } = splitKeywords(args, 'wear', ['garment', 'slot', 'tint']);
      const prefab = stored(p[0] ?? k['garment'], 'wear() garment');
      const w = current();
      const given = k['slot'];
      const slot = given === undefined || given === null ? w.slotOf(prefab) : slotArg(given, 'wear(slot=)');
      if (slot === undefined) {
        fail('PP3172', `wear(): the prefab "${prefab}" names no slot`, { fix: 'Pass slot="torso", or give its garment component a "slot".' });
      }
      this['outfit'] = { ...(this['outfit'] as Record<string, string>), [slot]: prefab };
      const tint = k['tint'];
      if (tint !== undefined && tint !== null) {
        if (!(tint instanceof Color)) fail('PP3172', `wear(tint=) must be a Color, got ${describe(tint)}`);
        this['tints'] = { ...(this['tints'] as Record<string, Color>), [slot]: tint };
      }
      const record = body(this);
      w.reconcile(record, this);
      return wrap(w.worn(record).get(slot)?.id);
    },
    take_off(this: Fields, ...args: unknown[]): boolean {
      const { positional: p, keywords: k } = splitKeywords(args, 'take_off', ['slot']);
      const slot = slotArg(p[0] ?? k['slot'], 'take_off() slot');
      const outfit = { ...(this['outfit'] as Record<string, string>) };
      if (!(slot in outfit)) return false;
      delete outfit[slot];
      const tints = { ...(this['tints'] as Record<string, Color>) };
      delete tints[slot];
      this['outfit'] = outfit;
      this['tints'] = tints;
      current().reconcile(body(this), this);
      return true;
    },
    worn(this: Fields, ...args: unknown[]): unknown {
      const { positional: p, keywords: k } = splitKeywords(args, 'worn', ['slot']);
      const slot = slotArg(p[0] ?? k['slot'], 'worn() slot');
      const w = current();
      const record = body(this);
      w.reconcile(record, this);
      return wrap(w.worn(record).get(slot)?.id);
    },
    slots(this: Fields): string[] {
      return Object.keys(this['outfit'] as Record<string, string>).sort();
    },
  };
}

export function wardrobeComponents(current: () => Wardrobes): ComponentDef[] {
  return [
    { id: GARMENT, schema: GARMENT_SCHEMA },
    { id: WARDROBE, schema: WARDROBE_SCHEMA, methods: methods(current) },
  ];
}
