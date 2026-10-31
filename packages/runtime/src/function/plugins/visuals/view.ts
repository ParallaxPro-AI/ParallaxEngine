/**
 * The resolved view of a camera — what a renderer draws with — and the math on it that
 * needs no GPU: projection, unprojection, rays, camera-relative directions, framing.
 *
 * Conventions (shared with every renderer):
 *   - 3D is y-up with +z forward and +x right (Vec3.FORWARD / Vec3.RIGHT). A camera
 *     looks along `rotation · (0, 0, 1)`; its screen-up is `rotation · (0, 1, 0)` and its
 *     screen-right `rotation · (1, 0, 0)`. Euler pitch is positive looking down.
 *   - 2D draws the x/y plane: screen-right is `rotation · (1, 0, 0)`, screen-up
 *     `rotation · (0, 1, 0)` (rotation is the camera's 2D angle about +z); z is draw order.
 *   - Screen points are pixels with y down, origin at the top-left of the screen.
 *   - `fov` is the vertical field of view in degrees; `size` the orthographic half-height.
 */

import { Color, deg, fail, Quat, rad, Vec2, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';

export type Dimension = '2d' | '3d';

export interface Screen {
  /** Pixels. */
  readonly width: number;
  readonly height: number;
}

export interface PixelRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Near and far clip distances in meters, used by projections here and by renderers. The far
 * plane is 20 km, past where an ocean or a terrain meets the horizon from any height a game
 * flies at: renderers clamp it to the quality's view distance and fade everything into the
 * sky before it (render3d's `viewFadeOf`), so the edge of the drawn world never shows. Depth
 * precision is set by the near plane, so the long far plane costs almost none.
 */
export const NEAR = 0.1;
export const FAR = 20000;

export interface CameraView {
  readonly entity: EntityId;
  /** The seat this camera serves (the camera entity's owner; 0 when unowned). */
  readonly seat: number;
  /** The camera `ctx.camera.main` gives for its seat: renderers draw active views only. */
  readonly active: boolean;
  readonly dimension: Dimension;
  readonly mode: 'perspective' | 'orthographic';
  /** World position, shake included. */
  readonly position: Vec3;
  /** World rotation, kick included. */
  readonly rotation: Quat;
  /** Vertical field of view in degrees (perspective). */
  readonly fov: number;
  /** Orthographic half-height in meters, after `fit` and multi-target framing. */
  readonly size: number;
  readonly near: number;
  readonly far: number;
  /** Where on the screen this view draws, in pixels. */
  readonly viewport: PixelRect;
  /** viewport width / height. */
  readonly aspect: number;
  /** Clear colour; null = the scene's sky. */
  readonly background: Color | null;
}

export interface Axes {
  readonly right: Vec3;
  readonly up: Vec3;
  /** Into the screen. */
  readonly forward: Vec3;
}

export function axes(view: Pick<CameraView, 'rotation' | 'dimension'>): Axes {
  const q = view.rotation;
  return {
    right: q.rotate(Vec3.RIGHT),
    up: q.rotate(Vec3.UP),
    forward: view.dimension === '2d' ? new Vec3(0, 0, -1) : q.rotate(Vec3.FORWARD),
  };
}

/** The rotation whose forward is `forward` (no roll): yaw about +y, pitch positive down. */
export function lookRotation(forward: Vec3): Quat {
  const f = forward.normalized();
  const pitch = -deg(Math.asin(Math.max(-1, Math.min(1, f.y))));
  const yaw = deg(Math.atan2(f.x, f.z));
  return Quat.from_euler(new Vec3(pitch, yaw, 0));
}

/** Yaw in degrees of a rotation's forward on the ground plane (0 = +z, positive toward +x). */
export function yawOf(rotation: Quat): number {
  const f = rotation.rotate(Vec3.FORWARD);
  return f.x === 0 && f.z === 0 ? 0 : deg(Math.atan2(f.x, f.z));
}

/** A viewport `[x, y, width, height]` (fractions, y from the top) in pixels. */
export function pixelRect(viewport: readonly number[], screen: Screen): PixelRect {
  return {
    x: viewport[0]! * screen.width,
    y: viewport[1]! * screen.height,
    width: viewport[2]! * screen.width,
    height: viewport[3]! * screen.height,
  };
}

function tanHalfFov(view: CameraView): number {
  return Math.tan(rad(view.fov) / 2);
}

/** Normalized device coordinates (-1..1, y up) of a screen pixel in this view. */
function toNdc(view: CameraView, screen: Vec2): Vec2 {
  const vp = view.viewport;
  return new Vec2(((screen.x - vp.x) / vp.width) * 2 - 1, 1 - ((screen.y - vp.y) / vp.height) * 2);
}

/** A world point → screen pixels, or null when it is behind the camera or outside the viewport. */
export function worldToScreen(view: CameraView, point: Vec3): Vec2 | null {
  const { right, up, forward } = axes(view);
  const v = point.__sub__(view.position);
  let nx: number;
  let ny: number;
  if (view.dimension === '2d') {
    nx = v.dot(right) / (view.size * view.aspect);
    ny = v.dot(up) / view.size;
  } else {
    const depth = v.dot(forward);
    if (depth < view.near || depth > view.far) return null;
    if (view.mode === 'perspective') {
      const t = tanHalfFov(view);
      nx = v.dot(right) / (depth * t * view.aspect);
      ny = v.dot(up) / (depth * t);
    } else {
      nx = v.dot(right) / (view.size * view.aspect);
      ny = v.dot(up) / view.size;
    }
  }
  if (Math.abs(nx) > 1 || Math.abs(ny) > 1) return null;
  const vp = view.viewport;
  return new Vec2(vp.x + ((nx + 1) / 2) * vp.width, vp.y + ((1 - ny) / 2) * vp.height);
}

/** (origin, unit direction) of the ray through a screen pixel. */
export function screenRay(view: CameraView, screen: Vec2): [Vec3, Vec3] {
  const { right, up, forward } = axes(view);
  const ndc = toNdc(view, screen);
  if (view.dimension === '3d' && view.mode === 'perspective') {
    const t = tanHalfFov(view);
    const dir = forward.__add__(right.__mul__(ndc.x * t * view.aspect)).__add__(up.__mul__(ndc.y * t)).normalized();
    return [view.position, dir];
  }
  const origin = view.position
    .__add__(right.__mul__(ndc.x * view.size * view.aspect))
    .__add__(up.__mul__(ndc.y * view.size));
  return [origin, forward];
}

/**
 * A screen pixel → world point. 2D: the point on the x/y plane (z = 0). 3D: where the
 * ray meets the ground plane y = 0, or the point `far` meters along the ray when it never
 * does (looking at or above the horizon).
 */
export function screenToWorld(view: CameraView, screen: Vec2): Vec3 {
  const [origin, dir] = screenRay(view, screen);
  if (view.dimension === '2d') return new Vec3(origin.x, origin.y, 0);
  if (dir.y < -1e-9) {
    const t = -origin.y / dir.y;
    if (t >= 0) return origin.__add__(dir.__mul__(t));
  }
  return origin.__add__(dir.__mul__(view.far));
}

/**
 * A move stick → a world direction relative to the view, length kept. 3D: on the ground
 * plane (stick up = the camera's forward flattened; straight down views use screen-up).
 * 2D: on the x/y plane, turned with the camera.
 */
export function relative(view: CameraView, stick: Vec2): Vec3 {
  const { right, up, forward } = axes(view);
  if (view.dimension === '2d') return right.__mul__(stick.x).__add__(up.__mul__(stick.y)).with_z(0);
  let ahead = forward.flat();
  if (ahead.length_squared() < 1e-12) ahead = up.flat();
  ahead = ahead.normalized();
  const side = new Vec3(ahead.z, 0, -ahead.x);
  return side.__mul__(stick.x).__add__(ahead.__mul__(stick.y));
}

/** Orthographic half-height that keeps a world rectangle (plus margin) fully visible at `aspect`. */
export function fitSize(min: Vec2, max: Vec2, margin: number, aspect: number): number {
  const halfWidth = Math.abs(max.x - min.x) / 2 + margin;
  const halfHeight = Math.abs(max.y - min.y) / 2 + margin;
  return Math.max(halfHeight, halfWidth / aspect);
}

/** The view's center pixel. */
export function viewCenter(view: CameraView): Vec2 {
  const vp = view.viewport;
  return new Vec2(vp.x + vp.width / 2, vp.y + vp.height / 2);
}

export function requireViewport(viewport: unknown, where: string): readonly number[] {
  const ok = Array.isArray(viewport) && viewport.length === 4 && viewport.every((n) => typeof n === 'number' && Number.isFinite(n));
  if (!ok) {
    fail('PP3710', `${where} must be [x, y, width, height], got ${JSON.stringify(viewport)}`, {
      fix: 'Write four fractions of the screen, e.g. [0, 0, 0.5, 1] for the left half.',
    });
  }
  const [x, y, w, h] = viewport as number[];
  if (x! < 0 || y! < 0 || w! <= 0 || h! <= 0 || x! + w! > 1 + 1e-9 || y! + h! > 1 + 1e-9) {
    fail('PP3710', `${where} [${viewport.join(', ')}] is not inside the screen`, {
      fix: 'x, y ≥ 0, width and height > 0, and x + width, y + height ≤ 1.',
    });
  }
  return viewport as number[];
}
