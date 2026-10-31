/**
 * Shadow fitting, on the CPU each frame (the surface only draws what this decides):
 *
 *   Sun        `fitCascades`: the first view's depth up to the scene's `sun.shadow_distance`
 *              (else the quality's `shadowDistance`)
 *              split into cascades (a blend of logarithmic and even splits), each covered
 *              by one orthographic map fitted to the slice's bounding sphere. Stabilized:
 *              a sphere's size doesn't change as the camera turns, and its center snaps
 *              to whole texels in light space, so shadow edges don't shimmer or crawl
 *              while the camera moves.
 *   Point/spot `chooseLocalShadows`: lights with `shadows` on get atlas tiles nearest
 *              first (by how close their reach comes to the camera) until the quality's
 *              tiles run out — a spot light takes one tile (a perspective map along its
 *              cone), a point light six (cube faces +x, -x, +y, -y, +z, -z).
 */

import type { Cascade3d, Light3d, LocalShadow3d, Mat4, Quality3d, SunShadow3d, View3d, Xyz } from '../../../core/index.js';
import { cross3, dot3, multiply, normalize3, orthographic, perspective, transformPoint, viewMatrix } from '../../../resource/index.js';

/** Meters behind each cascade's sphere (toward the sun) still inside its map: tall casters outside the view. */
export const CASTER_REACH = 200;
/** 0: even splits, 1: logarithmic. Between keeps near cascades sharp without starving far ones. */
export const SPLIT_BLEND = 0.75;

/** View depths where each cascade ends, nearest first (the last is `far`). */
export function cascadeSplits(near: number, far: number, count: number): number[] {
  const splits: number[] = [];
  for (let i = 1; i <= count; i++) {
    const f = i / count;
    const log = near * (far / near) ** f;
    const even = near + (far - near) * f;
    splits.push(SPLIT_BLEND * log + (1 - SPLIT_BLEND) * even);
  }
  splits[count - 1] = far;
  return splits;
}

/** The 8 world-space corners of the view's frustum between view depths `from` and `to`. */
export function sliceCorners(view: View3d, from: number, to: number): [number, number, number][] {
  const corners: [number, number, number][] = [];
  for (const depth of [from, to]) {
    for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      const near = transformPoint(view.inverseViewProjection, x, y, 0);
      const far = transformPoint(view.inverseViewProjection, x, y, 1);
      const dNear = dot3([near[0] - view.position[0], near[1] - view.position[1], near[2] - view.position[2]], view.forward);
      const dFar = dot3([far[0] - view.position[0], far[1] - view.position[1], far[2] - view.position[2]], view.forward);
      const t = dFar === dNear ? 0 : (depth - dNear) / (dFar - dNear);
      corners.push([near[0] + (far[0] - near[0]) * t, near[1] + (far[1] - near[1]) * t, near[2] + (far[2] - near[2]) * t]);
    }
  }
  return corners;
}

/** World → light space rotation for light traveling along `direction` (light looks along +z). */
export function lightRotation(direction: Xyz): Float32Array {
  const forward = normalize3([direction[0], direction[1], direction[2]]);
  const helper = Math.abs(forward[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0];
  const right = normalize3(cross3(helper, forward));
  const up = cross3(forward, right);
  return viewMatrix([0, 0, 0], right, up, forward);
}

/** One cascade around a slice: sphere-fitted, its center snapped to the map's texels. */
export function fitCascade(corners: readonly (readonly number[])[], rotation: Float32Array, mapSize: number, far: number): Cascade3d {
  const center = [0, 0, 0];
  for (const c of corners) for (let k = 0; k < 3; k++) center[k]! += c[k]! / corners.length;
  let radius = 0;
  for (const c of corners) radius = Math.max(radius, Math.hypot(c[0]! - center[0]!, c[1]! - center[1]!, c[2]! - center[2]!));
  // Whole sixteenths of a meter: float noise in the corners never changes the map's scale.
  radius = Math.ceil(radius * 16) / 16;
  const [cx, cy, cz] = transformPoint(rotation, center[0]!, center[1]!, center[2]!);
  const texel = (2 * radius) / mapSize;
  const sx = Math.round(cx / texel) * texel;
  const sy = Math.round(cy / texel) * texel;
  const projection = orthographic(sx - radius, sx + radius, sy - radius, sy + radius, cz - radius - CASTER_REACH, cz + radius);
  return { viewProjection: multiply(projection, rotation), far, texelWorld: texel };
}

/** The sun's cascades for the first view. */
export function fitCascades(view: View3d, sunDirection: Xyz, quality: Quality3d, distance: number | null = null): SunShadow3d {
  // The scene's `sun.shadow_distance` replaces the quality's reach; the quality keeps its cascade count and map size.
  const far = Math.max(view.near * 2, Math.min(view.far, distance ?? quality.shadowDistance));
  const splits = cascadeSplits(view.near, far, quality.cascades);
  const rotation = lightRotation(sunDirection);
  const cascades = splits.map((to, i) => fitCascade(sliceCorners(view, i === 0 ? view.near : splits[i - 1]!, to), rotation, quality.shadowMapSize, to));
  return { cascades, mapSize: quality.shadowMapSize };
}

/** Cube face axes in order +x, -x, +y, -y, +z, -z: [forward, up]. */
const CUBE_FACES: readonly (readonly [Xyz, Xyz])[] = [
  [[1, 0, 0], [0, 1, 0]], [[-1, 0, 0], [0, 1, 0]],
  [[0, 1, 0], [0, 0, -1]], [[0, -1, 0], [0, 0, 1]],
  [[0, 0, 1], [0, 1, 0]], [[0, 0, -1], [0, 1, 0]],
];

/** Near plane of a local light's shadow maps. */
export function localNear(range: number): number {
  return Math.max(0.05, range * 0.005);
}

function faceMatrix(position: Xyz, forward: Xyz, upHint: Xyz, fov: number, range: number): Mat4 {
  const f = normalize3([forward[0], forward[1], forward[2]]);
  const helper = Math.abs(dot3(f, upHint)) > 0.99 ? (Math.abs(f[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0]) : upHint;
  const right = normalize3(cross3(helper, f));
  const up = cross3(f, right);
  return multiply(perspective(fov, 1, localNear(range), range), viewMatrix(position, right, up, f));
}

/**
 * A point light's face field of view: a little over 90° so filtering at a face's edge
 * stays inside its own tile (the shader picks the face by the major axis).
 */
export function pointFaceFov(tileSize: number): number {
  return (2 * Math.atan(1 + 3 / tileSize) * 180) / Math.PI;
}

export function localFaces(light: Light3d, tileSize: number): Mat4[] {
  if (light.kind === 'spot') {
    return [faceMatrix(light.position, light.direction, [0, 1, 0], Math.min(170, light.angle + 4), light.range)];
  }
  const fov = pointFaceFov(tileSize);
  return CUBE_FACES.map(([forward, up]) => faceMatrix(light.position, forward, up, fov, light.range));
}

/** Tiles a light's shadow takes. */
export function shadowTiles(light: Light3d): number {
  return light.kind === 'point' ? 6 : 1;
}

/** How close a light's reach comes to the view (negative: the camera is inside its range). */
export function lightReach(light: Light3d, view: View3d): number {
  const dx = light.position[0] - view.position[0];
  const dy = light.position[1] - view.position[1];
  const dz = light.position[2] - view.position[2];
  return Math.hypot(dx, dy, dz) - light.range;
}

/**
 * The shadowed point and spot lights for this frame, nearest reach first, within the
 * quality's tiles. `light` indexes `lights`; `dropped` counts lights that asked for a
 * shadow and got none.
 */
export function chooseLocalShadows(
  lights: readonly Light3d[], view: View3d | undefined, quality: Quality3d,
): { readonly shadows: LocalShadow3d[]; readonly dropped: number } {
  const wanted = lights
    .map((light, index) => ({ light, index }))
    .filter(({ light }) => light.shadows && light.kind !== 'directional' && light.intensity > 0 && light.range > 0);
  if (view === undefined) return { shadows: [], dropped: wanted.length };
  wanted.sort((a, b) => lightReach(a.light, view) - lightReach(b.light, view));
  const shadows: LocalShadow3d[] = [];
  let tile = 0;
  for (const { light, index } of wanted) {
    const tiles = shadowTiles(light);
    if (tile + tiles > quality.localShadowTiles) continue;
    shadows.push({ light: index, tile, faces: localFaces(light, quality.localShadowSize) });
    tile += tiles;
  }
  return { shadows, dropped: wanted.length - shadows.length };
}
