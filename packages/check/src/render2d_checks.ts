/**
 * 2D shapes (sdk `Shape`) — the errors render2d raises when it draws them, found before the
 * game runs:
 *
 *   polygon   fewer than 3 `points` (PP3608)
 *   ring      `thickness` 0: the band draws nothing (PP3608)
 *
 * A placement is judged with its prefab's shape fields merged under its own, and reported
 * where it wrote the shape.
 */

import type { JsonObject, Origin } from '@parallax/runtime/resource';
import type { CheckContext } from './context.js';
import { pointerTo } from './values.js';

function check(ctx: CheckContext, shape: JsonObject, at: Origin): void {
  const kind = shape['kind'];
  if (kind === 'polygon') {
    const points = shape['points'];
    const count = Array.isArray(points) ? points.length : 0;
    if (count < 3) {
      ctx.report('PP3608', `A "polygon" shape needs at least 3 points, got ${count}`, {
        path: at.path, pointer: pointerTo(at.pointer, 'points'),
        fix: 'Give the corners in order: "points": [[-1, 0], [1, 0], [0, 2]] (local meters, scaled by size).',
      });
    }
  } else if (kind === 'ring' && typeof shape['thickness'] === 'number' && !(shape['thickness'] > 0)) {
    ctx.report('PP3608', `A "ring" shape has thickness ${shape['thickness']}, so it draws nothing`, {
      path: at.path, pointer: pointerTo(at.pointer, 'thickness'),
      fix: 'Give the band a width in meters ("thickness": 0.1), or use "circle" for a filled disc.',
    });
  }
}

export function checkShapes2d(ctx: CheckContext): void {
  for (const prefab of ctx.project.prefabs.values()) {
    const shape = prefab.components['shape'];
    if (shape !== undefined) check(ctx, shape, { path: prefab.path, pointer: '/components/shape' });
    prefab.children.forEach((child, i) => {
      const c = child.components['shape'];
      if (c !== undefined) check(ctx, c, { path: prefab.path, pointer: pointerTo(pointerTo(pointerTo('/children', i), 'components'), 'shape') });
    });
  }
  for (const scene of ctx.project.scenes.values()) {
    for (const placement of scene.entities) {
      const own = placement.components['shape'];
      if (own === undefined) continue;
      const base = ctx.project.prefabs.get(placement.prefab)?.components['shape'] ?? {};
      check(ctx, { ...base, ...own }, { path: placement.origin.path, pointer: pointerTo(pointerTo(placement.origin.pointer ?? '', 'components'), 'shape') });
    }
  }
}
