/**
 * 2D lighting from the scene's `light` components (the visuals plugin's Light, read by id):
 *
 *   point        a pool of light, (1 - d / range)² · intensity, in its color
 *   spot         the same, inside a cone of `angle` degrees around the entity's +x axis
 *   directional  no position in 2D: adds its color × intensity to the ambient light
 *
 * The scene is multiplied by the light map, so lights reveal colors up to their authored
 * brightness; the ambient (the environment's, plus directional lights) is the floor. A
 * scene with no Light component has no lighting at all (drawn as authored).
 *
 * `lightAt` is the light map's value at a point — the surfaces draw this function
 * (Canvas2D: radial gradients with `LIGHT_FALLOFF_STOPS`), and tests check it.
 */

import type { Light2d, Lighting2d } from '../../../core/index.js';
import type { Color } from '../../../core/index.js';
import type { Fields, World } from '../../kernel/index.js';
import { lightShare } from '../../services/index.js';
import type { ResolvedEnvironment } from '../../services/index.js';
import { angleOf } from './placement.js';
import type { Placements } from './placement.js';
import { finite } from './values.js';

export const LIGHT = 'light';

/** Ambient light when the scene has no environment provider. */
export const DEFAULT_AMBIENT_2D: readonly [number, number, number] = [0.25, 0.25, 0.3];

function rgb(value: unknown): [number, number, number] {
  const c = value as Color;
  return [c.r, c.g, c.b];
}

/**
 * The frame's lighting, or null when no visible entity has a Light. A light's `when` scales
 * its intensity by the environment's day/night (`lightShare`); one that is out still counts
 * (the scene stays lit by its ambient, dark at night).
 */
export function lighting2d(
  world: World, placements: Placements, ambient: readonly [number, number, number] | undefined,
  environment?: Pick<ResolvedEnvironment, 'isNight' | 'night'>,
): Lighting2d | null {
  const lights: Light2d[] = [];
  const base = [...(ambient ?? DEFAULT_AMBIENT_2D)] as [number, number, number];
  let any = false;
  for (const [id, light] of world.query([LIGHT])) {
    const record = world.get(id)!;
    const at = placements.of(record);
    if (!at.visible) continue;
    any = true;
    const f = light as Fields;
    const color = rgb(f['color']);
    const intensity = finite(f['intensity'], `entity ${id} light.intensity`) * lightShare(f['when'], environment);
    if (intensity <= 0) continue;
    if (f['kind'] === 'directional') {
      for (let k = 0; k < 3; k++) base[k] = base[k]! + color[k]! * intensity;
      continue;
    }
    lights.push({
      kind: f['kind'] === 'spot' ? 'spot' : 'point',
      x: at.m[4], y: at.m[5], color, intensity,
      radius: finite(f['range'], `entity ${id} light.range`),
      direction: angleOf(at.m),
      cone: finite(f['angle'], `entity ${id} light.angle`),
      ...(typeof f['inner_angle'] === 'number' && { inner: Math.min(f['inner_angle'], finite(f['angle'], `entity ${id} light.angle`)) }),
      entity: id,
    });
  }
  return any ? { ambient: base, lights } : null;
}

/** Strength of one light at a world point (0..intensity), before its color. */
export function lightFalloff(light: Light2d, x: number, y: number): number {
  const dx = x - light.x;
  const dy = y - light.y;
  const d = Math.hypot(dx, dy);
  if (light.radius <= 0 || d >= light.radius) return 0;
  if (light.kind === 'spot' && d > 0) {
    const toward = (Math.atan2(dy, dx) * 180) / Math.PI;
    const off = Math.abs(((toward - light.direction + 540) % 360) - 180);
    if (off > light.cone / 2) return 0;
    const inner = light.inner;
    if (inner !== undefined && off > inner / 2) {
      const f = 1 - d / light.radius;
      const edge = 1 - (off - inner / 2) / Math.max(1e-6, (light.cone - inner) / 2);
      return f * f * light.intensity * edge * edge * (3 - 2 * edge);
    }
  }
  const f = 1 - d / light.radius;
  return f * f * light.intensity;
}

/** The light map at a world point: ambient plus every light, per channel, clamped to 1. */
export function lightAt(lighting: Lighting2d, x: number, y: number): [number, number, number] {
  const out: [number, number, number] = [lighting.ambient[0], lighting.ambient[1], lighting.ambient[2]];
  for (const light of lighting.lights) {
    const s = lightFalloff(light, x, y);
    for (let k = 0; k < 3; k++) out[k] = out[k]! + light.color[k]! * s;
  }
  return [Math.min(1, out[0]), Math.min(1, out[1]), Math.min(1, out[2])];
}
