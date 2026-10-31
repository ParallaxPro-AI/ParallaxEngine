/**
 * What a frame plan draws, counted from the plan itself (API-neutral, so WebGPU and WebGL2
 * report the same numbers): one draw per mesh item, terrain tile, billboard batch, impostor
 * batch and outline, by pass. Triangles are index count / 3 × instances (billboards and
 * impostors: two per quad).
 *
 * Not counted: fullscreen passes (sky, water, post-processing, the final blit) and lines.
 * World text is drawn as billboards and counted there. A mesh is counted once per pass that
 * lists it (a shadow caster again in every shadow tile it falls in).
 */

import type { FramePlan, MeshItem, TerrainItem } from './plan.js';

export type DrawPass = 'geometry' | 'shadow' | 'billboards' | 'impostors' | 'outlines';

export interface DrawCounts {
  readonly drawCalls: number;
  readonly triangles: number;
  /** Mesh instances drawn in the geometry pass (one batch of 40 trees: 40). */
  readonly instances: number;
  readonly drawCallsByPass: Readonly<Record<DrawPass, number>>;
  readonly trianglesByPass: Readonly<Record<DrawPass, number>>;
}

function zero(): Record<DrawPass, number> {
  return { geometry: 0, shadow: 0, billboards: 0, impostors: 0, outlines: 0 };
}

/** Count a plan's draws (cheap: one pass over its item lists, never over instances). */
export function countPlan(plan: FramePlan): DrawCounts {
  const draws = zero();
  const tris = zero();
  let instances = 0;
  const meshes = (pass: DrawPass, items: readonly MeshItem[]): void => {
    for (const item of items) {
      draws[pass]++;
      tris[pass] += Math.floor(item.geometry.indices.length / 3) * item.instanceCount;
      if (pass === 'geometry') instances += item.instanceCount;
    }
  };
  const terrain = (pass: DrawPass, item: TerrainItem | null): void => {
    if (item === null) return;
    for (const tile of item.tiles) {
      draws[pass]++;
      tris[pass] += Math.floor(tile.geometry.indices.length / 3);
    }
  };
  for (const view of plan.views) {
    meshes('geometry', view.opaque);
    meshes('geometry', view.transparent);
    meshes('geometry', view.viewmodel);
    meshes('geometry', view.viewmodelTransparent);
    terrain('geometry', view.terrain);
    for (const b of [...view.billboards, ...view.overlayBillboards]) {
      draws.billboards++;
      tris.billboards += 2 * b.count;
    }
    for (const o of view.outlines) {
      draws.outlines++;
      tris.outlines += Math.floor(o.item.geometry.indices.length / 3) * o.item.instanceCount;
    }
  }
  for (const tile of plan.shadowTiles) {
    meshes('shadow', tile.casters);
    terrain('shadow', tile.terrain);
  }
  for (const items of plan.impostors?.views ?? []) {
    for (const item of items) {
      draws.impostors++;
      tris.impostors += 2 * item.count;
    }
  }
  const sum = (r: Record<DrawPass, number>): number => r.geometry + r.shadow + r.billboards + r.impostors + r.outlines;
  return { drawCalls: sum(draws), triangles: sum(tris), instances, drawCallsByPass: draws, trianglesByPass: tris };
}
