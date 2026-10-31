/**
 * Content registries at runtime: `ctx.content(StageDef)` is a `ContentList` of
 * `ContentRef`s in registry order; `ref.data` is the typed, read-only entry. One ref
 * object exists per entry, so refs compare by identity as well as by `==`.
 */

import { closestMatch, fail } from '../core/index.js';
import { hashString, truthy } from './py.js';
import { isContentClass, rt } from './types.js';
import type { ContentClass } from './types.js';

/** How a ref finds its registry (the running game's content lists). */
export interface ContentSource {
  list(kind: ContentClass): ContentList<unknown>;
}

export class ContentRef<T> {
  /** `rt.generic(ContentRef, T)` names a content reference (see types.ts). */
  static readonly __generic__ = 'content_ref';

  /** `ContentRef[PlaceDef]` in an expression (a cast, `isinstance`-free annotations): the type marker. */
  static __getitem__(target: unknown): unknown {
    return rt.generic(ContentRef, target);
  }
  readonly id: string;
  readonly kind: string;
  #data: { readonly value: T } | undefined;
  #load: (() => T) | undefined;
  #source: ContentSource | undefined;

  /**
   * `load` decodes the entry on first `.data` (so entries may reference their own kind).
   * The project module's refs (`Content.stage.dawn`) are created unbound and bound by
   * each game that lists them, so a ref is the same object everywhere.
   */
  constructor(kind: string, id: string, load?: () => T, source?: ContentSource) {
    this.kind = kind;
    this.id = id;
    this.#load = load;
    this.#source = source;
  }

  /** Engine-facing: attach this ref to the running game's registry. */
  __bind__(load: () => T, source: ContentSource): void {
    this.#load = load;
    this.#source = source;
    this.#data = undefined;
  }

  get data(): T {
    if (this.#load === undefined) this.#unbound();
    this.#data ??= { value: this.#load() };
    return this.#data.value;
  }

  #unbound(): never {
    return fail('PP3032', `Content.${this.kind}.${this.id} was read before the game started`, {
      fix: 'Read content data inside hooks, handlers or tasks, not at module level.',
    });
  }

  /** View a built-in-kind entry as your subclass (same kind id). */
  as_kind<R>(kind: unknown): ContentRef<R> {
    if (!isContentClass(kind)) fail('PP4111', 'as_kind() needs a @content class');
    if (kind.__content_kind__ !== this.kind) {
      fail('PP3031', `as_kind(${kind.name}): this entry is "${this.kind}" content, not "${kind.__content_kind__}"`);
    }
    if (this.#source === undefined) this.#unbound();
    return this.#source.list(kind).get(this.id) as ContentRef<R>;
  }

  __eq__(o: unknown): boolean { return o instanceof ContentRef && o.kind === this.kind && o.id === this.id; }
  __hash__(): number { return hashString(`content:${this.kind}:${this.id}`); }
  toJSON(): string { return this.id; }
  toString(): string { return `ContentRef(${this.kind}.${this.id})`; }
}

export class ContentList<T> {
  readonly kind: string;
  readonly #refs: readonly ContentRef<T>[];
  readonly #byId: ReadonlyMap<string, ContentRef<T>>;

  constructor(kind: string, refs: readonly ContentRef<T>[]) {
    this.kind = kind;
    this.#refs = refs;
    this.#byId = new Map(refs.map((ref) => [ref.id, ref]));
  }

  [Symbol.iterator](): Iterator<ContentRef<T>> { return this.#refs[Symbol.iterator](); }
  __iter__(): Iterator<ContentRef<T>> { return this[Symbol.iterator](); }
  __len__(): number { return this.#refs.length; }

  __getitem__(index: number): ContentRef<T> {
    const i = index < 0 ? this.#refs.length + index : index;
    const ref = this.#refs[i];
    if (ref === undefined || !Number.isInteger(index)) {
      fail('PP3031', `${this.kind} content has ${this.#refs.length} entries; index ${index} is out of range`);
    }
    return ref;
  }

  get(id: string): ContentRef<T> {
    const ref = this.#byId.get(id);
    if (ref === undefined) {
      const guess = closestMatch(id, this.#byId.keys());
      fail('PP2050', `No ${this.kind} content "${id}"`, {
        fix: guess !== undefined ? `Did you mean "${guess}"?` : `Known: ${[...this.#byId.keys()].join(', ') || '(none)'}.`,
      });
    }
    return ref;
  }

  where(predicate: (data: T) => unknown): ContentRef<T>[] {
    return this.#refs.filter((ref) => truthy(predicate(ref.data)));
  }

  first(predicate?: ((data: T) => unknown) | null): ContentRef<T> | null {
    return this.#refs.find((ref) => predicate === undefined || predicate === null || truthy(predicate(ref.data))) ?? null;
  }

  index(ref: ContentRef<T>): number {
    const i = this.#refs.findIndex((r) => r.__eq__(ref));
    if (i < 0) fail('PP2050', `${String(ref)} is not in the ${this.kind} registry`);
    return i;
  }

  next(ref: ContentRef<T>): ContentRef<T> | null {
    return this.#refs[this.index(ref) + 1] ?? null;
  }
}
