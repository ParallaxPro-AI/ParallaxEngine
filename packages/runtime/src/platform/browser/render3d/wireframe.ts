/**
 * Wireframe mode draws each triangle mesh as its edges: a line list built once per
 * geometry from its triangles, reusing the geometry's vertex buffers. An edge two
 * triangles share is listed once; so is an edge between split vertices at the same
 * positions (hard-edged meshes duplicate vertices for their normals), keyed by position.
 */

import type { Geometry3d } from '../../../core/index.js';

/** Line-list indices (two per edge) of a geometry's triangle edges, each drawn once. */
export function edgeIndices(geometry: Geometry3d): Uint32Array {
  const p = geometry.positions;
  const tri = geometry.indices;
  // Vertices with identical positions share one key, so split vertices don't double edges.
  const keyOf = new Map<string, number>();
  const vertexKey = new Uint32Array(p.length / 3);
  for (let v = 0; v < vertexKey.length; v++) {
    const k = `${p[v * 3]},${p[v * 3 + 1]},${p[v * 3 + 2]}`;
    let id = keyOf.get(k);
    if (id === undefined) keyOf.set(k, (id = keyOf.size));
    vertexKey[v] = id;
  }
  const seen = new Set<number>();
  const out: number[] = [];
  const stride = keyOf.size + 1;
  const edge = (a: number, b: number): void => {
    const ka = vertexKey[a]!;
    const kb = vertexKey[b]!;
    if (ka === kb) return;
    const key = ka < kb ? ka * stride + kb : kb * stride + ka;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(a, b);
  };
  for (let t = 0; t + 2 < tri.length; t += 3) {
    edge(tri[t]!, tri[t + 1]!);
    edge(tri[t + 1]!, tri[t + 2]!);
    edge(tri[t + 2]!, tri[t]!);
  }
  return Uint32Array.from(out);
}
