/**
 * What cloth and soft bodies collide with: the scene's simple colliders and its ground.
 *
 *   - every entity with a `collider` (the physics plugins' component, read by id like every
 *     renderer) whose shape is a sphere, capsule, box or cylinder, and which isn't a trigger,
 *     posed by its world transform (offset and scale applied as physics3d applies them);
 *     mesh and convex colliders are not collided with;
 *   - the terrain's surface, when the scene has one (terrain service).
 *
 * Collision is one-way: particles are pushed out of shapes with a `thickness` margin and
 * lose tangential motion by `friction`; the shapes are never pushed back. Shapes are taken
 * once per fixed step, culled to the body's bounds.
 */

import { Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import type { Kernel } from '../../kernel/index.js';
import { TERRAIN_SERVICE } from '../../services/index.js';
import type { TerrainField } from '../../services/index.js';

const COLLIDER = 'collider';

export type Shape =
  | { readonly kind: 'sphere'; readonly c: readonly number[]; readonly r: number }
  | { readonly kind: 'capsule'; readonly a: readonly number[]; readonly b: readonly number[]; readonly r: number }
  /** `m`: rows of the rotation (world → local), `c` center, `h` half extents (box) / [radius, half height] (cylinder). */
  | { readonly kind: 'box' | 'cylinder'; readonly c: readonly number[]; readonly m: readonly number[]; readonly h: readonly number[] };

export interface Obstacles {
  readonly shapes: readonly Shape[];
  readonly ground: TerrainField | null;
}

function vec(value: unknown, fallback: Vec3): Vec3 {
  return value instanceof Vec3 ? value : fallback;
}

/** Shapes overlapping the box [min, max] (world), excluding `skip`'s entities. */
export function gatherObstacles(kernel: Kernel, min: readonly number[], max: readonly number[], skip: ReadonlySet<EntityId>): Obstacles {
  const shapes: Shape[] = [];
  for (const [id, found] of kernel.world.query([COLLIDER])) {
    const fields = found!;
    if (skip.has(id) || fields['trigger'] === true) continue;
    const record = kernel.world.get(id)!;
    const t = record.transform;
    const scale = t.worldScale();
    const sx = Math.abs(scale.x);
    const sy = Math.abs(scale.y);
    const sz = Math.abs(scale.z);
    const rotation = t.worldRotation();
    const center = t.toWorld(vec(fields['offset'], Vec3.ZERO));
    const shape = fields['shape'];
    let made: Shape | undefined;
    let reach: number;
    if (shape === 'sphere') {
      const r = (fields['radius'] as number) * Math.max(sx, sy, sz);
      made = { kind: 'sphere', c: [center.x, center.y, center.z], r };
      reach = r;
    } else if (shape === 'capsule') {
      const r = (fields['radius'] as number) * Math.max(sx, sz);
      const half = Math.max(0, (fields['height'] as number) * sy / 2 - r);
      const up = rotation.rotate(new Vec3(0, half, 0));
      made = { kind: 'capsule', a: [center.x - up.x, center.y - up.y, center.z - up.z], b: [center.x + up.x, center.y + up.y, center.z + up.z], r };
      reach = half + r;
    } else if (shape === 'box' || shape === 'cylinder') {
      const inv = rotation.inverse();
      const ax = inv.rotate(new Vec3(1, 0, 0));
      const ay = inv.rotate(new Vec3(0, 1, 0));
      const az = inv.rotate(new Vec3(0, 0, 1));
      // Rows of world → local: local = M · (p − c).
      const m = [ax.x, ay.x, az.x, ax.y, ay.y, az.y, ax.z, ay.z, az.z];
      let h: number[];
      if (shape === 'box') {
        const size = vec(fields['size'], Vec3.ONE);
        h = [size.x * sx / 2, size.y * sy / 2, size.z * sz / 2];
      } else {
        h = [(fields['radius'] as number) * Math.max(sx, sz), (fields['height'] as number) * sy / 2];
      }
      made = { kind: shape, c: [center.x, center.y, center.z], m, h };
      reach = Math.hypot(...h, shape === 'cylinder' ? h[0]! : 0);
    } else {
      continue;
    }
    if (center.x + reach < min[0]! || center.x - reach > max[0]! || center.y + reach < min[1]! || center.y - reach > max[1]!
      || center.z + reach < min[2]! || center.z - reach > max[2]!) continue;
    shapes.push(made);
  }
  return { shapes, ground: kernel.tryService(TERRAIN_SERVICE)?.current() ?? null };
}

/**
 * Push particle `i` of `x` out of every obstacle by `margin`, with friction against its
 * motion since `prev`. Returns whether it touched anything.
 */
export function collideParticle(x: Float64Array, prev: Float64Array, i: number, obstacles: Obstacles, margin: number, friction: number): boolean {
  const k = i * 3;
  let touched = false;
  for (const shape of obstacles.shapes) {
    const px = x[k]!;
    const py = x[k + 1]!;
    const pz = x[k + 2]!;
    let nx = 0;
    let ny = 0;
    let nz = 0;
    let depth = 0;
    if (shape.kind === 'sphere' || shape.kind === 'capsule') {
      let cx: number;
      let cy: number;
      let cz: number;
      if (shape.kind === 'sphere') {
        [cx, cy, cz] = shape.c as [number, number, number];
      } else {
        const [ax, ay, az] = shape.a as [number, number, number];
        const dx = shape.b[0]! - ax;
        const dy = shape.b[1]! - ay;
        const dz = shape.b[2]! - az;
        const len2 = dx * dx + dy * dy + dz * dz;
        const s = len2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / len2)) : 0;
        cx = ax + dx * s;
        cy = ay + dy * s;
        cz = az + dz * s;
      }
      const ox = px - cx;
      const oy = py - cy;
      const oz = pz - cz;
      const d = Math.sqrt(ox * ox + oy * oy + oz * oz);
      depth = shape.r + margin - d;
      if (depth <= 0) continue;
      if (d > 1e-9) {
        nx = ox / d;
        ny = oy / d;
        nz = oz / d;
      } else {
        ny = 1;
      }
    } else {
      const m = shape.m;
      const rx = px - shape.c[0]!;
      const ry = py - shape.c[1]!;
      const rz = pz - shape.c[2]!;
      const lx = m[0]! * rx + m[1]! * ry + m[2]! * rz;
      const ly = m[3]! * rx + m[4]! * ry + m[5]! * rz;
      const lz = m[6]! * rx + m[7]! * ry + m[8]! * rz;
      let lnx = 0;
      let lny = 0;
      let lnz = 0;
      if (shape.kind === 'box') {
        const qx = Math.abs(lx) - shape.h[0]! - margin;
        const qy = Math.abs(ly) - shape.h[1]! - margin;
        const qz = Math.abs(lz) - shape.h[2]! - margin;
        if (qx >= 0 || qy >= 0 || qz >= 0) continue;
        // Inside: leave through the nearest face.
        if (qx >= qy && qx >= qz) { depth = -qx; lnx = Math.sign(lx) || 1; }
        else if (qy >= qz) { depth = -qy; lny = Math.sign(ly) || 1; }
        else { depth = -qz; lnz = Math.sign(lz) || 1; }
      } else {
        const radial = Math.sqrt(lx * lx + lz * lz);
        const qr = radial - shape.h[0]! - margin;
        const qy = Math.abs(ly) - shape.h[1]! - margin;
        if (qr >= 0 || qy >= 0) continue;
        if (qr >= qy) {
          depth = -qr;
          if (radial > 1e-9) { lnx = lx / radial; lnz = lz / radial; } else { lnx = 1; }
        } else {
          depth = -qy;
          lny = Math.sign(ly) || 1;
        }
      }
      // Local → world is the transpose of m.
      nx = m[0]! * lnx + m[3]! * lny + m[6]! * lnz;
      ny = m[1]! * lnx + m[4]! * lny + m[7]! * lnz;
      nz = m[2]! * lnx + m[5]! * lny + m[8]! * lnz;
    }
    push(x, prev, k, nx, ny, nz, depth, friction);
    touched = true;
  }
  const ground = obstacles.ground;
  if (ground !== null && ground.contains(x[k]!, x[k + 2]!)) {
    const floor = ground.heightAt(x[k]!, x[k + 2]!) + margin;
    if (x[k + 1]! < floor) {
      push(x, prev, k, 0, 1, 0, floor - x[k + 1]!, friction);
      touched = true;
    }
  }
  return touched;
}

function push(x: Float64Array, prev: Float64Array, k: number, nx: number, ny: number, nz: number, depth: number, friction: number): void {
  x[k] = x[k]! + nx * depth;
  x[k + 1] = x[k + 1]! + ny * depth;
  x[k + 2] = x[k + 2]! + nz * depth;
  // Friction: take away a share of the motion along the surface this substep.
  const mx = x[k]! - prev[k]!;
  const my = x[k + 1]! - prev[k + 1]!;
  const mz = x[k + 2]! - prev[k + 2]!;
  const along = mx * nx + my * ny + mz * nz;
  const tx = mx - along * nx;
  const ty = my - along * ny;
  const tz = mz - along * nz;
  x[k] = x[k]! - tx * friction;
  x[k + 1] = x[k + 1]! - ty * friction;
  x[k + 2] = x[k + 2]! - tz * friction;
}
