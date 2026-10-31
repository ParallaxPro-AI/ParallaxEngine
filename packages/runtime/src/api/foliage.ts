/**
 * `parallax.foliage` (sdk/parallax/foliage.pyi): `FoliageApi`, the type of `ctx.foliage`,
 * `FoliageInstance`, and the `foliage()` plugin factory (`parallax.plugins.foliage`). The
 * scatter lives in the foliage plugin and its `foliage` service.
 */

import { closestMatch, fail, Vec3 } from '../core/index.js';
import type { Kernel, KernelPlugin } from '../function/kernel/index.js';
import { foliage as foliagePlugin } from '../function/plugins/foliage/index.js';
import { FOLIAGE_SERVICE } from '../function/services/index.js';
import { bindArgs, splitArgs } from './kwargs.js';

function describe(value: unknown): string {
  return value === null || value === undefined ? 'None' : String(value);
}

/** `layer` is a collision layer everywhere; foliage entries are named by `id`. */
function rejectLayerKeyword(name: string, args: readonly unknown[]): void {
  if ('layer' in splitArgs(args).keywords) {
    fail('PP3030', `foliage.${name}() takes "id", not "layer" ("layer" means a collision layer)`, { fix: `Write foliage.${name}(..., id="pines").` });
  }
}

/** One scattered instance (a tree, a rock), as `ctx.foliage.near` finds it. */
export class FoliageInstance {
  /** The foliage entry's id. */
  readonly id: string;
  readonly index: number;
  readonly position: Vec3;
  readonly scale: number;

  constructor(id: string, index: number, position: Vec3, scale: number) {
    this.id = id;
    this.index = index;
    this.position = position;
    this.scale = scale;
  }

  /** Old spelling: fails naming `id`. */
  get layer(): never {
    return fail('PP3232', 'FoliageInstance has no "layer"; its foliage entry is "id" ("layer" means a collision layer)', { fix: 'Read instance.id.' });
  }

  __eq__(other: unknown): boolean {
    return other instanceof FoliageInstance && other.id === this.id && other.index === this.index;
  }

  __repr__(): string {
    return `FoliageInstance(${JSON.stringify(this.id)}, ${this.index})`;
  }
}

/** `ctx.foliage`: the scene's scattered vegetation. */
export class FoliageApi {
  readonly #kernel: Kernel;

  constructor(kernel: Kernel) {
    this.#kernel = kernel;
  }

  near(...args: unknown[]): FoliageInstance[] {
    rejectLayerKeyword('near', args);
    const a = bindArgs('near', args, { positional: ['point', 'radius'], keyword: ['id'], required: ['point', 'radius'] }).args;
    const point = a['point'];
    if (!(point instanceof Vec3)) fail('PP3232', `foliage.near() point must be a Vec3, got ${describe(point)}`);
    const radius = a['radius'];
    if (typeof radius !== 'number') fail('PP3232', `foliage.near() radius must be a number, got ${describe(radius)}`);
    const id = a['id'];
    if (id !== undefined && id !== null && typeof id !== 'string') fail('PP3232', `foliage.near() id must be a foliage entry id, got ${describe(id)}`);
    return this.#kernel.service(FOLIAGE_SERVICE).near(point.x, point.z, radius, (id as string | null | undefined) ?? undefined)
      .map((h) => new FoliageInstance(h.layer, h.index, new Vec3(h.x, h.y, h.z), h.scale));
  }

  remove(...args: unknown[]): void {
    const instance = bindArgs('remove', args, { positional: ['instance'], required: ['instance'] }).args['instance'];
    if (!(instance instanceof FoliageInstance)) fail('PP3232', `foliage.remove() takes a FoliageInstance from near(), got ${describe(instance)}`);
    this.#kernel.service(FOLIAGE_SERVICE).remove(instance.id, instance.index);
  }

  count(...args: unknown[]): number {
    rejectLayerKeyword('count', args);
    const id = bindArgs('count', args, { positional: ['id'], required: ['id'] }).args['id'];
    if (typeof id !== 'string') fail('PP3232', `foliage.count() id must be a foliage entry id, got ${describe(id)}`);
    const layers = this.#kernel.service(FOLIAGE_SERVICE).layers();
    const found = layers.find((l) => l.id === id);
    if (found === undefined) {
      const guess = closestMatch(id, layers.map((l) => l.id));
      return fail('PP3231', `There is no foliage entry "${id}" in this scene`, {
        fix: guess === undefined ? `Scatter entries: ${layers.map((l) => l.id).join(', ') || '(none)'}.` : `Did you mean "${guess}"?`,
      });
    }
    let n = 0;
    for (let k = 0; k < found.count; k++) n += found.alive[k]!;
    return n;
  }
}

/** `parallax.plugins.foliage()`. */
export function foliage(...args: unknown[]): KernelPlugin {
  bindArgs('foliage', args, {});
  return { ...foliagePlugin(), namespace: { name: 'foliage', create: (kernel) => new FoliageApi(kernel) } };
}
