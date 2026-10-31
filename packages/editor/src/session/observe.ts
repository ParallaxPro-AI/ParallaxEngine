/**
 * Observation: what a running game shows, as plain JSON, for the AI game builder and for
 * tests — the camera (pose, projection, matrices), every entity with its world bounds and
 * its box on screen as drawn in the last frame, and the open panels with their actions.
 * The shape is `contracts/observation.schema.json` (format "parallax.observation" v1).
 *
 * Boxes come from the renderer's own frame (`drawn.ts`): an entity is on screen when
 * something of it was drawn inside the viewport, so an observer can trust "visible" the
 * way a player would. In a browser, `@parallax/editor/session/browser` adds each panel's
 * controls with their clickable regions (real DOM hit testing).
 */

import { Vec3 } from '@parallax/runtime/core';
import type { GameRuntime } from '@parallax/runtime/api';
import type { EntityId } from '@parallax/runtime/core';
import { boundsOf, drawnFrame, viewOf, worldCorners } from './drawn.js';
import type { Box3, DrawnFrame } from './drawn.js';
import { screenBoxes } from './picking.js';
import type { PixelRect, ScreenView } from './view_math.js';

export const OBSERVATION_FORMAT = 'parallax.observation';
export const OBSERVATION_VERSION = 1;

export type Xyz = [number, number, number];

export interface ObservedCamera {
  readonly entity: number | null;
  readonly dimension: '2d' | '3d';
  readonly perspective: boolean;
  readonly position: Xyz;
  readonly right: Xyz;
  readonly up: Xyz;
  readonly forward: Xyz;
  /** Surface pixels. */
  readonly viewport: PixelRect;
  readonly near: number | null;
  readonly far: number | null;
  /** Vertical field of view in degrees (perspective), else null. */
  readonly fov: number | null;
  /** Column-major 4×4 world → clip (depth 0..1). */
  readonly viewProjection: readonly number[];
  readonly view: readonly number[] | null;
  readonly projection: readonly number[] | null;
}

export interface ObservedEntity {
  readonly id: number;
  readonly placedId: string | null;
  readonly prefab: string | null;
  readonly name: string | null;
  readonly parent: number | null;
  readonly tags: readonly string[];
  readonly components: readonly string[];
  readonly behaviors: readonly string[];
  /** `entity.visible` as set (authored or by game code). */
  readonly visible: boolean;
  readonly position: Xyz;
  /** Something of it was drawn last frame. */
  readonly drawn: boolean;
  /** World-space box around what was drawn. */
  readonly bounds: { readonly min: Xyz; readonly max: Xyz } | null;
  /** Its drawn box on screen, clipped to nothing: may extend past the viewport. */
  readonly screen: PixelRect | null;
  readonly center: readonly [number, number] | null;
  /** Its drawn box overlaps the viewport. */
  readonly onScreen: boolean;
}

export interface ObservedAction {
  readonly name: string;
  readonly kind: 'command' | 'call';
  /** False while a function action's `when=` is false. */
  readonly enabled: boolean;
}

/** A panel control found in the page (browser only): where it is and whether a click reaches it. */
export interface ObservedControl {
  readonly action: string;
  readonly text: string;
  /** Page pixels (CSS), top-left origin. */
  readonly rect: PixelRect;
  /** A click at `point` reaches this control (not covered, not disabled, visible). */
  readonly clickable: boolean;
  readonly point: readonly [number, number] | null;
  /** Why it isn't clickable. */
  readonly reason: string | null;
}

export interface ObservedPanel {
  readonly id: string;
  readonly html: string;
  readonly layer: string;
  readonly modal: boolean;
  readonly actions: readonly ObservedAction[];
  /** The panel's `state()` for seat 0, as JSON (other values as their text). */
  readonly state: unknown;
  /** Present in a browser observation. */
  readonly controls?: readonly ObservedControl[];
}

export interface Observation {
  readonly format: typeof OBSERVATION_FORMAT;
  readonly version: typeof OBSERVATION_VERSION;
  readonly scene: string | null;
  readonly time: { readonly frame: number; readonly now: number; readonly scale: number; readonly frozen: boolean; readonly logic: boolean };
  /** The kernel frame the renderer last drew (null before the first). */
  readonly drawnFrame: number | null;
  readonly screen: { readonly width: number; readonly height: number };
  readonly camera: ObservedCamera | null;
  readonly entities: readonly ObservedEntity[];
  readonly panels: readonly ObservedPanel[];
}

export interface ObserveOptions {
  /** Whose view to describe (an editor camera); default the first drawn view. */
  readonly camera?: number | null;
  /** Entities left out (editor helpers). */
  readonly exclude?: (id: EntityId) => boolean;
  /** "drawn": only entities something was drawn for (default "all"). */
  readonly entities?: 'all' | 'drawn';
}

const xyz = (v: Vec3): Xyz => [v.x, v.y, v.z];

function cameraOf(view: ScreenView, frame: DrawnFrame, runtime: GameRuntime): ObservedCamera {
  const v3 = runtime.render3d?.lastFrame?.views.find((v) => v.camera === view.camera);
  const projection = v3 === undefined ? null : Array.from(v3.projection);
  const fov = projection !== null && view.perspective ? (2 * Math.atan(1 / projection[5]!) * 180) / Math.PI : null;
  return {
    entity: view.camera,
    dimension: frame.dimension,
    perspective: view.perspective,
    position: xyz(view.position),
    right: xyz(view.right),
    up: xyz(view.up),
    forward: xyz(view.forward),
    viewport: view.viewport,
    near: Number.isFinite(view.near) ? view.near : null,
    far: Number.isFinite(view.far) ? view.far : null,
    fov,
    viewProjection: [...view.viewProjection],
    view: v3 === undefined ? null : Array.from(v3.view),
    projection,
  };
}

/** JSON-safe copy of panel state: numbers, text, booleans, lists and dicts; anything else as its text. */
export function jsonSafe(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (depth > 6) return '…';
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => jsonSafe(v, depth + 1));
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, jsonSafe(v, depth + 1)]));
    }
    const repr = (value as { __repr__?: () => string }).__repr__;
    return typeof repr === 'function' ? repr.call(value) : String(value);
  }
  return String(value);
}

function panels(runtime: GameRuntime): ObservedPanel[] {
  const engine = runtime.uiEngine;
  return engine.openPanels.map(({ decl }) => {
    const view = engine.view(decl);
    const actions: ObservedAction[] = [...decl.actions].map(([name, action]) => ({
      name, kind: action.kind, enabled: view?.enabled[name] !== false,
    }));
    return { id: decl.id, html: decl.html, layer: decl.layer, modal: decl.modal, actions, state: jsonSafe(view?.states[0] ?? null) };
  });
}

/** Observe a running game between frames. */
export function observe(runtime: GameRuntime, options: ObserveOptions = {}): Observation {
  const kernel = runtime.kernel;
  const frame = drawnFrame(runtime);
  const view = frame === null ? null : viewOf(frame, options.camera ?? null);
  const corners = new Map<EntityId, Vec3[]>();
  for (const shape of frame?.shapes ?? []) {
    const list = corners.get(shape.entity) ?? [];
    list.push(...worldCorners(shape));
    corners.set(shape.entity, list);
  }
  const boxes = frame !== null && view !== null ? screenBoxes(frame, view) : new Map<EntityId, PixelRect>();
  const entities: ObservedEntity[] = [];
  for (const record of kernel.world.live()) {
    if (options.exclude?.(record.id) === true) continue;
    const drawn = corners.has(record.id);
    if (options.entities === 'drawn' && !drawn) continue;
    const bounds: Box3 | null = drawn ? boundsOf(corners.get(record.id)!) : null;
    const screen = boxes.get(record.id) ?? null;
    const vp = view?.viewport;
    const onScreen = screen !== null && vp !== undefined
      && screen.x <= vp.x + vp.width && screen.x + screen.width >= vp.x && screen.y <= vp.y + vp.height && screen.y + screen.height >= vp.y;
    entities.push({
      id: record.id,
      placedId: record.placedId ?? null,
      prefab: record.prefab ?? null,
      name: record.name ?? null,
      parent: record.parent,
      tags: [...record.tags],
      components: [...record.components.keys()],
      behaviors: record.behaviors.map((b) => b.def.id),
      visible: record.visible,
      position: xyz(record.transform.worldPosition()),
      drawn,
      bounds: bounds === null ? null : { min: xyz(bounds.min), max: xyz(bounds.max) },
      screen,
      center: screen === null ? null : [screen.x + screen.width / 2, screen.y + screen.height / 2],
      onScreen,
    });
  }
  const t = kernel.time;
  return {
    format: OBSERVATION_FORMAT,
    version: OBSERVATION_VERSION,
    scene: kernel.scene?.id ?? null,
    time: { frame: t.frame, now: t.now, scale: t.scale, frozen: t.frozen, logic: kernel.logic },
    drawnFrame: frame?.frame ?? null,
    screen: { width: runtime.visuals.screen.width, height: runtime.visuals.screen.height },
    camera: view === null || frame === null ? null : cameraOf(view, frame, runtime),
    entities,
    panels: panels(runtime),
  };
}
