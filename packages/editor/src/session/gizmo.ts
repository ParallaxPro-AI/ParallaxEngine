/**
 * Gizmo math: translate, rotate and scale handles in world or local space, with snapping.
 * Pure functions of world poses and camera rays — the editor draws the handles (from
 * `gizmoHandles`, in screen pixels) and feeds pointer rays to a `GizmoDrag`, which answers
 * the entity's new world pose. Nothing here touches a game; the session applies the pose.
 *
 *   translate  x / y / z: along an axis      xy / yz / xz: in a plane      screen: in the view plane
 *   rotate     x / y / z: about an axis      screen: about the view direction
 *   scale      x / y / z: along a local axis uniform: all three           (scale is always local)
 *
 * In 2D the gizmo lives in the x/y plane: translate x, y, xy; rotate z; scale x, y, uniform.
 *
 * A rotate drag follows the grabbed point of its ring: the pointer ray meets the ring's
 * plane and the angle is swept around the center. A ring seen almost edge-on (its plane
 * within ~9° of the line of sight) can't be read that way — a pixel moves the hit meters,
 * across the center or past the plane's horizon, so the turn flips or stalls — and its two
 * halves overlap on screen. Such a ring turns by the pointer's motion along the screen
 * tangent of its near side instead: the side facing the camera follows the drag.
 */

import { fail, Quat, Vec3 } from '@parallax/runtime/core';
import type { Ray, ScreenView } from './view_math.js';

export type GizmoMode = 'translate' | 'rotate' | 'scale';
export type GizmoSpace = 'world' | 'local';
export type GizmoHandle = 'x' | 'y' | 'z' | 'xy' | 'yz' | 'xz' | 'screen' | 'uniform';

/** A world-space pose. */
export interface Pose {
  readonly position: Vec3;
  readonly rotation: Quat;
  readonly scale: Vec3;
}

/** Snap increments: meters, degrees, scale units. Absent: no snapping for that mode. */
export interface Snap {
  readonly translate?: number;
  readonly rotate?: number;
  readonly scale?: number;
}

const HANDLES: Readonly<Record<GizmoMode, Readonly<Record<'2d' | '3d', readonly GizmoHandle[]>>>> = {
  translate: { '3d': ['x', 'y', 'z', 'xy', 'yz', 'xz', 'screen'], '2d': ['x', 'y', 'xy'] },
  rotate: { '3d': ['x', 'y', 'z', 'screen'], '2d': ['z'] },
  scale: { '3d': ['x', 'y', 'z', 'uniform'], '2d': ['x', 'y', 'uniform'] },
};

export function handlesFor(mode: GizmoMode, dimension: '2d' | '3d'): readonly GizmoHandle[] {
  return HANDLES[mode][dimension];
}

/** The gizmo's x, y, z axes: world axes, or the pose's rotated ones. Scale always uses local axes. */
export function gizmoAxes(pose: Pose, space: GizmoSpace, mode: GizmoMode): [Vec3, Vec3, Vec3] {
  if (space === 'world' && mode !== 'scale') return [Vec3.RIGHT, Vec3.UP, Vec3.FORWARD];
  return [pose.rotation.rotate(Vec3.RIGHT), pose.rotation.rotate(Vec3.UP), pose.rotation.rotate(Vec3.FORWARD)];
}

function axisIndex(handle: GizmoHandle): number {
  return handle === 'x' ? 0 : handle === 'y' ? 1 : 2;
}

/** Rotation by `degrees` about a unit axis. */
export function axisAngle(axis: Vec3, degrees: number): Quat {
  const half = (degrees * Math.PI) / 360;
  const s = Math.sin(half);
  return new Quat(axis.x * s, axis.y * s, axis.z * s, Math.cos(half));
}

function snapTo(value: number, step: number | undefined): number {
  return step === undefined || step <= 0 ? value : Math.round(value / step) * step;
}

/** The parameter along line (p, a) of the point closest to the ray, or null when they're parallel. */
function closestOnLine(p: Vec3, a: Vec3, ray: Ray): number | null {
  const w = p.__sub__(ray.origin);
  const b = a.dot(ray.direction);
  const denom = 1 - b * b;
  if (Math.abs(denom) < 1e-6) return null;
  const d = a.dot(w);
  const e = ray.direction.dot(w);
  return (b * e - d) / denom;
}

function rayPlane(ray: Ray, point: Vec3, normal: Vec3): Vec3 | null {
  const denom = normal.dot(ray.direction);
  if (Math.abs(denom) < 1e-6) return null;
  const t = normal.dot(point.__sub__(ray.origin)) / denom;
  if (t < 0) return null;
  return ray.origin.__add__(ray.direction.__mul__(t));
}

export interface GizmoDragInit {
  readonly mode: GizmoMode;
  readonly handle: GizmoHandle;
  readonly space: GizmoSpace;
  /** The entity's world pose when the drag began. */
  readonly pose: Pose;
  /** The pointer ray when the drag began. */
  readonly ray: Ray;
  /** The view the drag happens in (its forward axis is the screen handles' normal). */
  readonly view: Pick<ScreenView, 'forward' | 'dimension'>;
  /** The rings' radius in meters (`GizmoLayout.length`): how far an edge-on ring's grabbed side moves per radian. */
  readonly radius?: number;
}

/** A rotate ring whose plane is nearer than this (|cos| of axis vs. line of sight) to edge-on turns by the screen tangent. */
const EDGE_ON = 0.15;

/** An edge-on ring's drag: pointer motion in the view plane along the near side's tangent. */
interface TangentDrag {
  /** The view plane through the center, which the pointer ray meets. */
  readonly normal: Vec3;
  readonly from: Vec3;
  /** Unit direction, in the view plane, the near side moves on screen for a positive turn. */
  readonly along: Vec3;
  /** Meters that side moves in the view plane per radian. */
  readonly perRadian: number;
}

/**
 * One drag of a handle. `update(ray)` answers the pose for the pointer's current ray, from
 * the pose the drag began with (so snapping never accumulates error). A ray that runs
 * parallel to the handle's line or plane keeps the last pose.
 */
export class GizmoDrag {
  readonly mode: GizmoMode;
  readonly handle: GizmoHandle;
  readonly start: Pose;
  readonly #axes: [Vec3, Vec3, Vec3];
  readonly #normal: Vec3 | null;
  readonly #line: Vec3 | null;
  readonly #from: number | Vec3 | null;
  #last: Pose;
  /** Rotation: degrees turned so far (accumulated, so a drag can turn past 180°). */
  #angle = 0;
  #prev: Vec3 | null = null;
  #tangent: TangentDrag | null = null;

  constructor(init: GizmoDragInit) {
    const { mode, handle, pose } = init;
    if (!handlesFor(mode, init.view.dimension).includes(handle)) {
      fail('PP9620', `A ${mode} gizmo in ${init.view.dimension} has no "${handle}" handle`, {
        fix: `Use one of: ${handlesFor(mode, init.view.dimension).join(', ')}.`,
      });
    }
    this.mode = mode;
    this.handle = handle;
    this.start = pose;
    this.#last = pose;
    const axes = gizmoAxes(pose, init.space, mode);
    this.#axes = axes;
    const viewNormal = init.view.forward;
    let normal: Vec3 | null = null;
    let line: Vec3 | null = null;
    if (mode === 'rotate') {
      normal = handle === 'screen' ? viewNormal : axes[axisIndex(handle)]!;
    } else if (handle === 'xy' || handle === 'yz' || handle === 'xz') {
      const [i, j] = handle === 'xy' ? [0, 1] : handle === 'yz' ? [1, 2] : [0, 2];
      normal = axes[i]!.cross(axes[j]!).normalized();
    } else if (handle === 'screen' || handle === 'uniform') {
      normal = viewNormal;
    } else {
      line = axes[axisIndex(handle)]!;
    }
    this.#normal = normal;
    this.#line = line;
    this.#from = line !== null ? closestOnLine(pose.position, line, init.ray) : rayPlane(init.ray, pose.position, normal!);
    if (mode === 'rotate' && this.#from instanceof Vec3) this.#prev = this.#from.__sub__(pose.position);
    if (mode === 'rotate' && handle !== 'screen') this.#tangent = edgeOnDrag(normal!, pose.position, init.ray, viewNormal, init.radius);
  }

  /** The pose for the pointer's ray now. */
  update(ray: Ray, snap: Snap = {}): Pose {
    const next = this.#solve(ray, snap);
    if (next !== null) this.#last = next;
    return this.#last;
  }

  #solve(ray: Ray, snap: Snap): Pose | null {
    const { position, rotation, scale } = this.start;
    if (this.#tangent !== null) {
      const t = this.#tangent;
      const hit = rayPlane(ray, position, t.normal);
      if (hit === null) return null;
      this.#angle = (hit.__sub__(t.from).dot(t.along) / t.perRadian) * 180 / Math.PI;
      const turned = axisAngle(this.#normal!, snapTo(this.#angle, snap.rotate));
      return { position, rotation: turned.__mul__(rotation), scale };
    }
    if (this.#from === null) return null;
    if (this.#line !== null) {
      const t = closestOnLine(position, this.#line, ray);
      if (t === null) return null;
      const delta = t - (this.#from as number);
      if (this.mode === 'translate') {
        return { position: position.__add__(this.#line.__mul__(snapTo(delta, snap.translate))), rotation, scale };
      }
      // Scale along a local axis: the ratio of distances from the center (a drag through it flips sign).
      const from = this.#from as number;
      const factor = Math.abs(from) < 1e-6 ? 1 + delta : t / from;
      const i = axisIndex(this.handle);
      const parts = [scale.x, scale.y, scale.z];
      parts[i] = snapTo(parts[i]! * factor, snap.scale);
      return { position, rotation, scale: new Vec3(parts[0]!, parts[1]!, parts[2]!) };
    }
    const hit = rayPlane(ray, position, this.#normal!);
    if (hit === null) return null;
    const from = this.#from as Vec3;
    if (this.mode === 'translate') {
      const delta = hit.__sub__(from);
      if (this.handle === 'screen') return { position: position.__add__(delta), rotation, scale };
      const [i, j] = this.handle === 'xy' ? [0, 1] : this.handle === 'yz' ? [1, 2] : [0, 2];
      const a = this.#axes[i]!;
      const b = this.#axes[j]!;
      const moved = a.__mul__(snapTo(delta.dot(a), snap.translate)).__add__(b.__mul__(snapTo(delta.dot(b), snap.translate)));
      return { position: position.__add__(moved), rotation, scale };
    }
    if (this.mode === 'rotate') {
      const v = hit.__sub__(position);
      const prev = this.#prev!;
      if (v.length() < 1e-9 || prev.length() < 1e-9) return null;
      const n = this.#normal!;
      this.#angle += (Math.atan2(n.dot(prev.cross(v)), prev.dot(v)) * 180) / Math.PI;
      this.#prev = v;
      const turned = axisAngle(n, snapTo(this.#angle, snap.rotate));
      return { position, rotation: turned.__mul__(rotation), scale };
    }
    // Uniform scale: distance from the center in the view plane, relative to where the drag began.
    const d0 = from.__sub__(position).length();
    if (d0 < 1e-9) return null;
    const factor = hit.__sub__(position).length() / d0;
    const s = (v: number): number => snapTo(v * factor, snap.scale);
    return { position, rotation, scale: new Vec3(s(scale.x), s(scale.y), s(scale.z)) };
  }

  /** Degrees turned so far (rotate drags), before snapping. */
  get degrees(): number {
    return this.#angle;
  }
}

/**
 * The tangent drag of a rotate ring about `axis` seen nearly edge-on along `ray`, or null
 * when the ring faces the camera enough for the plane hit to follow the pointer.
 */
function edgeOnDrag(axis: Vec3, center: Vec3, ray: Ray, viewNormal: Vec3, radius: number | undefined): TangentDrag | null {
  const d = ray.direction;
  if (Math.abs(axis.dot(d)) >= EDGE_ON) return null;
  // The near side: the ring's in-plane direction toward the camera.
  const toward = d.__sub__(axis.__mul__(axis.dot(d))).__mul__(-1);
  if (toward.length() < 1e-9) return null;
  const near = toward.normalized();
  // A positive turn about `axis` moves `near` along axis × near (first order of axisAngle).
  const tangent = axis.cross(near);
  const onScreen = tangent.__sub__(viewNormal.__mul__(tangent.dot(viewNormal)));
  const from = rayPlane(ray, center, viewNormal);
  if (from === null || onScreen.length() < 1e-6) return null;
  const r = radius !== undefined && radius > 0 ? radius : Math.max(from.__sub__(center).length(), 1e-6);
  return { normal: viewNormal, from, along: onScreen.normalized(), perRadian: r * onScreen.length() };
}

// ── Handles on screen ──────────────────────────────────────────────────────────

/** One handle as screen geometry: a polyline (axes, rings) or a filled quad (planes, the uniform box). */
export interface HandleShape {
  readonly handle: GizmoHandle;
  /** x, y pixel pairs. */
  readonly points: readonly number[];
  readonly closed: boolean;
  /** Axis colors by convention: x red, y green, z blue, others white. */
  readonly color: 'x' | 'y' | 'z' | 'plane' | 'screen';
}

export interface GizmoLayout {
  /** World meters of the gizmo's arms at this distance (its size is constant on screen). */
  readonly length: number;
  readonly shapes: readonly HandleShape[];
}

const COLORS: Readonly<Record<GizmoHandle, HandleShape['color']>> = {
  x: 'x', y: 'y', z: 'z', xy: 'plane', yz: 'plane', xz: 'plane', screen: 'screen', uniform: 'screen',
};

/**
 * The handles of a gizmo at `pose`, projected for drawing and hit testing. `sizePx` is the
 * arm length on screen. Handles that fall behind the camera are left out.
 */
export function gizmoHandles(view: ScreenView, pose: Pose, mode: GizmoMode, space: GizmoSpace, sizePx = 100): GizmoLayout {
  const length = view.pixelSize(pose.position) * sizePx;
  const axes = gizmoAxes(pose, space, mode);
  const c = pose.position;
  const shapes: HandleShape[] = [];
  const polyline = (handle: GizmoHandle, world: readonly Vec3[], closed: boolean): void => {
    const points: number[] = [];
    for (const p of world) {
      const s = view.project(p);
      if (s === null) return;
      points.push(s.x, s.y);
    }
    shapes.push({ handle, points, closed, color: COLORS[handle] });
  };
  for (const handle of handlesFor(mode, view.dimension)) {
    if (handle === 'x' || handle === 'y' || handle === 'z') {
      const a = axes[axisIndex(handle)]!;
      if (mode === 'rotate') {
        // A ring about the axis.
        const [u, v] = handle === 'x' ? [axes[1], axes[2]] : handle === 'y' ? [axes[2], axes[0]] : [axes[0], axes[1]];
        const ring: Vec3[] = [];
        for (let i = 0; i < 48; i++) {
          const t = (i / 48) * Math.PI * 2;
          ring.push(c.__add__(u!.__mul__(Math.cos(t) * length)).__add__(v!.__mul__(Math.sin(t) * length)));
        }
        polyline(handle, ring, true);
      } else {
        polyline(handle, [c, c.__add__(a.__mul__(length))], false);
      }
    } else if (handle === 'xy' || handle === 'yz' || handle === 'xz') {
      const [i, j] = handle === 'xy' ? [0, 1] : handle === 'yz' ? [1, 2] : [0, 2];
      const a = axes[i]!.__mul__(length * 0.25);
      const b = axes[j]!.__mul__(length * 0.25);
      const o = c.__add__(axes[i]!.__mul__(length * 0.2)).__add__(axes[j]!.__mul__(length * 0.2));
      polyline(handle, [o, o.__add__(a), o.__add__(a).__add__(b), o.__add__(b)], true);
    } else {
      // screen / uniform: a square (translate, scale) or a ring (rotate) facing the camera.
      const s = view.project(c);
      if (s === null) continue;
      const r = mode === 'rotate' ? sizePx * 1.15 : sizePx * 0.12;
      const points: number[] = [];
      const n = mode === 'rotate' ? 48 : 4;
      for (let k = 0; k < n; k++) {
        const t = mode === 'rotate' ? (k / n) * Math.PI * 2 : Math.PI / 4 + (k / 4) * Math.PI * 2;
        points.push(s.x + Math.cos(t) * r, s.y + Math.sin(t) * r);
      }
      shapes.push({ handle, points, closed: true, color: COLORS[handle] });
    }
  }
  return { length, shapes };
}

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function insidePolygon(px: number, py: number, points: readonly number[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 2; i < points.length; j = i, i += 2) {
    const xi = points[i]!; const yi = points[i + 1]!; const xj = points[j]!; const yj = points[j + 1]!;
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * The handle under a screen point, or null: filled handles (planes, the center square) by
 * containment, lines and rings within `tolerancePx`; the nearest wins, filled ones first.
 */
export function hitHandle(layout: GizmoLayout, x: number, y: number, tolerancePx = 6): GizmoHandle | null {
  let best: { handle: GizmoHandle; distance: number } | null = null;
  let filledBest: { handle: GizmoHandle; distance: number } | null = null;
  for (const shape of layout.shapes) {
    const filled = shape.closed && shape.points.length === 8;
    if (filled && insidePolygon(x, y, shape.points)) {
      // Overlapping squares (planes seen edge-on): the one whose middle is nearest wins.
      const p = shape.points;
      const d = Math.hypot(x - (p[0]! + p[2]! + p[4]! + p[6]!) / 4, y - (p[1]! + p[3]! + p[5]! + p[7]!) / 4);
      if (filledBest === null || d < filledBest.distance) filledBest = { handle: shape.handle, distance: d };
      continue;
    }
    const n = shape.points.length / 2;
    const segments = shape.closed ? n : n - 1;
    for (let k = 0; k < segments; k++) {
      const a = k * 2;
      const b = ((k + 1) % n) * 2;
      const d = segmentDistance(x, y, shape.points[a]!, shape.points[a + 1]!, shape.points[b]!, shape.points[b + 1]!);
      if (d <= tolerancePx && (best === null || d < best.distance)) best = { handle: shape.handle, distance: d };
    }
  }
  return filledBest?.handle ?? best?.handle ?? null;
}
