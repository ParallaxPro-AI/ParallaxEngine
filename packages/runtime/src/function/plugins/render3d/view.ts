/**
 * Camera views for the frame. The visuals plugin owns the rigs and resolves each camera
 * (`camera.__view__`: pose, projection settings, which cameras are active); this module
 * turns every active view into the port's `View3d` — matrices for the surface's pixels.
 * The viewport comes from the camera's `viewport` fractions of the surface, so the view's
 * aspect always matches what is drawn. A camera's `depth_of_field` (visuals' render_schemas)
 * rides along as the view's `depthOfField`.
 */

/** The visuals plugin's depth-of-field component on a camera, read by id. */
const DEPTH_OF_FIELD = 'depth_of_field';

/** A camera's depth of field, or null when it has none (or blurs nothing). */
export function depthOfFieldOf(record: EntityRecord): DepthOfField3d | null {
  const dof = record.components.get(DEPTH_OF_FIELD);
  if (dof === undefined) return null;
  const maxBlur = dof['max_blur'] as number;
  if (!(maxBlur > 0)) return null;
  return { focusDistance: dof['focus_distance'] as number, focusRange: Math.max(0.01, dof['focus_range'] as number), maxBlur };
}

import { fail, Vec3 } from '../../../core/index.js';
import type { Color, ColorVision, DepthOfField3d, Quat, Rgba, View3d } from '../../../core/index.js';
import type { EntityRecord, World } from '../../kernel/index.js';
import { CAMERA, nameOf } from './draw.js';
import { invert, multiply, orthographic, perspective, viewMatrix } from '../../../resource/index.js';

/** The fields of visuals' CameraView that a 3D renderer uses. */
export interface CameraViewLike {
  readonly seat: number;
  readonly active: boolean;
  readonly dimension: '2d' | '3d';
  readonly mode: 'perspective' | 'orthographic';
  readonly position: Vec3;
  readonly rotation: Quat;
  readonly fov: number;
  readonly size: number;
  readonly near: number;
  readonly far: number;
  readonly background: Color | null;
}

/** A camera's resolved view (visuals' `camera.__view__`), PP9801 when the game has no visuals plugin. */
export function cameraViewOf(record: EntityRecord): CameraViewLike {
  const camera = record.components.get(CAMERA)!;
  const resolved = (camera as { __view__?: CameraViewLike }).__view__;
  if (resolved === undefined) {
    return fail('PP9801', `${nameOf(record)} camera has no __view__`, {
      fix: 'render3d draws through the views the visuals plugin resolves; build the game with it (createRuntime does).',
    });
  }
  if (resolved.dimension !== '3d') {
    fail('PP3811', 'render3d draws a 3D game, but the cameras are resolved for 2D', { fix: 'Use render2d for Game(mode="2d").' });
  }
  return resolved;
}

/** One camera's `View3d` for a viewport (pixels): matrices for its aspect, far plane clamped to `maxFar`. */
export function viewFor(
  record: EntityRecord, resolved: CameraViewLike, viewport: View3d['viewport'], colorVision: ColorVision, maxFar: number,
): View3d {
  const aspect = viewport.width / viewport.height;
  const q = resolved.rotation;
  const right = q.rotate(Vec3.RIGHT);
  const up = q.rotate(Vec3.UP);
  const forward = q.rotate(Vec3.FORWARD);
  const p = resolved.position;
  const eye = [p.x, p.y, p.z];
  const view = viewMatrix(eye, [right.x, right.y, right.z], [up.x, up.y, up.z], [forward.x, forward.y, forward.z]);
  const far = Math.max(resolved.near * 2, Math.min(resolved.far, maxFar));
  const projection = resolved.mode === 'perspective'
    ? perspective(resolved.fov, aspect, resolved.near, far)
    : orthographic(-resolved.size * aspect, resolved.size * aspect, -resolved.size, resolved.size, resolved.near, far);
  const viewProjection = multiply(projection, view);
  const inverse = invert(viewProjection);
  if (inverse === null) fail('PP3813', `${nameOf(record)} camera has a degenerate projection`, { fix: 'Give it a size or fov above 0.' });
  const background = resolved.background;
  const clear: Rgba | null = background === null ? null : [background.r, background.g, background.b, background.a];
  return {
    camera: record.id,
    viewport,
    position: [p.x, p.y, p.z],
    right: [right.x, right.y, right.z],
    up: [up.x, up.y, up.z],
    forward: [forward.x, forward.y, forward.z],
    view,
    projection,
    viewProjection,
    inverseViewProjection: inverse,
    near: resolved.near,
    far,
    clear,
    colorVision,
    depthOfField: depthOfFieldOf(record),
  };
}

/**
 * Every active camera's view for the surface, in seat order. `maxFar` is the quality's view
 * distance: a camera's far plane is clamped to it (the distance fog the surface adds hides
 * the edge).
 */
export function resolveViews(
  world: World, surface: { readonly width: number; readonly height: number }, colorVision: ColorVision = 'none', maxFar = Infinity,
): View3d[] {
  const views: { seat: number; view: View3d }[] = [];
  for (const record of world.live()) {
    const camera = record.components.get(CAMERA);
    if (camera === undefined) continue;
    const resolved = cameraViewOf(record);
    if (!resolved.active) continue;
    const fractions = camera['viewport'] as readonly number[];
    const viewport = {
      x: fractions[0]! * surface.width,
      y: fractions[1]! * surface.height,
      width: fractions[2]! * surface.width,
      height: fractions[3]! * surface.height,
    };
    if (!(viewport.width > 0 && viewport.height > 0)) continue;
    views.push({ seat: resolved.seat, view: viewFor(record, resolved, viewport, colorVision, maxFar) });
  }
  views.sort((a, b) => a.seat - b.seat);
  return views.map((v) => v.view);
}
