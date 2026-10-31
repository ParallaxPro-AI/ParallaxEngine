/**
 * Render to texture: camera feeds and planar mirrors, drawn by the surface as offscreen
 * views (`Frame3d.offscreen`) before the screen, and sampled by materials through a
 * texture whose source is the target (`TextureSource` kind 'target').
 *
 *   feeds     a camera with a `render_texture` draws into the texture `name` (`width` ×
 *             `height`) `fps` times a second (0: every frame) instead of a seat's screen; a
 *             `monitor` shows it on its entity's Shape, or on its Model's materials (one
 *             named `material`, else all), as a glowing screen
 *   mirrors   a `mirror` reflects the scene for the first screen view: the view's camera
 *             reflected across the mirror's plane (the entity's up axis through its origin),
 *             with an oblique near plane on the mirror so nothing behind it shows, drawn at
 *             `resolution` of the view's size; the mirror's surface samples it where each
 *             fragment lands on screen (`Material3d.projected`), tinted. Seen from behind, a
 *             mirror draws nothing extra.
 *
 * At most `quality.offscreenPerFrame` views are redrawn per frame: mirrors first, then the
 * feeds that are most overdue; the rest keep their last image.
 */

import type { ColorVision, Material3d, OffscreenView3d, Quality3d, Texture3d, View3d } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import { invert, multiply } from '../../../resource/index.js';
import type { M4 } from '../../../resource/index.js';
import type { EntityRecord, World } from '../../kernel/index.js';
import { finite, nameOf, rgba } from './draw.js';
import { cameraViewOf, viewFor } from './view.js';

export const RENDER_TEXTURE = 'render_texture';
export const MONITOR = 'monitor';
export const MIRROR = 'mirror';

/** The texture a render target is sampled through. */
export function targetTexture(name: string): Texture3d {
  return { id: `target:${name}`, source: { kind: 'target', target: name }, colorSpace: 'srgb', wrapU: 'clamp', wrapV: 'clamp', filter: 'linear' };
}

/** The target id of a mirror entity's reflection. */
export function mirrorTarget(entity: EntityId): string {
  return `mirror:${entity}`;
}

/**
 * A view reflected across the plane through `point` with unit `normal` (the mirror's front):
 * its camera mirrored, an oblique near plane on the mirror, `mirrored` set (front faces wind
 * the other way). Null when the eye is behind the mirror.
 */
export function reflectView(view: View3d, point: readonly number[], normal: readonly number[], viewport: View3d['viewport'], camera: number): View3d | null {
  const [nx, ny, nz] = normal as [number, number, number];
  const d = nx * point[0]! + ny * point[1]! + nz * point[2]!;
  const side = nx * view.position[0] + ny * view.position[1] + nz * view.position[2] - d;
  if (side <= 1e-4) return null;
  // World → world reflection: x' = x − 2 (n·x − d) n.
  const r = new Float32Array([
    1 - 2 * nx * nx, -2 * ny * nx, -2 * nz * nx, 0,
    -2 * nx * ny, 1 - 2 * ny * ny, -2 * nz * ny, 0,
    -2 * nx * nz, -2 * ny * nz, 1 - 2 * nz * nz, 0,
    2 * d * nx, 2 * d * ny, 2 * d * nz, 1,
  ]);
  const reflectDir = (v: readonly number[]): [number, number, number] => {
    const k = 2 * (nx * v[0]! + ny * v[1]! + nz * v[2]!);
    return [v[0]! - k * nx, v[1]! - k * ny, v[2]! - k * nz];
  };
  const eye = view.position;
  const k = 2 * (nx * eye[0] + ny * eye[1] + nz * eye[2] - d);
  const position: [number, number, number] = [eye[0] - k * nx, eye[1] - k * ny, eye[2] - k * nz];
  const reflectedView = multiply(view.view, r);
  // The mirror plane in the reflected camera's space, kept side positive.
  const inverseView = invert(reflectedView);
  if (inverseView === null) return null;
  const world = [nx, ny, nz, -d];
  const plane = [0, 1, 2, 3].map((c) => world[0]! * inverseView[c * 4]! + world[1]! * inverseView[c * 4 + 1]! + world[2]! * inverseView[c * 4 + 2]! + world[3]! * inverseView[c * 4 + 3]!);
  const aspect = viewport.width / viewport.height;
  const projection = obliqueProjection(view.projection, plane, view.viewport.width / view.viewport.height, aspect);
  const viewProjection = multiply(projection, reflectedView);
  const inverse = invert(viewProjection);
  if (inverse === null) return null;
  return {
    ...view, camera, viewport, position, right: reflectDir(view.right), up: reflectDir(view.up), forward: reflectDir(view.forward),
    view: reflectedView, projection, viewProjection, inverseViewProjection: inverse, overlay: null, fogOfWar: null, mirrored: true,
  };
}

/**
 * A projection whose near plane is `plane` (view space, its kept side positive): Lengyel's
 * oblique frustum for clip depth 0..1 — the depth row becomes the plane, scaled so the far
 * corner of the frustum keeps depth 1. `aspect` re-fits the projection to the target.
 */
export function obliqueProjection(projection: ArrayLike<number>, plane: readonly number[], fromAspect: number, toAspect: number): M4 {
  const p = Float32Array.from(projection as ArrayLike<number>);
  p[0] = p[0]! * (fromAspect / toAspect);
  const inverse = invert(p);
  if (inverse === null) return p;
  const sx = Math.sign(plane[0]!) || 1;
  const sy = Math.sign(plane[1]!) || 1;
  const corner = [sx, sy, 1, 1];
  const q = [0, 1, 2, 3].map((r) => inverse[r]! * corner[0]! + inverse[4 + r]! * corner[1]! + inverse[8 + r]! * corner[2]! + inverse[12 + r]! * corner[3]!);
  const scale = 1 / (plane[0]! * q[0]! + plane[1]! * q[1]! + plane[2]! * q[2]! + plane[3]! * q[3]!);
  for (let c = 0; c < 4; c++) p[c * 4 + 2] = plane[c]! * scale;
  return p;
}

export class RenderTargets {
  readonly #world: World;
  /** Real seconds each feed is next due. */
  readonly #due = new Map<string, number>();
  /** This frame's mirrors by entity (their surfaces sample the reflection). */
  #mirrors = new Set<EntityId>();

  constructor(world: World) {
    this.#world = world;
  }

  /** Whether an entity draws as a mirror this frame. */
  isMirror(entity: EntityId): boolean {
    return this.#mirrors.has(entity);
  }

  /**
   * This frame's offscreen views. `placed` gives an entity's world matrix; `first` is the
   * first screen view (mirrors reflect it); `now` is real seconds (feed rates).
   */
  frame(first: View3d | undefined, quality: Quality3d, colorVision: ColorVision, now: number, placed: (record: EntityRecord) => ArrayLike<number>): OffscreenView3d[] {
    const mirrors: OffscreenView3d[] = [];
    const feeds: { view: OffscreenView3d; lateness: number }[] = [];
    this.#mirrors = new Set();
    for (const [id, fields] of this.#world.query([MIRROR])) {
      const record = this.#world.get(id)!;
      if (first === undefined || !record.visible) continue;
      const where = `${nameOf(record)} mirror`;
      const resolution = finite(fields!['resolution'], `${where}.resolution`);
      const m = placed(record);
      const ny = [m[4]!, m[5]!, m[6]!];
      const l = Math.hypot(ny[0]!, ny[1]!, ny[2]!) || 1;
      const width = Math.max(16, Math.round(first.viewport.width * resolution));
      const height = Math.max(16, Math.round(first.viewport.height * resolution));
      const view = reflectView(first, [m[12]!, m[13]!, m[14]!], ny.map((c) => c / l), { x: 0, y: 0, width, height }, -(id + 1));
      // Seen from behind there is no reflection: the surface keeps its own look.
      if (view === null) continue;
      this.#mirrors.add(id);
      mirrors.push({ target: mirrorTarget(id), width, height, view, due: true });
    }
    for (const [id, fields] of this.#world.query([RENDER_TEXTURE])) {
      const record = this.#world.get(id)!;
      if (!record.components.has('camera')) continue;
      const where = `${nameOf(record)} render_texture`;
      const name = fields!['name'];
      if (typeof name !== 'string' || name === '') continue;
      const width = finite(fields!['width'], `${where}.width`);
      const height = finite(fields!['height'], `${where}.height`);
      finite(fields!['fps'], `${where}.fps`);
      const next = this.#due.get(name) ?? now;
      const view = viewFor(record, cameraViewOf(record), { x: 0, y: 0, width, height }, colorVision, quality.viewDistance);
      feeds.push({ view: { target: name, width, height, view, due: now >= next }, lateness: now - next });
    }
    const budget = quality.offscreenPerFrame;
    const chosen = new Set<OffscreenView3d>(mirrors.slice(0, budget));
    for (const f of [...feeds].filter((x) => x.view.due).sort((a, b) => b.lateness - a.lateness)) {
      if (chosen.size >= budget) break;
      chosen.add(f.view);
    }
    for (const f of feeds) {
      if (!chosen.has(f.view)) continue;
      const fields = this.#world.get(f.view.view.camera as EntityId)!.components.get(RENDER_TEXTURE)!;
      const fps = fields['fps'] as number;
      this.#due.set(f.view.target, fps > 0 ? Math.max((this.#due.get(f.view.target) ?? now) + 1 / fps, now) : now);
    }
    return [...mirrors, ...feeds.map((f) => f.view)].map((v) => (chosen.has(v) ? v : { ...v, due: false }));
  }

  /** A monitor's or mirror's look of a material: the feed glowing on it, or the reflection projected onto it, tinted. */
  static screen(material: Material3d, feed: Texture3d, brightness: number): Material3d {
    const b = Math.min(1, Math.max(0, brightness));
    return {
      ...material, id: `${material.id}|feed:${feed.id}|${b}`, baseColor: [0, 0, 0, 1], baseColorTexture: null, emissive: [b, b, b], emissiveTexture: feed,
      metallic: 0, roughness: 0.25, alphaMode: 'opaque', unlit: false,
    };
  }

  static mirror(material: Material3d, reflection: Texture3d, tint: readonly number[]): Material3d {
    return {
      ...material, id: `${material.id}|mirror:${reflection.id}|${tint.join(',')}`, baseColor: [tint[0]!, tint[1]!, tint[2]!, 1],
      baseColorTexture: reflection, emissiveTexture: null, emissive: [0, 0, 0], alphaMode: 'opaque', unlit: true, projected: true,
    };
  }
}

/** A monitor or mirror's material swap for an entity this frame, or null. */
export function surfaceSwap(record: EntityRecord, targets: RenderTargets): ((material: Material3d, name: string | null) => Material3d) | null {
  const monitor = record.components.get(MONITOR);
  if (monitor !== undefined) {
    const where = `${nameOf(record)} monitor`;
    const feed = monitor['feed'];
    if (typeof feed !== 'string' || feed === '') return null;
    const texture = targetTexture(feed);
    const brightness = finite(monitor['brightness'], `${where}.brightness`);
    const only = monitor['material'] as string | null;
    return (material, name) => (only !== null && name !== only ? material : RenderTargets.screen(material, texture, brightness));
  }
  if (record.components.has(MIRROR) && targets.isMirror(record.id)) {
    const tint = rgba(record.components.get(MIRROR)!['tint'], `${nameOf(record)} mirror.tint`);
    const texture = targetTexture(mirrorTarget(record.id));
    return (material) => RenderTargets.mirror(material, texture, tint);
  }
  return null;
}
