/**
 * Tilemaps (sdk `Tilemap`) — the errors render2d and physics2d raise, found before the game runs:
 *
 *   rows      a character that is not a `tiles` key, nor " " / "." (PP3615)
 *   collide   on a tilemap in a game without physics2d: nothing builds its colliders (PP3617, warning)
 */

import type { JsonObject, Origin } from '@parallax/runtime/resource';
import type { CheckContext } from './context.js';
import { pointerTo } from './values.js';

const EMPTY = ' .';

function check(ctx: CheckContext, tm: JsonObject, at: Origin): void {
  const tiles = typeof tm['tiles'] === 'object' && tm['tiles'] !== null && !Array.isArray(tm['tiles']) ? tm['tiles'] as JsonObject : {};
  const rows = Array.isArray(tm['rows']) ? tm['rows'] : [];
  const missing = new Set<string>();
  rows.forEach((row, i) => {
    if (typeof row !== 'string') return; // the field schema reports it
    for (const ch of row) {
      if (EMPTY.includes(ch) || ch in tiles || missing.has(ch)) continue;
      missing.add(ch);
      ctx.report('PP3615', `tilemap.rows[${i}] uses "${ch}", which is not in tiles`, {
        path: at.path, pointer: pointerTo(pointerTo(at.pointer, 'rows'), i),
        fix: `Add "${ch}" to tiles, or use " " / "." for an empty cell. Tiles: ${Object.keys(tiles).map((k) => `"${k}"`).join(', ') || '(none)'}.`,
      });
    }
  });
  if (tm['collide'] === true && !ctx.plugins.has('physics2d')) {
    ctx.report('PP3617', 'tilemap.collide is on, but the game has no physics2d plugin to build its colliders', {
      severity: 'warning', path: at.path, pointer: pointerTo(at.pointer, 'collide'), fix: 'Add physics2d() to Game(plugins=[...]), or set "collide": false.',
    });
  }
}

export function checkTilemaps(ctx: CheckContext): void {
  for (const prefab of ctx.project.prefabs.values()) {
    const tm = prefab.components['tilemap'];
    if (tm !== undefined) check(ctx, tm, { path: prefab.path, pointer: '/components/tilemap' });
    prefab.children.forEach((child, i) => {
      const c = child.components['tilemap'];
      if (c !== undefined) check(ctx, c, { path: prefab.path, pointer: pointerTo(pointerTo(pointerTo('/children', i), 'components'), 'tilemap') });
    });
  }
  for (const scene of ctx.project.scenes.values()) {
    scene.entities.forEach((placement, i) => {
      const own = (placement as { components?: Record<string, JsonObject> }).components?.['tilemap'];
      if (own !== undefined) check(ctx, own, { path: scene.path, pointer: `/entities/${i}/components/tilemap` });
    });
  }
}
