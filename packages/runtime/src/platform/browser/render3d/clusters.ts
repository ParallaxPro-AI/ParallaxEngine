/**
 * Clustered forward lighting, assigned on the CPU each frame (no compute shaders, so
 * WebGL2 runs the same path). Each view is cut into a grid of clusters — columns and rows
 * across its pixels, slices along view depth spaced logarithmically — and each point or
 * spot light is listed in every cluster its range sphere may touch. A fragment finds its
 * cluster from its pixel and depth and shades only that cluster's lights.
 *
 * Data, as the shaders read it (both backends, `texelFetch`/`textureLoad`):
 *   grid   one RG32UI texel per cluster: first item, item count (`DATA_ROW` per row)
 *   items  one R32UI texel per item: a light's index in the light texture
 * Every view's clusters sit end to end in one grid; a view's first cluster is in its frame
 * block (`clusterParams.w`).
 *
 * Bounds are conservative: a sphere's screen rectangle comes from the extremes of its
 * view-space box, and its slices from its depth extent. A light may be listed in a cluster
 * it doesn't reach (shading then adds nothing); it is never missing from one it does.
 */

import type { Light3d, View3d } from '../../../core/index.js';

export interface ClusterDims {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Meters the depth slices span at most: a light farther than this shades nothing (its range
 * is far shorter than the distance), and a long far plane (visuals' 20 km) would otherwise
 * stretch every slice. Pixels beyond fall into the last slice.
 */
export const CLUSTER_FAR = 2000;

/** Slice of a view depth: floor(log(depth) · scale + bias), clamped to the slices. */
export interface SliceMapping {
  readonly scale: number;
  readonly bias: number;
}

export function sliceMapping(near: number, far: number, slices: number): SliceMapping {
  const span = Math.log(far / near);
  return { scale: slices / span, bias: (-slices * Math.log(near)) / span };
}

export function sliceOf(depth: number, mapping: SliceMapping, slices: number): number {
  if (!(depth > 0)) return 0;
  return Math.min(slices - 1, Math.max(0, Math.floor(Math.log(depth) * mapping.scale + mapping.bias)));
}

/** The cluster box a light's range sphere may touch in a view, or null when it is outside the view. */
export function lightClusterBox(
  light: Light3d, view: View3d, dims: ClusterDims, mapping: SliceMapping, clusterFar: number,
): { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number } | null {
  const v = view.view;
  const [px, py, pz] = light.position;
  // View space: x right, y up, z forward (depth).
  const x = v[0]! * px + v[4]! * py + v[8]! * pz + v[12]!;
  const y = v[1]! * px + v[5]! * py + v[9]! * pz + v[13]!;
  const z = v[2]! * px + v[6]! * py + v[10]! * pz + v[14]!;
  const r = light.range;
  const zMin = z - r;
  const zMax = z + r;
  if (zMax < view.near || zMin > clusterFar) return null;
  const p = view.projection;
  let ndcX0: number; let ndcX1: number; let ndcY0: number; let ndcY1: number;
  if (p[11] !== 0) {
    // Perspective (symmetric): ndc = P00 · x / z. A sphere crossing the near plane covers everything.
    if (zMin <= view.near) {
      ndcX0 = -1; ndcX1 = 1; ndcY0 = -1; ndcY1 = 1;
    } else {
      const ext = (c: number, scale: number): [number, number] => {
        const values = [(c - r) / zMin, (c - r) / zMax, (c + r) / zMin, (c + r) / zMax].map((n) => n * scale);
        return [Math.min(...values), Math.max(...values)];
      };
      [ndcX0, ndcX1] = ext(x, p[0]!);
      [ndcY0, ndcY1] = ext(y, p[5]!);
    }
  } else {
    ndcX0 = p[0]! * (x - r) + p[12]!; ndcX1 = p[0]! * (x + r) + p[12]!;
    ndcY0 = p[5]! * (y - r) + p[13]!; ndcY1 = p[5]! * (y + r) + p[13]!;
  }
  if (ndcX1 < -1 || ndcX0 > 1 || ndcY1 < -1 || ndcY0 > 1) return null;
  const col = (ndc: number): number => Math.min(dims.x - 1, Math.max(0, Math.floor(((ndc + 1) / 2) * dims.x)));
  // Rows count from the top of the view (ndc y = 1).
  const row = (ndc: number): number => Math.min(dims.y - 1, Math.max(0, Math.floor(((1 - ndc) / 2) * dims.y)));
  return {
    x0: col(ndcX0), x1: col(ndcX1), y0: row(ndcY1), y1: row(ndcY0),
    z0: sliceOf(Math.max(zMin, view.near), mapping, dims.z), z1: sliceOf(Math.min(zMax, clusterFar), mapping, dims.z),
  };
}

export interface ClusterViewPlan {
  /** First cluster of this view in the grid. */
  readonly base: number;
  readonly mapping: SliceMapping;
}

export interface ClusterPlan {
  readonly dims: ClusterDims;
  readonly views: readonly ClusterViewPlan[];
  /** Two uints per cluster (first item, count), padded to whole `rowTexels` rows. */
  readonly grid: Uint32Array;
  /** One uint per item, padded to whole rows. */
  readonly items: Uint32Array;
}

/**
 * Cluster every view. `lights` are the frame's shaded lights; `firstLocal` is the index of
 * the first non-directional one (directional lights shade everything and aren't clustered).
 */
export function buildClusters(lights: readonly Light3d[], firstLocal: number, views: readonly View3d[], dims: ClusterDims, rowTexels: number): ClusterPlan {
  const perView = dims.x * dims.y * dims.z;
  const lists: number[][] = Array.from({ length: perView * views.length }, () => []);
  const viewPlans: ClusterViewPlan[] = views.map((view, v) => {
    const clusterFar = Math.max(view.near * 2, Math.min(view.far, CLUSTER_FAR));
    const mapping = sliceMapping(view.near, clusterFar, dims.z);
    for (let i = firstLocal; i < lights.length; i++) {
      const box = lightClusterBox(lights[i]!, view, dims, mapping, clusterFar);
      if (box === null) continue;
      for (let cz = box.z0; cz <= box.z1; cz++) {
        for (let cy = box.y0; cy <= box.y1; cy++) {
          for (let cx = box.x0; cx <= box.x1; cx++) lists[v * perView + (cz * dims.y + cy) * dims.x + cx]!.push(i);
        }
      }
    }
    return { base: v * perView, mapping };
  });
  const clusters = lists.length;
  const grid = new Uint32Array(Math.max(1, Math.ceil((clusters) / rowTexels)) * rowTexels * 2);
  let total = 0;
  for (const list of lists) total += list.length;
  const items = new Uint32Array(Math.max(1, Math.ceil(total / rowTexels)) * rowTexels);
  let at = 0;
  lists.forEach((list, c) => {
    grid[c * 2] = at;
    grid[c * 2 + 1] = list.length;
    items.set(list, at);
    at += list.length;
  });
  return { dims, views: viewPlans, grid, items };
}
