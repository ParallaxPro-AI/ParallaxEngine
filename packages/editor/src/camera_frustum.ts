/**
 * The camera gizmo: a game camera drawn in the editor viewport as a wireframe frustum (the
 * near rectangle, a far rectangle a short display length ahead, the four edges joining them
 * and a small triangle over the far edge marking "up"), so cameras are visible and
 * clickable although they draw nothing themselves. Editor-only: the viewport's overlay
 * canvas draws it, the game never sees it.
 *
 * The geometry is pure: `frustumSegments` gives world-space segments from a camera's resolved
 * view (visuals' `camera.__view__`), `screenSegments` clips them to the editor view's depth
 * range and projects them, and `nearestSegment` hit-tests a click against what was drawn.
 */

import { Vec3 } from '@parallax/runtime/core';
import type { Quat } from '@parallax/runtime/core';
import type { ScreenView } from './session/index.js';

/** How far ahead an unselected camera's frustum reaches (meters; its far plane caps it). */
export const FRUSTUM_LENGTH = 1.5;
/** A selected camera's frustum reaches further (still capped by its far plane). */
export const FRUSTUM_SELECTED_LENGTH = 6;
/** A click within this many CSS px of a frustum line selects its camera. */
export const FRUSTUM_HIT_PX = 6;

/** The fields of a camera's resolved view the gizmo needs (visuals' CameraView). */
export interface FrustumCamera {
  readonly dimension?: '2d' | '3d';
  readonly mode: 'perspective' | 'orthographic';
  readonly position: Vec3;
  readonly rotation: Quat;
  /** Vertical field of view, degrees (perspective). */
  readonly fov: number;
  /** Orthographic half-height, meters. */
  readonly size: number;
  readonly near: number;
  readonly far: number;
  /** width / height; the editor's own aspect when the camera has no viewport of its own. */
  readonly aspect: number;
}

export type Segment = readonly [Vec3, Vec3];

/** One segment on screen, surface pixels. */
export interface ScreenSegment {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** The frustum's world-space segments, the far plane clamped to `length` ahead (at least just past near). */
export function frustumSegments(camera: FrustumCamera, length: number = FRUSTUM_LENGTH): Segment[] {
  const q = camera.rotation;
  const right = q.rotate(Vec3.RIGHT);
  const up = q.rotate(Vec3.UP);
  const forward = q.rotate(Vec3.FORWARD);
  const aspect = Number.isFinite(camera.aspect) && camera.aspect > 0 ? camera.aspect : 16 / 9;
  const near = Math.max(0.01, Number.isFinite(camera.near) ? camera.near : 0.1);
  const far = Math.max(near * 1.5, Math.min(Number.isFinite(camera.far) ? camera.far : length, Math.max(length, near * 1.5)));
  const perspective = camera.mode !== 'orthographic';
  const tan = Math.tan(((Math.min(170, Math.max(1, camera.fov || 60)) * Math.PI) / 180) / 2);
  const halfHeight = (d: number): number => (perspective ? d * tan : Math.max(0.01, camera.size || 5));
  const rect = (d: number): Vec3[] => {
    const hh = halfHeight(d);
    const hw = hh * aspect;
    const center = camera.position.__add__(forward.__mul__(d));
    const r = right.__mul__(hw);
    const u = up.__mul__(hh);
    // Bottom-left, bottom-right, top-right, top-left.
    return [center.__sub__(r).__sub__(u), center.__add__(r).__sub__(u), center.__add__(r).__add__(u), center.__sub__(r).__add__(u)];
  };
  const n = rect(near);
  const f = rect(far);
  const out: Segment[] = [];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    out.push([n[i]!, n[j]!], [f[i]!, f[j]!], [n[i]!, f[i]!]);
  }
  // Perspective: the edges also run back to the eye, so the frustum reads as a pyramid.
  if (perspective) for (const corner of n) out.push([camera.position, corner]);
  // "Up": a triangle standing on the far rectangle's top edge.
  const hh = halfHeight(far);
  const top = f[3]!.lerp(f[2]!, 0.5);
  const apex = top.__add__(up.__mul__(hh * 0.5));
  const a = f[3]!.lerp(f[2]!, 0.25);
  const b = f[3]!.lerp(f[2]!, 0.75);
  out.push([a, apex], [apex, b], [b, a]);
  return out;
}

/** Segments clipped to the view's depth range (a frustum running behind the editor camera keeps its visible part) and projected. */
export function screenSegments(view: Pick<ScreenView, 'position' | 'forward' | 'near' | 'far' | 'project'>, segments: readonly Segment[]): ScreenSegment[] {
  const lo = view.near * 1.001;
  const hi = view.far * 0.999;
  const out: ScreenSegment[] = [];
  for (const [p, q] of segments) {
    const dp = p.__sub__(view.position).dot(view.forward);
    const dq = q.__sub__(view.position).dot(view.forward);
    let t0 = 0;
    let t1 = 1;
    const clip = (from: number, to: number, bound: number, keepAbove: boolean): boolean => {
      const inFrom = keepAbove ? from >= bound : from <= bound;
      const inTo = keepAbove ? to >= bound : to <= bound;
      if (inFrom && inTo) return true;
      if (!inFrom && !inTo) return false;
      const t = (bound - from) / (to - from);
      if (inFrom) t1 = Math.min(t1, t); else t0 = Math.max(t0, t);
      return true;
    };
    if (!clip(dp, dq, lo, true) || !clip(dp, dq, hi, false) || t0 >= t1) continue;
    const a = view.project(p.lerp(q, t0));
    const b = view.project(p.lerp(q, t1));
    if (a === null || b === null) continue;
    out.push({ x0: a.x, y0: a.y, x1: b.x, y1: b.y });
  }
  return out;
}

/** Distance from a point to a screen segment (pixels). */
export function segmentDistance(x: number, y: number, s: ScreenSegment): number {
  const dx = s.x1 - s.x0;
  const dy = s.y1 - s.y0;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - s.x0) * dx + (y - s.y0) * dy) / len2));
  return Math.hypot(x - (s.x0 + t * dx), y - (s.y0 + t * dy));
}

/** The camera whose drawn frustum passes nearest a point, within `slop` pixels; null when none does. */
export function nearestSegment<T>(drawn: readonly { readonly id: T; readonly segments: readonly ScreenSegment[] }[], x: number, y: number, slop: number): T | null {
  let best: T | null = null;
  let bestDistance = slop;
  for (const camera of drawn) {
    for (const s of camera.segments) {
      const d = segmentDistance(x, y, s);
      if (d <= bestDistance) {
        bestDistance = d;
        best = camera.id;
      }
    }
  }
  return best;
}
