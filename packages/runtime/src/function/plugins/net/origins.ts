/**
 * Where each entity came from, so server and client can agree on "the same entity"
 * without a shared id space. Both load the same scene file, so the i-th root it places is
 * the same entity on both; a prefab's children come in the same order wherever it is
 * spawned; anything else was spawned by the server and the client spawns its prefab.
 * Kept in step from the kernel's spawn batches (a batch is one scene load or one spawn).
 */

import type { EntityId } from '../../../core/index.js';
import type { EntityRecord, Kernel } from '../../kernel/index.js';

export type Origin =
  | { readonly kind: 'scene'; readonly index: number }
  | { readonly kind: 'child'; readonly parent: EntityId; readonly index: number }
  | { readonly kind: 'spawn' };

export class Origins {
  readonly #of = new Map<EntityId, Origin>();
  /** The current scene's placed roots, in placement order. */
  #sceneRoots: EntityId[] = [];
  /** Each entity's prefab children, in creation order. */
  readonly #children = new Map<EntityId, EntityId[]>();
  #sceneBatchNext = false;

  constructor(kernel: Kernel) {
    kernel.observeScenes({
      loading: () => {
        this.#of.clear();
        this.#children.clear();
        this.#sceneRoots = [];
        this.#sceneBatchNext = true;
      },
    });
    kernel.observeEntities({
      added: (batch) => this.#file(batch),
      removed: (records) => {
        for (const r of records) {
          this.#of.delete(r.id);
          this.#children.delete(r.id);
        }
      },
    });
  }

  #file(batch: readonly EntityRecord[]): void {
    const scene = this.#sceneBatchNext;
    this.#sceneBatchNext = false;
    const members = new Set(batch.map((r) => r.id));
    batch.forEach((record, i) => {
      const parent = record.parent;
      // A spawn batch's first record is its root even when spawned under a parent.
      if (parent !== null && members.has(parent) && !(i === 0 && !scene)) {
        const siblings = this.#children.get(parent) ?? [];
        this.#children.set(parent, siblings);
        this.#of.set(record.id, { kind: 'child', parent, index: siblings.length });
        siblings.push(record.id);
      } else if (scene) {
        this.#of.set(record.id, { kind: 'scene', index: this.#sceneRoots.length });
        this.#sceneRoots.push(record.id);
      } else {
        this.#of.set(record.id, { kind: 'spawn' });
      }
    });
  }

  of(id: EntityId): Origin | undefined {
    return this.#of.get(id);
  }

  sceneRoot(index: number): EntityId | undefined {
    return this.#sceneRoots[index];
  }

  get sceneRoots(): readonly EntityId[] {
    return this.#sceneRoots;
  }

  child(parent: EntityId, index: number): EntityId | undefined {
    return this.#children.get(parent)?.[index];
  }

  /** Placed by the scene file (a scene root, or a prefab child of one). */
  placed(id: EntityId): boolean {
    for (let origin = this.#of.get(id); origin !== undefined; origin = this.#of.get(origin.parent)) {
      if (origin.kind === 'scene') return true;
      if (origin.kind === 'spawn') return false;
    }
    return false;
  }

  /** Entries for a snapshot: every tracked entity's origin and the scene's roots. */
  save(): { readonly of: [EntityId, Origin][]; readonly roots: EntityId[]; readonly children: [EntityId, EntityId[]][] } {
    return { of: [...this.#of], roots: [...this.#sceneRoots], children: [...this.#children].map(([k, v]) => [k, [...v]]) };
  }

  load(saved: ReturnType<Origins['save']>, alive: (id: EntityId) => boolean): void {
    this.#of.clear();
    this.#children.clear();
    for (const [id, origin] of saved.of) if (alive(id)) this.#of.set(id, origin);
    for (const [id, kids] of saved.children) if (alive(id)) this.#children.set(id, kids);
    this.#sceneRoots = [...saved.roots];
  }
}
