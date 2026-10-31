import { fail } from './diagnostics.js';

/**
 * Generational entity ids. An id packs a slot index and the slot's generation; freeing a
 * slot bumps its generation, so a stale id to a destroyed entity can never be mistaken
 * for the new entity reusing that slot (PP3002 instead of a silent wrong read).
 */

export type EntityId = number & { readonly __brand: 'EntityId' };

const INDEX_BITS = 22;
const INDEX_SPACE = 2 ** INDEX_BITS;
const MAX_GENERATION = 2 ** 30;

export function indexOf(id: EntityId): number {
  return id % INDEX_SPACE;
}

export function generationOf(id: EntityId): number {
  return Math.floor(id / INDEX_SPACE);
}

function pack(index: number, generation: number): EntityId {
  return (generation * INDEX_SPACE + index) as EntityId;
}

/** An allocator's full state (snapshots): every slot's generation, and the free slots in reuse order. */
export interface EntityIdState {
  readonly generations: readonly number[];
  readonly free: readonly number[];
}

export class EntityIdAllocator {
  readonly #generations: number[] = [];
  readonly #alive: boolean[] = [];
  readonly #free: number[] = [];
  #count = 0;

  get count(): number {
    return this.#count;
  }

  allocate(): EntityId {
    const index = this.#free.pop() ?? this.#generations.length;
    if (index >= INDEX_SPACE) fail('PP5001', `More than ${INDEX_SPACE} live entities`);
    if (index === this.#generations.length) this.#generations.push(0);
    this.#alive[index] = true;
    this.#count++;
    return pack(index, this.#generations[index]!);
  }

  isAlive(id: EntityId): boolean {
    const index = indexOf(id);
    return this.#alive[index] === true && this.#generations[index] === generationOf(id);
  }

  /** Its state, so a restored allocator hands out exactly the ids this one would next. */
  save(): EntityIdState {
    return { generations: [...this.#generations], free: [...this.#free] };
  }

  /** An allocator in a saved state: slots not in `free` are live. */
  static restore(state: EntityIdState): EntityIdAllocator {
    const ids = new EntityIdAllocator();
    const free = new Set(state.free);
    if (free.size !== state.free.length || state.free.some((i) => !(i >= 0 && i < state.generations.length))) {
      fail('PP9002', 'A saved entity id state has an invalid free list');
    }
    ids.#generations.push(...state.generations);
    ids.#free.push(...state.free);
    for (let i = 0; i < state.generations.length; i++) ids.#alive[i] = !free.has(i);
    ids.#count = state.generations.length - free.size;
    return ids;
  }

  release(id: EntityId): void {
    if (!this.isAlive(id)) fail('PP3002', 'Entity was already destroyed', {
      fix: 'Check `entity.alive` before using a stored entity.',
    });
    const index = indexOf(id);
    this.#alive[index] = false;
    this.#generations[index] = (this.#generations[index]! + 1) % MAX_GENERATION;
    this.#free.push(index);
    this.#count--;
  }
}
