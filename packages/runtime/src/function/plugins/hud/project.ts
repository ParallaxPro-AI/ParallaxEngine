/**
 * Screen placement for world-anchored HUD items (nameplates, markers, pings, awareness,
 * the interaction prompt): a world point in a seat's camera view as fractions of that
 * seat's viewport (x, y from the top-left — the area a seat's PlayerPanel copy covers),
 * plus where to pin it on the viewport's edge when it is off screen or behind the camera.
 *
 * Views are read by component id like every renderer does (`camera.__view__`, the visuals
 * plugin's resolved view). Only the fields used here are named.
 */

import { Vec3 } from '../../../core/index.js';
import type { Quat } from '../../../core/index.js';
import type { Kernel } from '../../kernel/index.js';
import { CAMERA } from './schemas.js';

export interface ViewLike {
  readonly entity: number;
  readonly seat: number;
  readonly active: boolean;
  readonly dimension: '2d' | '3d';
  readonly mode: 'perspective' | 'orthographic';
  readonly position: Vec3;
  readonly rotation: Quat;
  readonly fov: number;
  readonly size: number;
  readonly near: number;
  readonly far: number;
  readonly aspect: number;
  readonly viewport: { readonly width: number; readonly height: number };
}

export interface Placed {
  /** Fractions of the viewport, clamped onto the edge inset when `onScreen` is false. */
  readonly x: number;
  readonly y: number;
  readonly onScreen: boolean;
  /** Degrees, screen space, from the viewport center toward the point (0 = up, 90 = right). */
  readonly angle: number;
  /** Meters from the camera. */
  readonly distance: number;
}

/** How far from the viewport's edge pinned items sit (fraction). */
export const EDGE_INSET = 0.05;

/** The active view of each seat (first found per seat), by seat. */
export function seatViews(kernel: Kernel, cameras: Iterable<number>): Map<number, ViewLike> {
  const views = new Map<number, ViewLike>();
  for (const id of cameras) {
    const view = (kernel.world.get(id as never)?.components.get(CAMERA) as { __view__?: ViewLike } | undefined)?.__view__;
    if (view === undefined || !view.active || views.has(view.seat)) continue;
    if (!(view.viewport.width > 0 && view.viewport.height > 0)) continue;
    views.set(view.seat, view);
  }
  return views;
}

/** The view's heading in degrees (0 = +z / +y north, 90 = +x east). */
export function viewHeading(view: ViewLike): number {
  if (view.dimension === '2d') return 0;
  const f = view.rotation.rotate(Vec3.FORWARD);
  return (Math.atan2(f.x, f.z) * 180) / Math.PI;
}

/**
 * A world point in a view. Off screen (or behind a perspective camera) it is pinned to the
 * edge inset along the direction it lies in, so an arrow there points at it.
 */
export function place(view: ViewLike, point: Vec3): Placed {
  const right = view.rotation.rotate(Vec3.RIGHT);
  const up = view.rotation.rotate(Vec3.UP);
  const forward = view.rotation.rotate(Vec3.FORWARD);
  const v = point.__sub__(view.position);
  const distance = v.length();
  let nx: number;
  let ny: number;
  let behind = false;
  if (view.dimension === '2d' || view.mode === 'orthographic') {
    nx = v.dot(right) / (view.size * view.aspect);
    ny = v.dot(up) / view.size;
  } else {
    const depth = v.dot(forward);
    const t = Math.tan((view.fov * Math.PI) / 360);
    if (depth <= view.near) {
      // Behind: keep only the sideways direction, pushed past the edge.
      behind = true;
      const sx = v.dot(right);
      const sy = v.dot(up);
      const n = Math.hypot(sx, sy);
      // Straight behind: pin to the bottom edge.
      nx = n === 0 ? 0 : (sx / n) * 4;
      ny = n === 0 ? -4 : (sy / n) * 4;
    } else {
      nx = v.dot(right) / (depth * t * view.aspect);
      ny = v.dot(up) / (depth * t);
    }
  }
  const angle = (Math.atan2(nx * view.aspect, ny) * 180) / Math.PI;
  const onScreen = !behind && Math.abs(nx) <= 1 && Math.abs(ny) <= 1
    && (view.dimension === '2d' || view.mode === 'orthographic' || distance <= view.far);
  if (onScreen) return { x: (nx + 1) / 2, y: (1 - ny) / 2, onScreen, angle, distance };
  // Scale onto the inset rectangle along the same direction from the center.
  const limit = 1 - 2 * EDGE_INSET;
  const k = limit / Math.max(Math.abs(nx), Math.abs(ny), 1e-9);
  return { x: (nx * k + 1) / 2, y: (1 - ny * k) / 2, onScreen, angle, distance };
}

/** A fraction as a CSS percentage. */
export function pct(fraction: number): string {
  return `${Math.round(fraction * 10000) / 100}%`;
}

/** A colour as a CSS rgba(). */
export function css(color: { r: number; g: number; b: number; a: number }): string {
  const c = (v: number): number => Math.round(Math.max(0, Math.min(1, v)) * 255);
  return `rgba(${c(color.r)}, ${c(color.g)}, ${c(color.b)}, ${Math.round(color.a * 1000) / 1000})`;
}
