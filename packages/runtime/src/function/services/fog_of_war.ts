/**
 * The `fog_of_war` service, provided by the ai plugin: each team's visibility grid on the
 * ground plane, for the renderer's fog overlay, the minimap, and `net(visible=...)`
 * filters. Gameplay state only; drawing it belongs to the renderer.
 *
 * The grid is square cells of `cell` meters over (x, z), unbounded: cells exist where some
 * team has looked. A cell is *visible* while a `Vision` of the team sees its center now and
 * *explored* once it ever has been. `version` increases whenever any cell changes.
 */

import type { EntityId } from '../../core/index.js';
import { serviceKey } from '../kernel/index.js';
import type { ServiceKey } from '../kernel/index.js';

/** A rectangle of a team's grid, row-major from (minX, minZ): bit 1 visible, bit 2 explored. */
export interface FogField {
  readonly cell: number;
  /** World position of the first cell's corner. */
  readonly minX: number;
  readonly minZ: number;
  readonly cols: number;
  readonly rows: number;
  readonly cells: Uint8Array;
}

export interface FogOfWarService {
  /** Cell edge (m). */
  readonly cell: number;
  readonly version: number;
  /** Teams (tag ids) with at least one Vision, sorted. */
  teams(): readonly string[];
  visible(team: string, x: number, z: number): boolean;
  explored(team: string, x: number, z: number): boolean;
  /** Whether a team sees the entity (its position's cell is visible). */
  sees(team: string, entity: EntityId): boolean;
  /** The cells of the rectangle (clamped to 4096×4096 cells). */
  field(team: string, minX: number, minZ: number, maxX: number, maxZ: number): FogField;
}

export const FOG_OF_WAR_SERVICE: ServiceKey<FogOfWarService> = serviceKey<FogOfWarService>(
  'fog_of_war', 'Add ai() to Game(plugins=[...]) and give units a Vision: fog of war is the ai plugin\'s.',
);
