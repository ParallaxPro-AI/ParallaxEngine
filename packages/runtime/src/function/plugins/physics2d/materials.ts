/**
 * Surface materials. A game declares them once (`physics2d(materials=Materials)`); a
 * Collider naming one (`"material": "ice"`) takes its friction and bounce from it instead
 * of its own `friction` / `bounce` fields. Colliders with a material also raise `impact`
 * events: when a contact starts with the surfaces closing at `impact_speed` m/s or more,
 * each side with a material hears an `impact` carrying its material, the other's, the
 * closing speed and its material's `sound` — so footsteps, clangs and thuds come from data.
 */

import { closestMatch, fail } from '../../../core/index.js';
import type { EventDef, FieldSpec } from '../../kernel/index.js';

export interface MaterialSpec {
  readonly friction: number;
  readonly bounce: number;
  /** An audio asset reference, as the game's `sound=` gave it (its stored form). */
  readonly sound: string | null;
  /** m/s of closing speed from which a contact is an impact. */
  readonly impact_speed: number;
}

export const IMPACT: EventDef = { id: 'impact', target: 'entity' };

/** The Collider's `material` field: a declared material's name, or None. */
export const MATERIAL_FIELD: FieldSpec = { type: { kind: 'optional', of: { kind: 'string' } }, default: null };

export class MaterialTable {
  readonly #materials: ReadonlyMap<string, MaterialSpec>;

  constructor(materials: Readonly<Record<string, MaterialSpec>>) {
    const map = new Map<string, MaterialSpec>();
    for (const [name, spec] of Object.entries(materials)) {
      for (const [field, value] of [['friction', spec.friction], ['bounce', spec.bounce], ['impact_speed', spec.impact_speed]] as const) {
        if (!(Number.isFinite(value) && value >= 0)) {
          fail('PP3190', `Material "${name}" has ${field} ${value}; it must be a number of at least 0`);
        }
      }
      map.set(name, spec);
    }
    this.#materials = map;
  }

  get names(): readonly string[] {
    return [...this.#materials.keys()];
  }

  /** A declared material; an undeclared name is PP3191 with a suggestion. */
  get(name: string, where: string): MaterialSpec {
    const spec = this.#materials.get(name);
    if (spec !== undefined) return spec;
    const guess = closestMatch(name, this.#materials.keys());
    return fail('PP3191', `${where} names material "${name}", which is not declared`, {
      fix: guess !== undefined ? `Did you mean "${guess}"?`
        : `Declare it in the Materials class passed to the physics plugin (materials=...). Declared: ${this.names.join(', ') || '(none)'}.`,
    });
  }
}
