/**
 * Collision layers. A game declares its layer names once (`physics2d(layers=Layers)`);
 * `default` always exists and comes first. Each collider is in one layer and collides
 * with the layers it lists — a pair touches only when each side lists the other's layer.
 * Rapier packs this into 16-bit membership/filter masks, so at most 16 layers exist.
 */

import { closestMatch, fail } from '../../../core/index.js';

export const DEFAULT_LAYER = 'default';
const MAX_LAYERS = 16;

export class LayerTable {
  /** In declaration order, `default` first. */
  readonly names: readonly string[];
  readonly #bits = new Map<string, number>();

  constructor(declared: readonly string[]) {
    const names = [DEFAULT_LAYER, ...declared.filter((n) => n !== DEFAULT_LAYER)];
    const seen = new Set<string>();
    for (const name of names) {
      if (seen.has(name)) fail('PP3105', `Collision layer "${name}" is declared twice`);
      seen.add(name);
    }
    if (names.length > MAX_LAYERS) {
      fail('PP3106', `${names.length} collision layers are declared (with "default"); physics2d supports ${MAX_LAYERS}`, {
        fix: 'Merge layers that always collide with the same things.',
      });
    }
    this.names = names;
    names.forEach((name, i) => this.#bits.set(name, 1 << i));
  }

  /** The bit of one layer; an undeclared name is PP3104 with a suggestion. */
  bit(name: string, where: string): number {
    const bit = this.#bits.get(name);
    if (bit !== undefined) return bit;
    const guess = closestMatch(name, this.names);
    return fail('PP3104', `${where} names collision layer "${name}", which is not declared`, {
      fix: guess !== undefined
        ? `Did you mean "${guess}"?`
        : `Declare it in the Layers class passed to physics2d(layers=...). Declared: ${this.names.join(', ')}.`,
    });
  }

  mask(names: readonly string[], where: string): number {
    let mask = 0;
    for (const name of names) mask |= this.bit(name, where);
    return mask;
  }

  /** Rapier interaction groups: membership in the high 16 bits, filter in the low 16. */
  groups(layer: string, collidesWith: readonly string[], where: string): number {
    return ((this.bit(layer, `${where}.layer`) << 16) | this.mask(collidesWith, `${where}.collides_with`)) >>> 0;
  }
}
