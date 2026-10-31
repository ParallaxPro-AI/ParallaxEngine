/**
 * Screen ↔ world through what was actually drawn: a 3D frame's `View3d` (matrices for the
 * surface's pixels) or a 2D frame's `View2d` plus the surface size. Picking, gizmos and
 * observation all go through a `ScreenView`, so they agree with the image on screen.
 *
 * Screen points are surface pixels, origin at the top-left (a canvas's backing pixels: an
 * editor converts CSS pixels with the device pixel ratio first).
 */

import { Vec3 } from '@parallax/runtime/core';
import type { View2d, View3d } from '@parallax/runtime/core';

export interface Ray {
  readonly origin: Vec3;
  /** Unit length. */
  readonly direction: Vec3;
}

export interface PixelRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
  /** Distance in front of the camera along its forward axis (3D); 0 in 2D. */
  readonly depth: number;
}

export interface ScreenView {
  readonly dimension: '2d' | '3d';
  /** The camera entity whose view this is. */
  readonly camera: number | null;
  readonly viewport: PixelRect;
  /** Unit axes of the camera in world space (2D: +x right, +y up, forward into the screen = -z). */
  readonly right: Vec3;
  readonly up: Vec3;
  readonly forward: Vec3;
  readonly position: Vec3;
  readonly perspective: boolean;
  /** Column-major world → clip (3D; 2D: the equivalent orthographic matrix). */
  readonly viewProjection: readonly number[];
  readonly near: number;
  readonly far: number;
  /** Where a world point lands, or null behind the camera / outside near..far. */
  project(point: Vec3): ScreenPoint | null;
  /** The ray under a screen point. */
  ray(x: number, y: number): Ray;
  /** World meters one screen pixel spans at `point` (gizmos keep a constant size on screen). */
  pixelSize(point: Vec3): number;
}

const xyz = (v: readonly number[]): Vec3 => new Vec3(v[0]!, v[1]!, v[2]!);

function unproject(inverse: ArrayLike<number>, nx: number, ny: number, nz: number): Vec3 {
  const m = inverse;
  const x = m[0]! * nx + m[4]! * ny + m[8]! * nz + m[12]!;
  const y = m[1]! * nx + m[5]! * ny + m[9]! * nz + m[13]!;
  const z = m[2]! * nx + m[6]! * ny + m[10]! * nz + m[14]!;
  const w = m[3]! * nx + m[7]! * ny + m[11]! * nz + m[15]!;
  return new Vec3(x / w, y / w, z / w);
}

/** A rendered 3D view (Frame3d.views[i]). Clip depth is 0..1 (WebGPU's convention, as the port defines). */
export function view3d(view: View3d): ScreenView {
  const vp = Array.from(view.viewProjection);
  const projection = Array.from(view.projection);
  const inverse = view.inverseViewProjection;
  const { x: vx, y: vy, width: vw, height: vh } = view.viewport;
  const position = xyz(view.position);
  const forward = xyz(view.forward);
  const perspective = projection[11] !== 0;
  return {
    dimension: '3d',
    camera: view.camera,
    viewport: { x: vx, y: vy, width: vw, height: vh },
    right: xyz(view.right),
    up: xyz(view.up),
    forward,
    position,
    perspective,
    viewProjection: vp,
    near: view.near,
    far: view.far,
    project(p) {
      const cx = vp[0]! * p.x + vp[4]! * p.y + vp[8]! * p.z + vp[12]!;
      const cy = vp[1]! * p.x + vp[5]! * p.y + vp[9]! * p.z + vp[13]!;
      const cw = vp[3]! * p.x + vp[7]! * p.y + vp[11]! * p.z + vp[15]!;
      const depth = p.__sub__(position).dot(forward);
      if (depth < view.near || depth > view.far || cw <= 1e-9) return null;
      return { x: vx + (cx / cw * 0.5 + 0.5) * vw, y: vy + (0.5 - cy / cw * 0.5) * vh, depth };
    },
    ray(x, y) {
      const nx = ((x - vx) / vw) * 2 - 1;
      const ny = 1 - ((y - vy) / vh) * 2;
      const near = unproject(inverse, nx, ny, 0);
      const far = unproject(inverse, nx, ny, 1);
      return { origin: near, direction: far.__sub__(near).normalized() };
    },
    pixelSize(p) {
      const f = projection[5]!;
      if (!perspective) return 2 / (f * vh);
      const depth = Math.max(view.near, p.__sub__(position).dot(forward));
      return (2 * depth) / (f * vh);
    },
  };
}

/** A rendered 2D view (Frame2d.view) on a surface of `screen` pixels. */
export function view2d(view: View2d, screen: { readonly width: number; readonly height: number }, camera: number | null = null): ScreenView {
  const [fx, fy, fw, fh] = view.viewport;
  const viewport = { x: fx * screen.width, y: fy * screen.height, width: fw * screen.width, height: fh * screen.height };
  const scale = viewport.height / (2 * view.halfHeight);
  const a = (view.angle * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const [cxw, cyw] = view.center;
  const right = new Vec3(cos, sin, 0);
  const up = new Vec3(-sin, cos, 0);
  const forward = new Vec3(0, 0, -1);
  // World → clip as a matrix (for observation consumers that re-project): rotate by -angle, scale to -1..1.
  const sx = 1 / (view.halfHeight * (viewport.width / viewport.height));
  const sy = 1 / view.halfHeight;
  const vp = [
    cos * sx, -sin * sy, 0, 0,
    sin * sx, cos * sy, 0, 0,
    0, 0, 0, 0,
    -(cos * cxw + sin * cyw) * sx, (sin * cxw - cos * cyw) * sy, 0, 1,
  ];
  return {
    dimension: '2d',
    camera,
    viewport,
    right,
    up,
    forward,
    position: new Vec3(cxw, cyw, 0),
    perspective: false,
    viewProjection: vp,
    near: -Infinity,
    far: Infinity,
    project(p) {
      const dx = p.x - cxw;
      const dy = p.y - cyw;
      const rx = dx * cos + dy * sin;
      const ry = -dx * sin + dy * cos;
      return { x: viewport.x + viewport.width / 2 + rx * scale, y: viewport.y + viewport.height / 2 - ry * scale, depth: 0 };
    },
    ray(x, y) {
      const rx = (x - viewport.x - viewport.width / 2) / scale;
      const ry = -(y - viewport.y - viewport.height / 2) / scale;
      const wx = cxw + rx * cos - ry * sin;
      const wy = cyw + rx * sin + ry * cos;
      // Looking into the screen from in front of every draw order.
      return { origin: new Vec3(wx, wy, 1e6), direction: forward };
    },
    pixelSize: () => 1 / scale,
  };
}
