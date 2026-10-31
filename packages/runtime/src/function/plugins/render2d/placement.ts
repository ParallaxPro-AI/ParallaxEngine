/**
 * Where an entity is drawn: its world 2D transform (position, angle and scale composed up
 * the hierarchy), its draw order (world z: a child's z adds to its parent's) and whether
 * it shows (`visible`, and every ancestor visible). Computed once per entity per frame.
 */

import type { Affine2d, EntityId } from '../../../core/index.js';
import type { EntityRecord, World } from '../../kernel/index.js';
import type { RenderPoseSource } from '../../services/index.js';

export interface Placed2d {
  readonly m: Affine2d;
  readonly z: number;
  readonly scaleZ: number;
  readonly visible: boolean;
}

const ROOT: Placed2d = { m: [1, 0, 0, 1, 0, 0], z: 0, scaleZ: 1, visible: true };

export function compose(p: Affine2d, l: Affine2d): Affine2d {
  return [
    p[0] * l[0] + p[2] * l[1],
    p[1] * l[0] + p[3] * l[1],
    p[0] * l[2] + p[2] * l[3],
    p[1] * l[2] + p[3] * l[3],
    p[0] * l[4] + p[2] * l[5] + p[4],
    p[1] * l[4] + p[3] * l[5] + p[5],
  ];
}

/** Translate, rotate (degrees, counter-clockwise), scale — applied scale first. */
export function trs(x: number, y: number, degrees: number, sx: number, sy: number): Affine2d {
  const r = (degrees * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c * sx, s * sx, -s * sy, c * sy, x, y];
}

/** The angle (degrees) a world transform turns its local +x to. */
export function angleOf(m: Affine2d): number {
  return (Math.atan2(m[1], m[0]) * 180) / Math.PI;
}

/** Physics-moved entities are placed at their interpolated render pose (`poses`, the physics plugin's `render_pose` service). */
export class Placements {
  readonly #world: World;
  readonly #cache = new Map<EntityId, Placed2d>();
  readonly #source: () => RenderPoseSource | undefined;
  #poses: RenderPoseSource | undefined;

  constructor(world: World, poses: () => RenderPoseSource | undefined = () => undefined) {
    this.#world = world;
    this.#source = poses;
  }

  /** Forget last frame's placements (call once per frame, before reading any). */
  clear(): void {
    this.#cache.clear();
    this.#poses = this.#source();
  }

  of(record: EntityRecord): Placed2d {
    const cached = this.#cache.get(record.id);
    if (cached !== undefined) return cached;
    const parentRecord = record.parent === null ? undefined : this.#world.peek(record.parent);
    const parent = parentRecord === undefined ? ROOT : this.of(parentRecord);
    const t = record.transform;
    const pose = this.#poses?.local(record.id);
    const position = pose?.position ?? t.position;
    const local = trs(position.x, position.y, (pose?.rotation ?? t.rotation).angle(), t.scale.x, t.scale.y);
    const placed: Placed2d = {
      m: compose(parent.m, local),
      z: parent.z + parent.scaleZ * t.position.z,
      scaleZ: parent.scaleZ * t.scale.z,
      visible: parent.visible && record.visible,
    };
    this.#cache.set(record.id, placed);
    return placed;
  }
}
