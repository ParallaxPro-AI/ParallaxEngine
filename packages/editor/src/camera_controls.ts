/**
 * The editor camera's controls, as pose math (the viewport feeds it pointer and key input).
 * They follow the editor's two navigation modes (the top bar's Orbit / Fly toggle):
 *
 *   orbit (default)  right-drag, or Ctrl / Cmd / Alt + left-drag, orbits the pivot;
 *                    middle-drag, or Shift + left-drag, pans; the wheel zooms toward the pivot
 *   fly              W A S D move on the ground plane, E / Space up, Q / Ctrl down (Shift: 2×,
 *                    faster with altitude); left- or right-drag looks around; the wheel sets
 *                    the fly speed
 *   2D               right- or middle-drag (or a modified left-drag) pans; the wheel zooms
 *                    about the pointer; the camera mode doesn't apply
 *
 * The orbit pivot is the point `distance` meters ahead of the camera, so the pose stays the
 * one source of truth (frame, undo or a reload may move it) and only the distance is kept.
 * No inertia: the camera stops when the input does.
 */

import { Quat, Vec3 } from '@parallax/runtime/core';
import type { CameraPose } from './session/index.js';

const DEG = 180 / Math.PI;

export type CameraMode = 'orbit' | 'fly';

/** Orbit and fly-look speed: 0.005 radians per CSS pixel. */
export const LOOK_DEGREES_PER_PIXEL = 0.005 * DEG;
/** Pan speed: this fraction of the pivot distance per CSS pixel. */
export const PAN_PER_PIXEL = 0.002;
/** Wheel zoom: the distance (2D: the view height) scales by 1 + deltaY × this. */
export const ZOOM_PER_DELTA = 0.001;
export const ORBIT_DISTANCE = { initial: 15, min: 0.5, max: 50_000 } as const;
/** Fly speed in meters per second; the wheel changes it by deltaY × `wheel`. */
export const FLY_SPEED = { initial: 10, min: 1, max: 5000, wheel: 0.1, sprint: 2 } as const;
/** 2D orthographic half-height limits (0.5..100000 visible height). */
export const ORTHO_SIZE = { min: 0.25, max: 50_000 } as const;
/** Pitch stays just short of straight up / down. */
const PITCH_LIMIT = 90 - 0.01 * DEG;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** Yaw (about +y, 0 = +z) and pitch (up positive) of a rotation's forward axis, in degrees. */
export function yawPitch(rotation: Quat): { yaw: number; pitch: number } {
  const f = rotation.rotate(Vec3.FORWARD);
  return { yaw: Math.atan2(f.x, f.z) * DEG, pitch: Math.asin(clamp(f.y, -1, 1)) * DEG };
}

export function lookRotation(yaw: number, pitch: number): Quat {
  return Quat.look_rotation(Vec3.from_yaw_pitch(yaw, clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT)));
}

/** Turn by a pointer movement (pixels; `degreesPerPixel` sets the speed). Drag right turns right, drag down looks down. */
export function look(pose: CameraPose, dx: number, dy: number, degreesPerPixel = LOOK_DEGREES_PER_PIXEL): CameraPose {
  const { yaw, pitch } = yawPitch(pose.rotation);
  return { ...pose, rotation: lookRotation(yaw + dx * degreesPerPixel, pitch - dy * degreesPerPixel) };
}

/** The orbit pivot: `distance` meters ahead of the camera. */
export function pivotOf(pose: CameraPose, distance: number): Vec3 {
  return pose.position.__add__(pose.rotation.rotate(Vec3.FORWARD).__mul__(distance));
}

/** Orbit about the pivot `distance` ahead: the view turns as `look` does and the camera swings around the pivot. */
export function orbit(pose: CameraPose, dx: number, dy: number, distance: number, degreesPerPixel = LOOK_DEGREES_PER_PIXEL): CameraPose {
  const pivot = pivotOf(pose, distance);
  const turned = look(pose, dx, dy, degreesPerPixel);
  return { ...turned, position: pivot.__sub__(turned.rotation.rotate(Vec3.FORWARD).__mul__(distance)) };
}

/** Wheel zoom toward the pivot: deltaY > 0 (scrolling down) zooms out. */
export function zoomOrbit(pose: CameraPose, distance: number, deltaY: number): { pose: CameraPose; distance: number } {
  const next = clamp(distance * (1 + deltaY * ZOOM_PER_DELTA), ORBIT_DISTANCE.min, ORBIT_DISTANCE.max);
  const pivot = pivotOf(pose, distance);
  return { pose: { ...pose, position: pivot.__sub__(pose.rotation.rotate(Vec3.FORWARD).__mul__(next)) }, distance: next };
}

/** Move in camera space: x right, y up (world up), z forward; meters. */
export function fly(pose: CameraPose, x: number, y: number, z: number): CameraPose {
  const right = pose.rotation.rotate(Vec3.RIGHT);
  const forward = pose.rotation.rotate(Vec3.FORWARD);
  const move = right.__mul__(x).__add__(Vec3.UP.__mul__(y)).__add__(forward.__mul__(z));
  return { ...pose, position: pose.position.__add__(move) };
}

/** Fly-mode movement: x right, z forward on the ground plane (the view's pitch doesn't tilt it), y world up; meters. */
export function flyLevel(pose: CameraPose, x: number, y: number, z: number): CameraPose {
  const { yaw } = yawPitch(pose.rotation);
  const forward = Vec3.from_yaw_pitch(yaw, 0);
  const right = Vec3.UP.cross(forward).normalized();
  const move = right.__mul__(x).__add__(Vec3.UP.__mul__(y)).__add__(forward.__mul__(z));
  return { ...pose, position: pose.position.__add__(move) };
}

/** Fly-mode meters per second: Shift doubles it, and above 10 m it grows with altitude. */
export function flyRate(speed: number, sprint: boolean, height: number): number {
  return speed * (sprint ? FLY_SPEED.sprint : 1) * Math.max(1, height / 10);
}

/** The fly speed after a wheel event (scrolling up flies faster). */
export function flySpeedAfterWheel(speed: number, deltaY: number): number {
  return clamp(speed - deltaY * FLY_SPEED.wheel, FLY_SPEED.min, FLY_SPEED.max);
}

/** Fly speed in meters per second: four times faster with Shift. (Kept for callers of the old controls.) */
export function flySpeed(base: number, shift: boolean): number {
  return base * (shift ? 4 : 1);
}

/**
 * Pan so the scene follows the pointer: `metersPerPixel` is the world size of one pixel at
 * the depth being dragged (orbit: PAN_PER_PIXEL × the pivot distance). Screen y grows downwards.
 */
export function pan(pose: CameraPose, dx: number, dy: number, metersPerPixel: number): CameraPose {
  const right = pose.rotation.rotate(Vec3.RIGHT);
  const up = pose.rotation.rotate(Vec3.UP);
  const move = right.__mul__(-dx * metersPerPixel).__add__(up.__mul__(dy * metersPerPixel));
  return { ...pose, position: pose.position.__add__(move) };
}

/** 2D zoom by `factor` (> 1: out), keeping the world point under the pointer fixed. */
export function zoom2dBy(pose: CameraPose, factor: number, pointer: { x: number; y: number }): CameraPose {
  const size = pose.size ?? 5;
  const next = clamp(size * factor, ORTHO_SIZE.min, ORTHO_SIZE.max);
  const k = 1 - next / size;
  const position = new Vec3(pose.position.x + (pointer.x - pose.position.x) * k, pose.position.y + (pointer.y - pose.position.y) * k, pose.position.z);
  return { ...pose, size: next, position };
}

/** 2D zoom by a wheel's deltaY (positive: out), scaling the view height. */
export function zoom2dWheel(pose: CameraPose, deltaY: number, pointer: { x: number; y: number }): CameraPose {
  return zoom2dBy(pose, Math.max(0.05, 1 + deltaY * ZOOM_PER_DELTA), pointer);
}

/** 2D zoom by wheel `steps` (positive: out). */
export function zoom2d(pose: CameraPose, steps: number, pointer: { x: number; y: number }): CameraPose {
  return zoom2dBy(pose, Math.pow(1.1, steps), pointer);
}

/** A wheel event's vertical delta in pixels (Firefox reports lines or pages). */
export function wheelPixels(event: Pick<WheelEvent, 'deltaY' | 'deltaMode'>): number {
  return event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * 800 : event.deltaY;
}

/** The orbit distance that keeps `point` as the pivot (its depth along the view), else `fallback`. */
export function distanceTo(pose: CameraPose, point: Vec3, fallback: number): number {
  const depth = point.__sub__(pose.position).dot(pose.rotation.rotate(Vec3.FORWARD));
  return depth > ORBIT_DISTANCE.min ? clamp(depth, ORBIT_DISTANCE.min, ORBIT_DISTANCE.max) : fallback;
}
