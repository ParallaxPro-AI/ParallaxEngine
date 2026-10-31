/**
 * Visibility tests the frame plan runs per view and per shadow tile, on every mesh instance:
 *
 *   - frustum culling: an instance's world bounding sphere (its geometry's box under the
 *     instance matrix) against the six planes of a view-projection (`frustumPlanes`, clip z in
 *     0..1 as the port's projections map it);
 *   - detail: an instance inside the frustum whose sphere projects to fewer pixels than the
 *     quality's `detailPixels` (texels, for a shadow tile) is too small to draw (`sphereSmall`);
 *   - occlusion: optionally, after the frustum, a Hi-Z test against the depth the surface read
 *     back from an earlier frame (`occlusion.ts`), through `PlanOptions.occluded`.
 *
 * Spheres are conservative (never cull a visible instance), cheap to transform and test,
 * and computed once per instance per frame, then shared by every view and tile.
 */

/** Six planes (a, b, c, d) with unit normals pointing inside: left, right, bottom, top, near, far. */
export type Planes = Float64Array;

/** The planes of a world → clip matrix (column-major), for clip x, y in -w..w and z in 0..w. */
export function frustumPlanes(vp: ArrayLike<number>): Planes {
  const row = (r: number): [number, number, number, number] => [vp[r]!, vp[4 + r]!, vp[8 + r]!, vp[12 + r]!];
  const [r0, r1, r2, r3] = [row(0), row(1), row(2), row(3)];
  const planes = new Float64Array(24);
  const set = (i: number, p: readonly number[]): void => {
    const l = Math.hypot(p[0]!, p[1]!, p[2]!) || 1;
    for (let k = 0; k < 4; k++) planes[i * 4 + k] = p[k]! / l;
  };
  set(0, r3.map((v, k) => v + r0[k]!));
  set(1, r3.map((v, k) => v - r0[k]!));
  set(2, r3.map((v, k) => v + r1[k]!));
  set(3, r3.map((v, k) => v - r1[k]!));
  set(4, r2);
  set(5, r3.map((v, k) => v - r2[k]!));
  return planes;
}

/** Whether a sphere is at least partly inside the planes. */
export function sphereVisible(planes: Planes, x: number, y: number, z: number, r: number): boolean {
  for (let i = 0; i < 24; i += 4) {
    if (planes[i]! * x + planes[i + 1]! * y + planes[i + 2]! * z + planes[i + 3]! < -r) return false;
  }
  return true;
}

/**
 * The world bounding sphere of a local box under a column-major matrix at `m[mo..]`, written
 * to `out[o..o+3]` (center, radius). The radius scales by the matrix's largest axis.
 */
export function boundingSphere(
  m: ArrayLike<number>, mo: number, min: readonly number[], max: readonly number[], out: Float32Array | number[], o: number, pad = 0,
): void {
  const cx = (min[0]! + max[0]!) / 2;
  const cy = (min[1]! + max[1]!) / 2;
  const cz = (min[2]! + max[2]!) / 2;
  const half = Math.hypot(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!) / 2;
  const sx = Math.hypot(m[mo]!, m[mo + 1]!, m[mo + 2]!);
  const sy = Math.hypot(m[mo + 4]!, m[mo + 5]!, m[mo + 6]!);
  const sz = Math.hypot(m[mo + 8]!, m[mo + 9]!, m[mo + 10]!);
  out[o] = m[mo]! * cx + m[mo + 4]! * cy + m[mo + 8]! * cz + m[mo + 12]!;
  out[o + 1] = m[mo + 1]! * cx + m[mo + 5]! * cy + m[mo + 9]! * cz + m[mo + 13]!;
  out[o + 2] = m[mo + 2]! * cx + m[mo + 6]! * cy + m[mo + 10]! * cz + m[mo + 14]!;
  out[o + 3] = half * Math.max(sx, sy, sz) * (1 + pad);
}

/**
 * Detail culling: pixels per clip unit of a world → clip matrix drawn into `width` × `height`
 * pixels — half the target's size times the length of the clip x and y rows. For a
 * perspective view that is the focal length in pixels (a sphere's radius projects to
 * `r · scale / w`, w its view depth); for an orthographic one (w = 1) pixels per meter.
 */
export function pixelScale(vp: ArrayLike<number>, width: number, height: number): number {
  return Math.max(
    (Math.hypot(vp[0]!, vp[4]!, vp[8]!) * width) / 2,
    (Math.hypot(vp[1]!, vp[5]!, vp[9]!) * height) / 2,
  );
}

/**
 * Whether a sphere projects to a radius under `minPixels` (`pixelScale`'s pixels): too small
 * to be worth drawing. Conservative: in perspective a sphere reaching the eye's plane is never small.
 */
export function sphereSmall(vp: ArrayLike<number>, scale: number, minPixels: number, x: number, y: number, z: number, r: number): boolean {
  if (!(minPixels > 0)) return false;
  const w = vp[3]! * x + vp[7]! * y + vp[11]! * z + vp[15]!;
  // Perspective (clip w is view depth): a sphere reaching the eye's plane is never small.
  if ((vp[3] !== 0 || vp[7] !== 0 || vp[11] !== 0) && w <= r) return false;
  if (!(w > 0)) return false;
  return (r * scale) / w < minPixels;
}

/** Counts a cull reports (stats, the occlusion governor, tests). */
export interface CullStats {
  /** Instances tested against a view's frustum. */
  tested: number;
  /** Inside the frustum. */
  inFrustum: number;
  /** Inside the frustum but hidden by the Hi-Z test. */
  occluded: number;
}

export function emptyStats(): CullStats {
  return { tested: 0, inFrustum: 0, occluded: 0 };
}
