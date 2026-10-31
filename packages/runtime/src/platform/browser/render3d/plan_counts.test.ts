/**
 * countPlan: draws and triangles of a frame plan by pass, from its item lists alone.
 */

import { describe, expect, it } from 'vitest';
import { countPlan } from './plan_counts.js';
import type { FramePlan, MeshItem, TerrainItem, ViewPlan } from './plan.js';

/** A mesh item drawing `triangles` triangles per instance. */
function item(triangles: number, instanceCount = 1): MeshItem {
  return { geometry: { indices: new Uint16Array(triangles * 3) }, instanceCount } as unknown as MeshItem;
}

function terrain(...tileTriangles: number[]): TerrainItem {
  return { tiles: tileTriangles.map((t) => ({ geometry: { indices: new Uint32Array(t * 3) } })) } as unknown as TerrainItem;
}

function view(parts: Partial<ViewPlan>): ViewPlan {
  return {
    opaque: [], transparent: [], viewmodel: [], viewmodelTransparent: [], terrain: null, billboards: [], overlayBillboards: [], outlines: [],
    ...parts,
  } as unknown as ViewPlan;
}

function plan(parts: Partial<FramePlan>): FramePlan {
  return { views: [], shadowTiles: [], impostors: null, ...parts } as unknown as FramePlan;
}

describe('countPlan', () => {
  it('is all zeros for an empty plan', () => {
    const counts = countPlan(plan({}));
    expect(counts.drawCalls).toBe(0);
    expect(counts.triangles).toBe(0);
    expect(counts.instances).toBe(0);
  });

  it('counts one draw per item and index/3 × instances triangles, by pass', () => {
    const counts = countPlan(plan({
      views: [
        view({
          opaque: [item(12, 40), item(100)], transparent: [item(2)], viewmodel: [item(50)], terrain: terrain(200, 200),
          billboards: [{ texture: null, first: 0, count: 5 }], overlayBillboards: [{ texture: null, first: 5, count: 1 }],
          outlines: [{ item: item(100), slot: 0, throughWalls: false }],
        }),
        view({ opaque: [item(12, 3)] }),
      ],
      shadowTiles: [
        { casters: [item(12, 40)], terrain: terrain(200) },
        { casters: [item(12, 40), item(100)], terrain: null },
      ] as unknown as FramePlan['shadowTiles'],
      impostors: { views: [[{ count: 30 }], [{ count: 4 }]] } as unknown as FramePlan['impostors'],
    }));
    expect(counts.drawCallsByPass).toEqual({ geometry: 7, shadow: 4, billboards: 2, impostors: 2, outlines: 1 });
    expect(counts.trianglesByPass).toEqual({
      geometry: 480 + 100 + 2 + 50 + 400 + 36,
      shadow: 480 + 200 + 480 + 100,
      billboards: 12,
      impostors: 68,
      outlines: 100,
    });
    expect(counts.drawCalls).toBe(16);
    expect(counts.triangles).toBe(1068 + 1260 + 12 + 68 + 100);
    expect(counts.instances).toBe(40 + 1 + 1 + 1 + 3);
  });
});
