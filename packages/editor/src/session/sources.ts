/**
 * Which document each live entity came from. A scene's entities are created from its
 * placements in file order (every placement's prefab, then its children, depth first),
 * so a world loaded with logic off lines up with the scene document exactly:
 *
 *   placement  a root entity: a scene (or region) file's placement, its JSON pointer, and
 *              for gridded placements the cell
 *   child      an entity from a prefab's "children": the file that declares the child
 *              (the parent prefab, or a base it extends) and its pointer, under its root
 *
 * Every source has a `key` that stays the same when the world is rebuilt from the
 * documents (entity ids don't), which is how the editor keeps its selection across edits.
 * An entity the scene didn't place (spawned in play, an editor helper) has no source.
 */

import { diagnostic } from '@parallax/runtime/core';
import type { Diagnostic, EntityId } from '@parallax/runtime/core';
import type { EntityRecord, World } from '@parallax/runtime/kernel';
import { resolvePrefab } from '@parallax/runtime/resource';
import type { InstanceGrid, Origin, Placement, PrefabChild, Project, SceneDoc } from '@parallax/runtime/resource';

export interface PlacementSource {
  readonly kind: 'placement';
  readonly key: string;
  readonly scene: string;
  /** The file the placement is in (scene.json, or a region's entity file). */
  readonly path: string;
  readonly pointer: string;
  readonly prefab: string;
  readonly placedId?: string;
  /** The cell of a gridded placement (row-major), which can't be edited on its own. */
  readonly cell?: number;
}

export interface ChildSource {
  readonly kind: 'child';
  readonly key: string;
  /** The root entity (a placement) this child belongs to. */
  readonly root: EntityId;
  /** The prefab whose resolved "children" holds this child. */
  readonly owner: string;
  /** The file that declares the child, and its pointer there. */
  readonly path: string;
  readonly pointer: string;
  readonly name?: string;
  /** The child's own prefab; undefined for an inline child. */
  readonly prefab?: string;
  readonly cell?: number;
}

export type EntitySource = PlacementSource | ChildSource;

export interface SourceMap {
  readonly sources: ReadonlyMap<EntityId, EntitySource>;
  readonly byKey: ReadonlyMap<string, EntityId>;
  /** Entities that should have matched a document and didn't (a world built from other data). */
  readonly problems: readonly Diagnostic[];
}

function cells(grid: InstanceGrid | undefined): number {
  return grid === undefined ? 1 : grid.cols * grid.rows;
}

function keyOf(origin: Origin, cell: number | undefined): string {
  return `${origin.path}#${origin.pointer}${cell === undefined ? '' : `@${cell}`}`;
}

/** Map a world (loaded from `scene` with logic off) to its documents. `ignore`: editor-owned entities. */
export function mapSources(world: World, project: Project, scene: SceneDoc, ignore: (id: EntityId) => boolean = () => false): SourceMap {
  const sources = new Map<EntityId, EntitySource>();
  const byKey = new Map<string, EntityId>();
  const problems: Diagnostic[] = [];
  const add = (id: EntityId, source: EntitySource): void => {
    sources.set(id, source);
    byKey.set(source.key, id);
  };

  const expected: { placement: Placement; cell: number | undefined }[] = [];
  for (const placement of scene.entities) {
    const n = cells(placement.grid);
    for (let c = 0; c < n; c++) expected.push({ placement, cell: placement.grid === undefined ? undefined : c });
  }
  let next = 0;
  const roots = [...world.live()].filter((r) => r.parent === null && !ignore(r.id));
  for (const record of roots) {
    // Streaming may have left placements unloaded: skip to the next one this entity can be.
    let at = next;
    while (at < expected.length) {
      const { placement } = expected[at]!;
      if (placement.prefab === record.prefab && (placement.id ?? undefined) === record.placedId) break;
      at++;
    }
    if (at === expected.length) continue;
    next = at + 1;
    const { placement, cell } = expected[at]!;
    const source: PlacementSource = {
      kind: 'placement', key: keyOf(placement.origin, cell), scene: scene.id, path: placement.origin.path, pointer: placement.origin.pointer,
      prefab: placement.prefab, ...(placement.id !== undefined && { placedId: placement.id }), ...(cell !== undefined && { cell }),
    };
    add(record.id, source);
    mapChildren(world, project, record, placement.prefab, record.id, source.key, add, problems);
  }
  return { sources, byKey, problems };
}

function mapChildren(
  world: World, project: Project, record: EntityRecord, prefab: string, root: EntityId, rootKey: string,
  add: (id: EntityId, source: EntitySource) => void, problems: Diagnostic[],
): void {
  if (!project.prefabs.has(prefab)) return;
  const expected: { child: PrefabChild; cell: number | undefined }[] = [];
  for (const child of resolvePrefab(project, prefab).children) {
    const n = cells(child.grid);
    for (let c = 0; c < n; c++) expected.push({ child, cell: child.grid === undefined ? undefined : c });
  }
  const children = record.children.map((id) => world.get(id)).filter((r): r is EntityRecord => r !== undefined);
  // Children re-parented or spawned at runtime come after the prefab's own; match by order and name.
  for (let i = 0; i < Math.min(expected.length, children.length); i++) {
    const { child, cell } = expected[i]!;
    const entity = children[i]!;
    if ((child.name ?? undefined) !== entity.childName || (child.prefab ?? undefined) !== entity.prefab) {
      problems.push(diagnostic('PP9625', `Entity ${entity.id} doesn't line up with child ${i} of prefab "${prefab}"`, {
        severity: 'warning', path: child.origin.path, pointer: child.origin.pointer,
        fix: 'Rebuild the world from the documents (the session does on refresh); it was built from other data.',
      }));
      return;
    }
    const key = `${rootKey}>${keyOf(child.origin, cell)}`;
    add(entity.id, {
      kind: 'child', key, root, owner: prefab, path: child.origin.path, pointer: child.origin.pointer,
      ...(child.name !== undefined && { name: child.name }), ...(child.prefab !== undefined && { prefab: child.prefab }),
      ...(cell !== undefined && { cell }),
    });
    if (child.prefab !== undefined) mapChildren(world, project, entity, child.prefab, root, key, add, problems);
  }
}
