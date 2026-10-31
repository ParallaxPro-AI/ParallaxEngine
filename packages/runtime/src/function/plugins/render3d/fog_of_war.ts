/**
 * Fog of war over the ground (a camera's `fog_overlay`, the ai plugin's `fog_of_war`
 * service): each view with an overlay gets its team's cells in a square around where the
 * camera looks (`View3d.fogOfWar`), which the surface lays over the scene: clear where the
 * team sees now, dimmed by `explored` where it has seen, covered by `unexplored` elsewhere.
 * The square is snapped to whole blocks of cells and re-read only when the service's
 * version or the square changes, so a still camera costs nothing.
 */

import type { FogOfWar3d, View3d } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import type { Kernel } from '../../kernel/index.js';
import { FOG_OF_WAR_SERVICE } from '../../services/index.js';
import { nameOf, rgba } from './draw.js';

export const FOG_OVERLAY = 'fog_overlay';

/** Most meters from the camera's ground point to the square's edge. */
export const FOG_REACH = 256;

/** The square of the ground a view's fog covers: centered where the camera looks at the ground, snapped to 16-cell blocks. */
export function fogSquare(view: View3d, cell: number): { minX: number; minZ: number; maxX: number; maxZ: number } {
  const [px, py, pz] = view.position;
  const [fx, fy, fz] = view.forward;
  // Where the view's center ray meets y = 0 (when it looks down), not too far out.
  const t = fy < -0.05 ? Math.min(-py / fy, FOG_REACH) : 0;
  const cx = px + fx * t;
  const cz = pz + fz * t;
  const half = Math.min(FOG_REACH, Math.max(32, view.far));
  const block = cell * 16;
  const snap = (v: number, up: boolean): number => (up ? Math.ceil(v / block) : Math.floor(v / block)) * block;
  return { minX: snap(cx - half, false), minZ: snap(cz - half, false), maxX: snap(cx + half, true), maxZ: snap(cz + half, true) };
}

export class FogOverlays {
  /** Last field per camera: reused while its key holds. */
  readonly #last = new Map<EntityId, FogOfWar3d>();

  /** The views with their fog (only views whose camera has a fog_overlay, in a game with fog of war). */
  apply(kernel: Kernel, views: readonly View3d[]): View3d[] {
    const service = kernel.tryService(FOG_OF_WAR_SERVICE);
    return views.map((view) => {
      const record = kernel.world.get(view.camera as EntityId);
      const overlay = record?.components.get(FOG_OVERLAY);
      if (record === undefined || overlay === undefined || service === undefined) return view;
      const where = `${nameOf(record)} fog_overlay`;
      const team = overlay['team'] as string;
      const square = fogSquare(view, service.cell);
      const unexplored = rgba(overlay['unexplored'], `${where}.unexplored`);
      const explored = rgba(overlay['explored'], `${where}.explored`);
      const key = `${service.version}|${team}|${square.minX},${square.minZ},${square.maxX},${square.maxZ}`;
      let fog = this.#last.get(view.camera as EntityId);
      if (fog === undefined || fog.key !== key) {
        const field = service.field(team, square.minX, square.minZ, square.maxX, square.maxZ);
        fog = { key, cell: field.cell, minX: field.minX, minZ: field.minZ, cols: field.cols, rows: field.rows, cells: field.cells, unexplored, explored };
        this.#last.set(view.camera as EntityId, fog);
      } else if (fog.unexplored.join() !== unexplored.join() || fog.explored.join() !== explored.join()) {
        fog = { ...fog, unexplored, explored };
        this.#last.set(view.camera as EntityId, fog);
      }
      return { ...view, fogOfWar: fog };
    });
  }
}
