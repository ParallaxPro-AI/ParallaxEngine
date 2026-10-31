/**
 * Photos and model portraits: frames drawn offscreen at their own size and read back
 * (`RenderSurface3d.capture`), for a game's photo mode, a gallery, a HUD's character
 * portraits and item icons.
 *
 *   photo     the last frame drawn, seen from a camera (default: the first view's) at the
 *             asked size — the world as it was, every effect and light included
 *   portrait  one model alone in a studio: framed by its bounds from a yaw and pitch, a key
 *             light from the upper left, soft sky fill, no fog, no post effects, the
 *             background transparent unless a color is given. An entity's portrait shows its
 *             current pose and look; a model reference shows the model at rest.
 */

import { PLAIN_POST } from '../../../core/index.js';
import type { Environment3d, Frame3d, MeshBatch, Quality3d, Rgba, SkinnedDraw, View3d } from '../../../core/index.js';
import { invert, multiply, perspective, viewMatrix } from '../../../resource/index.js';
import { fitCascades } from './shadow.js';

/** A photo's frame: the last frame from another view at another size. */
export function photoFrame(last: Frame3d, view: View3d): Frame3d {
  const sun = last.environment.sun;
  return {
    ...last, views: [view], offscreen: [],
    sunShadow: sun !== null && sun.shadows ? fitCascades(view, sun.direction, last.quality, last.environment.shadowDistance ?? null) : null,
  };
}

export interface PortraitOptions {
  readonly width: number;
  readonly height: number;
  /** Degrees about +y the camera stands from the model's front (0: facing it). */
  readonly yaw: number;
  /** Degrees above the horizon. */
  readonly pitch: number;
  /** Straight-alpha sRGB; null: transparent. */
  readonly background: Rgba | null;
}

/** The world box of a frame's meshes (skinned ones by their bind-pose boxes), or null when it draws nothing. */
export function drawnBounds(meshes: readonly MeshBatch[], skinned: readonly SkinnedDraw[]): { min: number[]; max: number[] } | null {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  const grow = (m: ArrayLike<number>, o: number, min: readonly number[], max: readonly number[]): void => {
    for (let i = 0; i < 8; i++) {
      const p = [i & 1 ? max[0]! : min[0]!, i & 2 ? max[1]! : min[1]!, i & 4 ? max[2]! : min[2]!];
      for (let k = 0; k < 3; k++) {
        const v = m[o + k]! * p[0]! + m[o + 4 + k]! * p[1]! + m[o + 8 + k]! * p[2]! + m[o + 12 + k]!;
        lo[k] = Math.min(lo[k]!, v);
        hi[k] = Math.max(hi[k]!, v);
      }
    }
  };
  for (const b of meshes) for (let i = 0; i < b.count; i++) grow(b.instances, i * 20, b.geometry.min, b.geometry.max);
  for (const d of skinned) grow(d.model, 0, d.geometry.min, d.geometry.max);
  return lo[0] === Infinity ? null : { min: lo, max: hi };
}

/** A studio view framing a box from a yaw and pitch (vertical fov 30°). */
export function portraitView(bounds: { min: readonly number[]; max: readonly number[] }, options: PortraitOptions, camera: number): View3d {
  const center = [0, 1, 2].map((k) => (bounds.min[k]! + bounds.max[k]!) / 2);
  const radius = Math.max(1e-3, Math.hypot(bounds.max[0]! - bounds.min[0]!, bounds.max[1]! - bounds.min[1]!, bounds.max[2]! - bounds.min[2]!) / 2);
  const fov = 30;
  const aspect = options.width / options.height;
  const fit = Math.min(1, aspect);
  const distance = (radius / Math.sin(((fov / 2) * Math.PI) / 180)) / fit * 1.05;
  const yaw = (options.yaw * Math.PI) / 180;
  const pitch = (options.pitch * Math.PI) / 180;
  // The camera stands in front of the model (+z is its front) and looks back at it.
  const toCamera = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
  const position: [number, number, number] = [center[0]! + toCamera[0]! * distance, center[1]! + toCamera[1]! * distance, center[2]! + toCamera[2]! * distance];
  const forward: [number, number, number] = [-toCamera[0]!, -toCamera[1]!, -toCamera[2]!];
  let right: [number, number, number] = [forward[2], 0, -forward[0]];
  const l = Math.hypot(right[0], right[2]) || 1;
  right = [right[0] / l, 0, right[2] / l];
  const up: [number, number, number] = [
    forward[1] * right[2] - forward[2] * right[1], forward[2] * right[0] - forward[0] * right[2], forward[0] * right[1] - forward[1] * right[0],
  ];
  const near = Math.max(0.01, distance - radius * 2);
  const far = distance + radius * 2;
  const view = viewMatrix(position, right, up, forward);
  const projection = perspective(fov, aspect, near, far);
  const viewProjection = multiply(projection, view);
  return {
    camera, viewport: { x: 0, y: 0, width: options.width, height: options.height }, position, right, up, forward,
    view, projection, viewProjection, inverseViewProjection: invert(viewProjection) ?? viewProjection, near, far,
    clear: options.background ?? [0, 0, 0, 0], colorVision: 'none',
  };
}

/** The studio: a key light from the upper left of the camera, sky fill, no fog, plain post. */
export function studioEnvironment(view: View3d): Environment3d {
  const key = [view.forward[0] * 0.6 + view.right[0] * 0.5 - 0.6, view.forward[1] * 0.6 + view.right[1] * 0.5 - 0.8, view.forward[2] * 0.6 + view.right[2] * 0.5];
  const l = Math.hypot(key[0]!, key[1]!, key[2]!) || 1;
  return {
    sky: { zenith: [0.55, 0.6, 0.7], horizon: [0.75, 0.75, 0.75] },
    fog: { kind: 'none', color: [0, 0, 0], density: 0, near: 0, far: 0, volumetric: 0 },
    ambient: [0.45, 0.45, 0.5],
    sun: { direction: [key[0]! / l, key[1]! / l, key[2]! / l], color: [1, 0.97, 0.92], intensity: 2.2 * Math.PI, shadows: false },
    post: { ...PLAIN_POST },
  };
}

/** A portrait's frame: the meshes alone in the studio. */
export function portraitFrame(meshes: readonly MeshBatch[], skinned: readonly SkinnedDraw[], view: View3d, quality: Quality3d, frame: number): Frame3d {
  return {
    frame, views: [view], environment: studioEnvironment(view), quality, sunShadow: null, localShadows: [], terrain: null,
    meshes: meshes.map((b) => ({ ...b, castShadows: false })), skinned: skinned.map((d) => ({ ...d, castShadows: false })),
    lights: [], billboards: [], texts: [], lines: [], outlines: [],
  };
}
