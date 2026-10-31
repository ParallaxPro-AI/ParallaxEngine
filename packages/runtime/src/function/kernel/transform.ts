/**
 * Every entity's transform: position, rotation and scale relative to its parent (or the
 * world, for roots). World-space values compose up the hierarchy.
 */

import { Quat, Vec3 } from '../../core/index.js';

export class TransformNode {
  position: Vec3 = Vec3.ZERO;
  rotation: Quat = Quat.IDENTITY;
  scale: Vec3 = Vec3.ONE;
  parent: TransformNode | null = null;

  worldRotation(): Quat {
    return this.parent === null ? this.rotation : this.parent.worldRotation().__mul__(this.rotation);
  }

  worldScale(): Vec3 {
    if (this.parent === null) return this.scale;
    const p = this.parent.worldScale();
    return new Vec3(p.x * this.scale.x, p.y * this.scale.y, p.z * this.scale.z);
  }

  /** A point in this transform's local space, in world space. */
  toWorld(local: Vec3): Vec3 {
    const scaled = new Vec3(local.x * this.scale.x, local.y * this.scale.y, local.z * this.scale.z);
    const inParent = this.rotation.rotate(scaled).__add__(this.position);
    return this.parent === null ? inParent : this.parent.toWorld(inParent);
  }

  worldPosition(): Vec3 {
    return this.parent === null ? this.position : this.parent.toWorld(this.position);
  }

  setWorldPosition(world: Vec3): void {
    this.position = this.parent === null ? world : this.parent.toLocal(world);
  }

  /** A world-space point in this transform's local space. */
  toLocal(world: Vec3): Vec3 {
    const inParent = this.parent === null ? world : this.parent.toLocal(world);
    const unrotated = this.rotation.inverse().rotate(inParent.__sub__(this.position));
    return new Vec3(unrotated.x / this.scale.x, unrotated.y / this.scale.y, unrotated.z / this.scale.z);
  }
}
