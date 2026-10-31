/**
 * The 2D view: what the active camera shows, resolved against the surface's aspect.
 *
 * The camera rig (follow, smoothing, bounds, shake, `ctx.camera.use`) belongs to the
 * visuals plugin, which places the camera ENTITY; this module only projects. It reads the
 * `camera` component by id with the SDK's field names:
 *
 *   mode        must be "orthographic" in a 2D game (PP3605)
 *   size        half-height in meters of the visible area
 *   fit         a world rectangle [min, max] kept fully visible at any aspect (the view
 *               centers on it), or "grid": the scene's first `grid` (ignored without one)
 *   fit_margin  extra meters around `fit`
 *   min_visible a (width, height) in meters kept in view at any aspect: the half-height
 *               grows until both fit (on top of `size` / `fit`; a portrait screen widens
 *               the view to keep the width)
 *   background  clear color (None: the scene's sky — the environment's `clear` colour, given
 *               as `sky`; transparent when no environment provides one)
 *   viewport    (x, y, w, h) fractions of the surface
 *
 * Without `fit`, the view centers on the camera entity's world position, plus the rig's
 * transient offset (shake), turned by its world angle.
 */

import { fail, Vec2, Vec3 } from '../../../core/index.js';
import type { Color, EntityId, View2d } from '../../../core/index.js';
import type { Fields, World } from '../../kernel/index.js';
import { angleOf } from './placement.js';
import type { Placements } from './placement.js';
import { describe, rgba } from './values.js';

export const CAMERA = 'camera';
export const GRID = 'grid';

/** What the visuals plugin tells the renderer each frame (boot wires it in). */
export interface CameraRig2d {
  /** The active camera entity (`ctx.camera.main`), or undefined when there is none. */
  active(): EntityId | undefined;
  /** A transient offset in world meters added to the view (shake, kick); [0, 0] at rest. */
  offset(camera: EntityId): readonly [number, number];
}

/** The rig a game without a visuals rig gets: the first camera in spawn order, no offset. */
export function firstCameraRig(world: World): CameraRig2d {
  return {
    active: () => world.query([CAMERA])[0]?.[0],
    offset: () => [0, 0],
  };
}

type Rect = readonly [minX: number, minY: number, maxX: number, maxY: number];

function point(value: unknown, where: string): [number, number] {
  if (value instanceof Vec2 || value instanceof Vec3) return [value.x, value.y];
  if (Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === 'number')) return [value[0] as number, value[1] as number];
  return fail('PP3606', `${where} must be a Vec2, got ${describe(value)}`);
}

function gridRect(world: World, placements: Placements): Rect | undefined {
  const row = world.query([GRID])[0];
  if (row === undefined) return undefined;
  const [id, grid] = row as [EntityId, Fields];
  if (grid['plane'] !== 'xy') {
    fail('PP3606', 'camera fit "grid" needs a grid on the "xy" plane in a 2D game', { fix: 'Set the grid\'s plane to "xy".' });
  }
  const [cw, ch] = point(grid['cell_size'], 'grid.cell_size');
  const w = (grid['cols'] as number) * cw;
  const h = (grid['rows'] as number) * ch;
  const m = placements.of(world.require(id)).m;
  const x = m[4];
  const y = m[5];
  if (grid['origin'] === 'center') return [x - w / 2, y - h / 2, x + w / 2, y + h / 2];
  // corner: the entity is the outer corner of cell (0, 0) — top-left when row 0 is the top row.
  return grid['row_order'] === 'up' ? [x, y, x + w, y + h] : [x, y - h, x + w, y];
}

function fitRect(fit: unknown, world: World, placements: Placements): Rect | undefined {
  if (fit === null || fit === undefined) return undefined;
  if (fit === 'grid') return gridRect(world, placements);
  if (!Array.isArray(fit) || fit.length !== 2) {
    return fail('PP3606', `camera.fit must be (min, max) corners or "grid", got ${describe(fit)}`, {
      fix: 'Write "fit": [[x0, y0], [x1, y1]] or "fit": "grid".',
    });
  }
  const [a, b] = [point(fit[0], 'camera.fit min'), point(fit[1], 'camera.fit max')];
  if (!(a[0] < b[0] && a[1] < b[1])) {
    fail('PP3606', `camera.fit is [[${a.join(', ')}], [${b.join(', ')}]]; the first corner must be below and left of the second`);
  }
  return [a[0], a[1], b[0], b[1]];
}

function viewport(value: unknown): View2d['viewport'] {
  if (Array.isArray(value) && value.length === 4 && value.every((n) => typeof n === 'number' && n >= 0 && n <= 1)) {
    const [x, y, w, h] = value as [number, number, number, number];
    if (w > 0 && h > 0) return [x, y, w, h];
  }
  return fail('PP3606', `camera.viewport must be (x, y, width, height) fractions of the screen, got ${describe(value)}`, {
    fix: 'Use (0, 0, 1, 1) for the whole screen.',
  });
}

export function resolveView(
  world: World, placements: Placements, cameraId: EntityId | undefined, offset: readonly [number, number],
  surface: { readonly width: number; readonly height: number },
  sky: () => Color | undefined = () => undefined,
): View2d {
  const record = cameraId === undefined ? undefined : world.get(cameraId);
  const camera = record?.components.get(CAMERA);
  if (record === undefined || camera === undefined) {
    return fail('PP3604', 'This 2D scene has no camera to draw through', {
      fix: 'Place an entity with a camera component ({"camera": {"mode": "orthographic", "size": 5}}) in the scene.',
    });
  }
  if (camera['mode'] !== 'orthographic') {
    fail('PP3605', `A 2D game draws through an orthographic camera; this one is "${String(camera['mode'])}"`, {
      fix: 'Set the camera\'s "mode" to "orthographic".',
    });
  }
  const port = viewport(camera['viewport']);
  const aspect = (surface.width * port[2]) / (surface.height * port[3]);
  const clear = camera['background'] ?? sky() ?? null;
  const background = clear === null ? null : rgba(clear, 'camera.background');
  const placed = placements.of(record);
  const rect = fitRect(camera['fit'], world, placements);
  let center: [number, number];
  let halfHeight: number;
  if (rect !== undefined) {
    const margin = camera['fit_margin'] as number;
    const w = rect[2] - rect[0] + 2 * margin;
    const h = rect[3] - rect[1] + 2 * margin;
    center = [(rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2];
    halfHeight = Math.max(h / 2, w / 2 / aspect);
  } else {
    center = [placed.m[4], placed.m[5]];
    halfHeight = camera['size'] as number;
    if (!(halfHeight > 0)) {
      fail('PP3606', `camera.size is ${halfHeight}; a 2D camera needs a half-height above 0`, { fix: 'Set "size" (meters from the center to the top edge).' });
    }
  }
  const minVisible = camera['min_visible'];
  if (minVisible !== null && minVisible !== undefined) {
    const [w, h] = point(minVisible, 'camera.min_visible');
    halfHeight = Math.max(halfHeight, Math.max(0, h) / 2, Math.max(0, w) / 2 / aspect);
  }
  return {
    center: [center[0] + offset[0], center[1] + offset[1]],
    halfHeight,
    angle: angleOf(placed.m),
    background,
    viewport: port,
  };
}

