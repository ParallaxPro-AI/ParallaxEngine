/**
 * Off-mesh links: authored connections the walkable layers don't make on their own — a gap
 * to jump, a ladder to climb, a door, a teleporter. Two sources:
 *
 *   - a `nav_link` component (sdk: NavLink) on any entity, so a prefab carries its own
 *     link (a ladder prefab, a door frame): `start` and `end` are local offsets from the
 *     entity, placed by its transform. `enabled` False removes the link (a locked door);
 *     moving or switching it is noticed each fixed step.
 *   - the scene's `"navmesh": {"links": [{"start": [x, y, z], "end": [x, y, z], ...}]}`,
 *     in world space;
 *   - generated scenery's (procgen meshes' `links`: a Structure's flights, kind "stairs",
 *     both ways), re-read with the meshes.
 *
 * Each end snaps to the nearest standable layer within `snapDistance` of the agent radius;
 * a link whose end has none (inside a wall) is skipped for that radius. Searches treat a
 * link as one edge of cost length + `cost`; agents traverse it by kind (agents.ts).
 * Automatic jump/drop links between ledges are made by the search itself (search.ts) from
 * each agent's `jump_height` and `drop_height`.
 */

import { Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import { t } from '../../kernel/index.js';
import type { EntityRecord, Schema } from '../../kernel/index.js';
import { ChangeLog } from './world.js';
import type { LinkSource, NavLinkData, Rect } from './world.js';

export const NAV_LINK = 'nav_link';
/**
 * Authored link kinds; the search adds "jump" and "drop" links of its own between ledges,
 * and generated scenery adds "stairs" (a Structure's flights, walked at the agent's speed).
 */
export const LINK_KINDS = ['jump', 'climb', 'door', 'teleport', 'custom'] as const;
export type LinkKind = (typeof LINK_KINDS)[number] | 'drop' | 'stairs';

export const NAV_LINK_SCHEMA: Schema = {
  start: t.vec3({ default: Vec3.ZERO }),
  end: t.vec3({ default: new Vec3(0, 0, 2) }),
  kind: t.enum(LINK_KINDS, { default: 'jump' }),
  bidirectional: t.bool({ default: true }),
  cost: t.number({ default: 0, min: 0 }),
  enabled: t.bool({ default: true }),
};

export const NAV_OBSTACLE_SCHEMA: Schema = {
  enabled: t.bool({ default: true }),
  move_threshold: t.number({ default: 0.1, min: 0 }),
};

function rectOf(link: NavLinkData): Rect {
  return {
    minX: Math.min(link.start.x, link.end.x), maxX: Math.max(link.start.x, link.end.x),
    minZ: Math.min(link.start.z, link.end.z), maxZ: Math.max(link.start.z, link.end.z),
  };
}

function same(a: NavLinkData | null, b: NavLinkData | null): boolean {
  if (a === null || b === null) return a === b;
  const close = (p: { x: number; y: number; z: number }, q: { x: number; y: number; z: number }): boolean =>
    Math.abs(p.x - q.x) + Math.abs(p.y - q.y) + Math.abs(p.z - q.z) < 1e-6;
  return a.kind === b.kind && a.bidirectional === b.bidirectional && a.cost === b.cost && close(a.start, b.start) && close(a.end, b.end);
}

/** The link a record's NavLink makes now, or null (none, or disabled). */
function linkOf(record: EntityRecord): NavLinkData | null {
  const f = record.components.get(NAV_LINK);
  if (f === undefined || f['enabled'] === false) return null;
  const start = record.transform.toWorld(f['start'] as Vec3);
  const end = record.transform.toWorld(f['end'] as Vec3);
  return {
    entity: record.id,
    kind: f['kind'] as string,
    start: { x: start.x, y: start.y, z: start.z },
    end: { x: end.x, y: end.y, z: end.z },
    bidirectional: f['bidirectional'] !== false,
    cost: f['cost'] as number,
  };
}

/** Every off-mesh link of the running scene, with a log of where links changed. */
export class Links implements LinkSource {
  readonly changes = new ChangeLog();
  #scene: readonly NavLinkData[] = [];
  #generated: readonly NavLinkData[] = [];
  /** NavLink entities in spawn order; null while disabled. */
  readonly #entities = new Map<EntityId, NavLinkData | null>();
  #list: NavLinkData[] | null = null;

  #changed(...links: Array<NavLinkData | null | undefined>): void {
    this.#list = null;
    let rect: Rect | null = null;
    for (const link of links) {
      if (link === null || link === undefined) continue;
      const r = rectOf(link);
      rect = rect === null ? r : { minX: Math.min(rect.minX, r.minX), maxX: Math.max(rect.maxX, r.maxX), minZ: Math.min(rect.minZ, r.minZ), maxZ: Math.max(rect.maxZ, r.maxZ) };
    }
    if (rect !== null) this.changes.push(rect);
  }

  clear(): void {
    this.#scene = [];
    this.#generated = [];
    this.#entities.clear();
    this.#list = null;
    this.changes.push(null);
  }

  /** The scene's "navmesh" links (world space). */
  setScene(links: readonly NavLinkData[]): void {
    const was = this.#scene;
    this.#scene = links;
    this.#changed(...was, ...links);
  }

  /** Generated scenery's links (world space); a change is logged only when they differ. */
  setGenerated(links: readonly NavLinkData[]): void {
    const was = this.#generated;
    if (was.length === links.length && was.every((l, i) => same(l, links[i]!) && l.entity === links[i]!.entity)) return;
    this.#generated = links;
    this.#changed(...was, ...links);
  }

  update(record: EntityRecord): void {
    if (!record.components.has(NAV_LINK)) {
      this.remove(record.id);
      return;
    }
    const was = this.#entities.get(record.id);
    const now = linkOf(record);
    if (was !== undefined && same(was, now)) return;
    this.#entities.set(record.id, now);
    this.#changed(was, now);
  }

  remove(id: EntityId): void {
    const was = this.#entities.get(id);
    if (was === undefined) return;
    this.#entities.delete(id);
    this.#changed(was);
  }

  /** Notice NavLinks that moved or were switched (`get` reads a live record). */
  poll(get: (id: EntityId) => EntityRecord | undefined): void {
    for (const id of [...this.#entities.keys()]) {
      const record = get(id);
      if (record === undefined) this.remove(id);
      else this.update(record);
    }
  }

  get tracking(): boolean {
    return this.#entities.size > 0;
  }

  list(): readonly NavLinkData[] {
    if (this.#list === null) {
      this.#list = [...this.#scene, ...this.#generated];
      for (const link of this.#entities.values()) if (link !== null) this.#list.push(link);
    }
    return this.#list;
  }
}
