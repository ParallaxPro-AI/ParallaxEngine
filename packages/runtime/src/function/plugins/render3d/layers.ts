/**
 * First-person view layers (the viewmodel plugin's `viewmodel.__view_layer__`, read by
 * component id): a Viewmodel entity's subtree — arms, the held item — is drawn on the
 * `viewmodel` layer, only in its camera's view, through that view's own overlay
 * projection (the layer's field of view and near plane, eased by aiming), in front of the
 * world so a gun held against a wall never clips into it, lit like the world and casting
 * no shadows. In that view only, the owner's body is drawn with the layer's Model options
 * (`bodyOptions`, e.g. a headless variant) or not at all (`hideBody`); every other view
 * (split screen, mirrors, camera feeds) and the shadow maps see the body as it is.
 */

import { fail, VIEWMODEL_DEPTH } from '../../../core/index.js';
import type { EntityId, View3d, ViewOverlay3d } from '../../../core/index.js';
import { invert, multiply, perspective } from '../../../resource/index.js';
import type { EntityRecord, World } from '../../kernel/index.js';
import type { DrawStyle } from './draw.js';
import { nameOf, WORLD_DRAW } from './draw.js';

export const VIEWMODEL = 'viewmodel';

/** What render3d reads of the viewmodel plugin's `ViewLayer` (structurally). */
interface ViewLayerLike {
  readonly camera: EntityId;
  readonly fov: number;
  readonly near: number;
  readonly body: EntityId | null;
  readonly bodyOptions: Readonly<Record<string, string>>;
  readonly hideBody: boolean;
}

/**
 * A view's overlay projection: `fov` and `near` from the same eye, its clip depth squeezed
 * to 0..`VIEWMODEL_DEPTH` so what it draws is in front of the world's depth (0..1) without
 * clearing it — the post passes still see the world's depth around the viewmodel.
 */
export function overlayOf(view: View3d, fov: number, near: number): ViewOverlay3d {
  const aspect = view.viewport.width / view.viewport.height;
  const far = Math.max(near * 2, Math.min(view.far, near * 1e4));
  const projection = perspective(fov, aspect, near, far);
  for (const i of [2, 6, 10, 14]) projection[i] = projection[i]! * VIEWMODEL_DEPTH;
  const viewProjection = multiply(projection, view.view);
  const inverse = invert(viewProjection);
  if (inverse === null) fail('PP3813', `The viewmodel overlay of camera ${view.camera} has a degenerate projection`, { fix: 'Give the Viewmodel a fov and near plane above 0.' });
  return { projection, viewProjection, inverseViewProjection: inverse, near, far };
}

export class ViewLayers {
  readonly #world: World;
  /** This frame's layers, by Viewmodel entity. */
  #layers = new Map<EntityId, ViewLayerLike>();
  /** Bodies seen through their own first-person camera, and the layer that owns them. */
  #bodies = new Map<EntityId, ViewLayerLike>();
  /** Each entity's Viewmodel ancestor (or itself), null when none; this frame. */
  readonly #roots = new Map<EntityId, EntityId | null>();

  constructor(world: World) {
    this.#world = world;
  }

  /** Read every Viewmodel's layer (call once per frame, before drawing). */
  frame(): void {
    this.#layers = new Map();
    this.#bodies = new Map();
    this.#roots.clear();
    for (const [id, fields] of this.#world.query([VIEWMODEL])) {
      const layer = (fields as { __view_layer__?: ViewLayerLike }).__view_layer__;
      if (layer === undefined) {
        fail('PP9801', `${nameOf(this.#world.get(id)!)} viewmodel has no __view_layer__`, {
          fix: 'render3d draws the view layer the viewmodel plugin resolves; add viewmodel() to Game(plugins=[...]).',
        });
      }
      this.#layers.set(id, layer);
      if (layer.body !== null) this.#bodies.set(layer.body, layer);
    }
  }

  get active(): boolean {
    return this.#layers.size > 0;
  }

  #root(record: EntityRecord): EntityId | null {
    const known = this.#roots.get(record.id);
    if (known !== undefined) return known;
    let root: EntityId | null = null;
    if (this.#layers.has(record.id)) root = record.id;
    else if (record.parent !== null) {
      const parent = this.#world.peek(record.parent);
      root = parent === undefined ? null : this.#root(parent);
    }
    this.#roots.set(record.id, root);
    return root;
  }

  /** How an entity's meshes are drawn: on a viewmodel layer, as a body hidden from its own view, or plainly. */
  styleOf(record: EntityRecord): DrawStyle {
    if (this.#layers.size === 0) return WORLD_DRAW;
    const root = this.#root(record);
    if (root !== null) return { layer: 'viewmodel', views: { only: this.#layers.get(root)!.camera }, fade: 1, shadows: false };
    const body = this.#bodies.get(record.id);
    if (body !== undefined) return { ...WORLD_DRAW, views: { except: body.camera } };
    return WORLD_DRAW;
  }

  /** A body's own-view copy: drawn only in its first-person camera's view, with the layer's Model options, casting no shadow. Null: none (or hidden). */
  bodyView(record: EntityRecord): { readonly style: DrawStyle; readonly options: Readonly<Record<string, string>> } | null {
    const body = this.#bodies.get(record.id);
    if (body === undefined || body.hideBody) return null;
    return { style: { layer: 'world', views: { only: body.camera }, fade: 1, shadows: false }, options: body.bodyOptions };
  }

  /** The views with their overlays: each camera a Viewmodel overlays gets its projection. */
  withOverlays(views: readonly View3d[]): View3d[] {
    if (this.#layers.size === 0) return [...views];
    const byCamera = new Map<EntityId, ViewLayerLike>();
    for (const layer of this.#layers.values()) byCamera.set(layer.camera, layer);
    return views.map((view) => {
      const layer = byCamera.get(view.camera as EntityId);
      return layer === undefined ? view : { ...view, overlay: overlayOf(view, layer.fov, layer.near) };
    });
  }
}
